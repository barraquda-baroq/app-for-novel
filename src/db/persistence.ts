// IndexedDB（Dexie）への保存。ストアの AppData を参照比較して、変わったレコードだけを書き込む。
// 2.x: 書き込んだレコードは同じトランザクションで「送信待ち（_outbox）」に積み、同期の時にクラウドへ送る。
// 送信待ちには、そのレコードを最後にクラウドと揃えた時の内容（base）を控える（3者マージに使う）。
//
// 守ること: 送信待ちに無いレコードは「端末内 = 最後に知ったクラウドの内容」、送信待ちにあれば
// 「base = 最後に知ったクラウドの内容」。どちらの文章も黙って消さない（競合は別の稿・ゴミ箱・文章をつないで残す）。
import Dexie, { type Table } from 'dexie'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'
import { contentEqual, deepEqual, mergeRecordLegacy, mergeRemote, TEXT_TABLES, type MergeResult } from '../sync/merge'

/** 競合した時に、消える側の内容をゴミ箱に控える表（文章を持つもの。タイトルはあらすじ・全体戦略を持つ） */
const COPY_TABLES: ReadonlySet<TableName> = new Set<TableName>([...TEXT_TABLES, 'titles'])

export type AnyRecord = { id: string; updatedAt?: number }

/** 送信待ちの1件。k = `${表名}/${id}` */
export interface OutboxRow {
  k: string
  t: TableName
  id: string
  /** 最後にクラウドと揃えた時の内容（null = その時クラウドに無かった・削除されていた） */
  base: AnyRecord | null
  /** クラウドとの共通の履歴が無い（初めてのログイン・アカウントの切り替え）。クラウドに何かあれば突き合わせてから送る */
  noHistory?: boolean
  /** この端末の内容で必ず上書きする（バックアップからの復元・すべて削除） */
  force?: boolean
  at: number
}

/** 1レコードの変化（record = null は削除） */
export interface Change {
  table: TableName
  id: string
  record: AnyRecord | null
  /** クラウドから: ほかの端末がバックアップからの復元・すべて削除で書いた（その内容を正とする） */
  reset?: boolean
  /** クラウドから: この端末が書いたもの（返事を受け取れなかった書き込みなど） */
  own?: boolean
}

export interface OutboxItem {
  k: string
  table: TableName
  id: string
  base: AnyRecord | null
  noHistory: boolean
  force: boolean
  /** いまの端末内の内容（null = 削除した） */
  local: AnyRecord | null
}

/** 競合をどう残したか（画面で知らせる） */
export interface ConflictNote {
  kind: 'versionCopy' | 'trash' | 'joined'
  table: TableName
  id: string
}

/** 競合の控えの作り方（ストアが用意する） */
export interface ConflictHooks {
  /** この端末の呼び名（文章をつないだ時の印に使う） */
  device: string
  /** 稿の本文が両方で変わっていた時の、この端末の稿の控え（新しい id の稿）を作る */
  versionCopy: (mine: AnyRecord) => AnyRecord
  /** 片方で削除・片方で編集された文章などの控え（ゴミ箱のエントリと中身）を作る。控えない時は空 */
  trashCopy: (table: TableName, record: AnyRecord) => Change[]
  /** 競合を控えた時に呼ぶ（トランザクションの中なので、知らせるのは後で） */
  report?: (note: ConflictNote) => void
}

interface MetaRow {
  key: string
  value: unknown
}

const outboxKey = (table: string, id: string) => `${table}/${id}`
const KNOWN_TABLES = new Set<string>(TABLE_NAMES)

/**
 * 送る順番。ゴミ箱の中身を先に、子（稿など）を親（話・タイトル）より先に送る。大きな削除が何回かに分かれて
 * 届いても、受け取った端末が「親が消えたのに子が残っている」と判断して控えを作らないように。
 */
const SEND_ORDER: TableName[] = [
  'trashRecords',
  'trashEntries',
  'snapshotTexts',
  'versions',
  'settingEntries',
  'memos',
  'ideas',
  'submissions',
  'settingCategories',
  'pieces',
  'chapters',
  'titles',
]
const sendRank = (k: string) => {
  const i = SEND_ORDER.indexOf(k.slice(0, k.indexOf('/')) as TableName)
  return i < 0 ? SEND_ORDER.length : i
}

/** 親の表と、その親を指す項目（親が無ければ見えない子になる） */
const PARENT_OF: Partial<Record<TableName, { table: TableName; field: string }>> = {
  chapters: { table: 'titles', field: 'titleId' },
  pieces: { table: 'titles', field: 'titleId' },
  versions: { table: 'pieces', field: 'pieceId' },
  memos: { table: 'titles', field: 'titleId' },
  settingCategories: { table: 'titles', field: 'titleId' },
  settingEntries: { table: 'settingCategories', field: 'categoryId' },
  submissions: { table: 'titles', field: 'titleId' },
}

/** 親が消えたら、子も消す（子にしか無い文章はゴミ箱に控える） */
const CHILDREN: Partial<Record<TableName, { table: TableName; field: string }[]>> = {
  titles: [
    { table: 'chapters', field: 'titleId' },
    { table: 'pieces', field: 'titleId' },
    { table: 'versions', field: 'titleId' },
    { table: 'memos', field: 'titleId' },
    { table: 'settingCategories', field: 'titleId' },
    { table: 'settingEntries', field: 'titleId' },
    { table: 'submissions', field: 'titleId' },
  ],
  pieces: [{ table: 'versions', field: 'pieceId' }],
  settingCategories: [{ table: 'settingEntries', field: 'categoryId' }],
}

class NovelDB extends Dexie {
  constructor(name: string) {
    super(name)
    const v1Tables = [
      'titles',
      'chapters',
      'pieces',
      'versions',
      'memos',
      'ideas',
      'settingCategories',
      'settingEntries',
      'submissions',
    ]
    this.version(1).stores(Object.fromEntries(v1Tables.map((t) => [t, 'id'])))
    // v2: 応募時の原稿の本文を内容ごとにまとめて保存する表を追加
    this.version(2).stores(Object.fromEntries([...v1Tables, 'snapshotTexts'].map((t) => [t, 'id'])))
    // v3（2.x）: ゴミ箱の表と、同期用の送信待ち（_outbox）・状態（_meta）を追加
    this.version(3).stores({
      ...Object.fromEntries(TABLE_NAMES.map((t) => [t, 'id'])),
      _outbox: 'k',
      _meta: 'key',
    })
  }

  tableOf(name: TableName): Table<AnyRecord, string> {
    return this.table(name)
  }

  get outbox(): Table<OutboxRow, string> {
    return this.table('_outbox')
  }

  get meta(): Table<MetaRow, string> {
    return this.table('_meta')
  }
}

export const DEFAULT_DB_NAME = 'novel-studio'

/** base から mine で変えた項目だけを theirs に重ねる（3者マージ。同じ項目を両方が変えたらこのタブを優先） */
export const mergeRecord = mergeRecordLegacy

/** 保存時に、別のタブ（または同期を受け持つ画面が反映した別の端末の変更）が先に書き換えていたレコードをどう扱ったか */
export interface SaveOutcome {
  /** 別タブの変更とこのタブの変更を項目ごとに合わせて書いたレコード */
  merged: Partial<Record<TableName, AnyRecord[]>>
  /** 別タブで削除されていたので書かなかったレコード */
  dropped: Partial<Record<TableName, string[]>>
  /** 実際に書いた内容（競合の控えなど、このタブが変えていないレコードを含む） */
  written: Change[]
  /** 競合の控えなど、このタブの変更以外に書いたもの（メモリ上のデータにも足す） */
  extra: Change[]
}

export interface RemoteApplyOptions extends ConflictHooks {
  /** 受け取った位置（差分の取得の続きに使う）。undefined なら変えない */
  cursor?: unknown
}

export interface Persistence {
  load(): Promise<AppData>
  /**
   * prev（このタブが最後に保存した内容）から next への差分を書き込む。
   * 保存先のレコードが prev と違っていたら（別タブ・別の端末が書き換えた・prev が修復した表示用の内容）、
   * 同期と同じ規則で合わせる（hooks が無ければ、このタブが変えた項目を重ねるだけ）。書いたレコードは送信待ちに積む。
   */
  save(prev: AppData, next: AppData, hooks?: ConflictHooks): Promise<SaveOutcome>
  /**
   * 全データを置き換える（バックアップの読み込み・すべて削除）。変わったものはすべて「必ず上書き」で送信待ちに積み、
   * 同期の時にクラウドもこの内容に揃える（この端末に無いクラウドのレコードも消す）。
   */
  replaceAll(next: AppData): Promise<void>
  /**
   * クラウドの変更を反映する（送信待ちのレコードは3者マージ）。実際に書いた内容を返す。
   * バックアップからの復元・すべて削除をまだクラウドに当てていない間は何もせずに null を返す。
   */
  applyRemote(changes: Change[], opts: RemoteApplyOptions): Promise<Change[] | null>
  /** 送信待ち（最大 limit 件）と、いまの端末内の内容 */
  readOutbox(limit: number): Promise<OutboxItem[]>
  /** 送った内容を記録する。送った後に端末内で変わっていなければ送信待ちから外す */
  completeUpload(sent: Change[]): Promise<void>
  outboxCount(): Promise<number>
  /** 端末内のすべてのレコードを「クラウドとの共通の履歴が無い」前提で送信待ちにする（初めてのログイン・アカウントの切り替え） */
  markAllDirty(): Promise<void>
  /** 端末内のレコードと送信待ちのキー（`${表名}/${id}`） */
  localKeys(): Promise<Set<string>>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
  close(): void
}

/** 応募計画が使っている応募時の原稿の本文のキー */
function usedTextKeys(submissions: AnyRecord[]): Set<string> {
  const used = new Set<string>()
  for (const s of submissions as { snapshot?: { pieces?: Record<string, { textKey?: string | null }> } | null }[]) {
    for (const p of Object.values(s.snapshot?.pieces ?? {})) if (p?.textKey) used.add(p.textKey)
  }
  return used
}

export function createPersistence(dbName = DEFAULT_DB_NAME): Persistence {
  const db = new NovelDB(dbName)
  const allTables = () => TABLE_NAMES.map((t) => db.tableOf(t))

  /** トランザクションの中で使う書き込みの道具 */
  function writer(at: number, written: Map<string, Change>) {
    const put = async (table: TableName, record: AnyRecord) => {
      await db.tableOf(table).put(record)
      written.set(outboxKey(table, record.id), { table, id: record.id, record })
    }
    const del = async (table: TableName, id: string) => {
      await db.tableOf(table).delete(id)
      written.set(outboxKey(table, id), { table, id, record: null })
    }
    /** この端末で作った・変えたレコードを送信待ちに積む（積まれていなければ、書く前の内容を base にする） */
    const enqueueLocal = async (table: TableName, id: string, before: AnyRecord | null) => {
      const k = outboxKey(table, id)
      if (!(await db.outbox.get(k))) await db.outbox.put({ k, t: table, id, base: before, at })
    }
    const putLocal = async (table: TableName, record: AnyRecord) => {
      const before = (await db.tableOf(table).get(record.id)) ?? null
      await put(table, record)
      await enqueueLocal(table, record.id, before)
    }
    const delLocal = async (table: TableName, id: string) => {
      const before = (await db.tableOf(table).get(id)) ?? null
      if (!before) return
      await del(table, id)
      await enqueueLocal(table, id, before)
    }
    /** 競合の控え（別の稿・ゴミ箱）を書く */
    const keepConflict = async (table: TableName, r: MergeResult, hooks: ConflictHooks, id: string) => {
      if (r.bodyConflict) {
        const copy = hooks.versionCopy(r.bodyConflict) as AnyRecord & { pieceId?: string }
        await putLocal('versions', copy)
        const piece = copy.pieceId ? await db.tableOf('pieces').get(copy.pieceId) : undefined
        const ids = (piece as { versionIds?: string[] } | undefined)?.versionIds
        if (piece && Array.isArray(ids) && !ids.includes(copy.id)) {
          await putLocal('pieces', { ...piece, versionIds: [...ids, copy.id], updatedAt: at } as AnyRecord)
        }
        hooks.report?.({ kind: 'versionCopy', table, id })
      }
      for (const kept of [r.deletedEdit, r.keptCopy]) {
        if (!kept || !COPY_TABLES.has(table)) continue
        await keepInTrash(table, kept, hooks, id)
      }
      if (r.joined?.length) hooks.report?.({ kind: 'joined', table, id })
    }
    const keepInTrash = async (table: TableName, record: AnyRecord, hooks: ConflictHooks, id: string) => {
      const extras = hooks.trashCopy(table, record)
      for (const extra of extras) if (extra.record) await putLocal(extra.table, extra.record)
      if (extras.length) hooks.report?.({ kind: 'trash', table, id })
    }
    /**
     * 消えた親（タイトル・話・設定項目）の子を片付ける。別の端末で親が消された時に、この端末で作った・変えた子が
     * 誰にも見えないまま残らないように、文章はゴミ箱に控えて（同じ内容がゴミ箱にあれば控えない）から消す。
     */
    const sweepOrphans = async (
      parents: Map<TableName, Set<string>>,
      hooks: ConflictHooks,
      resetQuiet: ReadonlySet<string> = new Set(),
    ) => {
      let resetParents = resetQuiet
      const pending = new Map(parents)
      let trash: AnyRecord[] | null = null
      const inTrash = async (table: TableName, rec: AnyRecord) => {
        trash ??= await db.tableOf('trashRecords').toArray()
        return trash.some((t) => {
          const tr = t as unknown as { table?: string; record?: AnyRecord }
          return tr.table === table && tr.record?.id === rec.id && contentEqual(tr.record, rec)
        })
      }
      while (pending.size) {
        const [parentTable, ids] = pending.entries().next().value as [TableName, Set<string>]
        pending.delete(parentTable)
        for (const { table, field } of CHILDREN[parentTable] ?? []) {
          const children = await db
            .tableOf(table)
            .filter((r) => ids.has((r as unknown as Record<string, string>)[field]))
            .toArray()
          for (const child of children) {
            const parentId = (child as unknown as Record<string, string>)[field]
            const quiet = resetParents.has(outboxKey(parentTable, parentId))
            if (!quiet && TEXT_TABLES.has(table) && !(await inTrash(table, child)))
              await keepInTrash(table, child, hooks, child.id)
            await delLocal(table, child.id)
            if (CHILDREN[table]) {
              const set = pending.get(table) ?? new Set<string>()
              set.add(child.id)
              pending.set(table, set)
              if (quiet) resetParents = new Set([...resetParents, outboxKey(table, child.id)])
            }
          }
        }
      }
    }
    return { put, del, enqueueLocal, putLocal, delLocal, keepConflict, keepInTrash, sweepOrphans }
  }

  const noteDeleted = (parents: Map<TableName, Set<string>>, table: TableName, id: string) => {
    if (!CHILDREN[table]) return
    const set = parents.get(table) ?? new Set<string>()
    set.add(id)
    parents.set(table, set)
  }

  return {
    async load() {
      const data = emptyData()
      await db.transaction('r', allTables(), async () => {
        for (const t of TABLE_NAMES) {
          const rows = await db.tableOf(t).toArray()
          const map: Record<string, AnyRecord> = {}
          for (const r of rows) map[r.id] = r
          ;(data as unknown as Record<TableName, Record<string, AnyRecord>>)[t] = map
        }
      })
      return data
    },

    async save(prev, next, hooks) {
      const work: { table: TableName; puts: AnyRecord[]; dels: string[] }[] = []
      for (const t of TABLE_NAMES) {
        const a = prev[t] as Record<string, AnyRecord>
        const b = next[t] as Record<string, AnyRecord>
        if (a === b) continue
        const puts: AnyRecord[] = []
        const dels: string[] = []
        for (const id in b) if (a[id] !== b[id]) puts.push(b[id])
        for (const id in a) if (!(id in b)) dels.push(id)
        if (puts.length || dels.length) work.push({ table: t, puts, dels })
      }
      const outcome: SaveOutcome = { merged: {}, dropped: {}, written: [], extra: [] }
      if (work.length === 0) return outcome
      const at = Date.now()
      const extraWritten = new Map<string, Change>()
      const w = writer(at, extraWritten)
      const parents = new Map<TableName, Set<string>>()
      // 競合の控えは別の表（稿・話・ゴミ箱）にも書くので、控えを作れる時はすべての表を開く
      const scope = hooks ? [...allTables(), db.outbox] : [...work.map((x) => db.tableOf(x.table)), db.outbox]
      await db.transaction('rw', scope, async () => {
        for (const job of work) {
          const table = db.tableOf(job.table)
          const base = prev[job.table] as Record<string, AnyRecord>
          const ids = [...job.puts.map((r) => r.id), ...job.dels]
          const onDisk = await table.bulkGet(ids)
          const queued = await db.outbox.bulkGet(ids.map((id) => outboxKey(job.table, id)))
          const toWrite: AnyRecord[] = []
          const toDelete: string[] = []
          const enqueue: OutboxRow[] = []
          const track = (i: number, id: string, disk: AnyRecord | undefined) => {
            if (!queued[i]) enqueue.push({ k: outboxKey(job.table, id), t: job.table, id, base: disk ?? null, at })
          }
          const afterWrite: (() => Promise<void>)[] = []
          for (let i = 0; i < job.puts.length; i++) {
            const mine = job.puts[i]
            const before = base[mine.id]
            const disk = onDisk[i]
            if (before && !disk) {
              // 別タブ・別の端末で削除されていた: 復活させない。このタブで書き換えた文章はゴミ箱に控える
              ;(outcome.dropped[job.table] ??= []).push(mine.id)
              if (hooks && TEXT_TABLES.has(job.table) && !contentEqual(mine, before)) {
                const h = hooks
                afterWrite.push(() => w.keepInTrash(job.table, mine, h, mine.id))
              }
              noteDeleted(parents, job.table, mine.id)
              continue
            }
            let record = mine
            if (before && disk && !deepEqual(disk, before)) {
              // 保存先が prev と違う: 同期と同じ規則で、このタブが変えた項目を重ねる（本文が両方で変わっていれば、
              // 保存先の本文を採り、このタブの本文を別の稿として残す）
              if (hooks) {
                const r = mergeRemote(job.table, before, mine, disk, { device: hooks.device })
                record = r.record ?? mine
                const h = hooks
                afterWrite.push(() => w.keepConflict(job.table, r, h, mine.id))
              } else {
                record = mergeRecordLegacy(before, mine, disk, job.table)
              }
              ;(outcome.merged[job.table] ??= []).push(record)
            }
            toWrite.push(record)
            outcome.written.push({ table: job.table, id: record.id, record })
            track(i, mine.id, disk)
          }
          job.dels.forEach((id, j) => {
            const i = job.puts.length + j
            const disk = onDisk[i]
            if (!disk) return
            const before = base[id]
            // 削除する前に別タブ・別の端末で書き換えられていた文章はゴミ箱に控える
            if (hooks && before && TEXT_TABLES.has(job.table) && !contentEqual(disk, before)) {
              const h = hooks
              afterWrite.push(() => w.keepInTrash(job.table, disk, h, id))
            }
            toDelete.push(id)
            outcome.written.push({ table: job.table, id, record: null })
            track(i, id, disk)
          })
          if (toWrite.length) await table.bulkPut(toWrite)
          if (toDelete.length) await table.bulkDelete(toDelete)
          if (enqueue.length) await db.outbox.bulkPut(enqueue)
          for (const fn of afterWrite) await fn()
        }
        if (hooks) {
          // 別の端末で消された親の下に、このタブが新しく作ったもの（古い表示のまま作った）は、文章を控えて片付ける
          for (const job of work) {
            const parent = PARENT_OF[job.table]
            if (!parent) continue
            for (const rec of job.puts) {
              if (prev[job.table][rec.id as never]) continue
              const parentId = (rec as unknown as Record<string, string>)[parent.field]
              if (!parentId || (await db.tableOf(parent.table).get(parentId))) continue
              const set = parents.get(parent.table) ?? new Set<string>()
              set.add(parentId)
              parents.set(parent.table, set)
            }
          }
          if (parents.size) await w.sweepOrphans(parents, hooks)
        }
      })
      if (extraWritten.size) {
        outcome.extra = [...extraWritten.values()]
        outcome.written.push(...outcome.extra)
      }
      return outcome
    },

    async replaceAll(next) {
      const at = Date.now()
      await db.transaction('rw', [...allTables(), db.outbox, db.meta], async () => {
        // 同期したことのある端末だけ、クラウドもこの内容に揃える（まだ同期したことの無い端末で復元してから
        // 初めてログインした時は、ほかの端末の内容と突き合わせるだけにする）
        const synced = Boolean((await db.meta.get('uid'))?.value)
        for (const t of TABLE_NAMES) {
          const table = db.tableOf(t)
          const old = new Map((await table.toArray()).map((r) => [r.id, r]))
          const rows = Object.values(next[t] as Record<string, AnyRecord>)
          await table.clear()
          if (rows.length) await table.bulkPut(rows)
          const ids = new Set([...old.keys(), ...rows.map((r) => r.id)])
          const queued = await db.outbox.bulkGet([...ids].map((id) => outboxKey(t, id)))
          const enqueue: OutboxRow[] = [...ids].map((id, i) => {
            const row: OutboxRow = { k: outboxKey(t, id), t, id, base: queued[i]?.base ?? old.get(id) ?? null, at }
            if (synced) row.force = true
            else if (queued[i]?.noHistory) row.noHistory = true
            return row
          })
          if (enqueue.length) await db.outbox.bulkPut(enqueue)
        }
        // 同期の時に、この端末に無いクラウドのレコードも消す
        if (synced) await db.meta.put({ key: 'authoritative', value: at })
      })
    },

    async applyRemote(changes, opts) {
      const written = new Map<string, Change>()
      const at = Date.now()
      const w = writer(at, written)
      const parents = new Map<TableName, Set<string>>()
      /** 復元・すべて削除で消えた親（子は控えずに片付ける。子にも削除が届く） */
      const resetParents = new Set(changes.filter((c) => c.reset && !c.record).map((c) => outboxKey(c.table, c.id)))
      let deferred = false
      await db.transaction('rw', [...allTables(), db.outbox, db.meta], async () => {
        if ((await db.meta.get('authoritative'))?.value) {
          deferred = true
          return
        }
        /** 応募時の原稿の本文の削除は、ほかの変更を当てた後で、使われていないことを確かめてから当てる */
        const textTombstones: Change[] = []
        for (const ch of changes) {
          if (!KNOWN_TABLES.has(ch.table)) continue
          const k = outboxKey(ch.table, ch.id)
          const disk = (await db.tableOf(ch.table).get(ch.id)) ?? null
          const queued = await db.outbox.get(k)

          if (ch.table === 'snapshotTexts' && !ch.record && disk) {
            textTombstones.push(ch)
            continue
          }
          // バックアップからの復元・すべて削除の後: この端末の内容で上書きするまで、クラウド側は採らない
          if (queued?.force) {
            await db.outbox.put({ ...queued, base: ch.record })
            continue
          }
          // この端末が書いたもの（返事を受け取れなかった書き込み）: 端末内の内容はそれより新しいので、base だけ進める
          if (ch.own && queued) {
            if (deepEqual(disk, ch.record)) await db.outbox.delete(k)
            else await db.outbox.put({ k, t: ch.table, id: ch.id, base: ch.record, at: queued.at })
            continue
          }
          // ほかの端末の復元・すべて削除: その内容を正とする。この端末で書いたまま送っていない文章だけ控える
          if (ch.reset) {
            if (queued && disk && !deepEqual(disk, queued.base) && COPY_TABLES.has(ch.table) && !contentEqual(disk, ch.record))
              await w.keepInTrash(ch.table, disk, opts, ch.id)
            if (queued) await db.outbox.delete(k)
            if (ch.record) {
              if (!deepEqual(disk, ch.record)) await w.put(ch.table, ch.record)
            } else if (disk) {
              await w.del(ch.table, ch.id)
              noteDeleted(parents, ch.table, ch.id)
            }
            continue
          }
          if (!queued) {
            if (deepEqual(disk, ch.record)) continue
            if (ch.record) await w.put(ch.table, ch.record)
            else if (disk) {
              await w.del(ch.table, ch.id)
              noteDeleted(parents, ch.table, ch.id)
            }
            continue
          }
          const result = mergeRemote(ch.table, queued.base, disk, ch.record, {
            device: opts.device,
            noHistory: queued.noHistory,
          })
          // クラウドと同じ内容になったら、クラウドの内容そのものを使う（更新日時まで揃える）
          if (contentEqual(result.record, ch.record)) result.record = ch.record
          if (!deepEqual(result.record, disk)) {
            if (result.record) await w.put(ch.table, result.record)
            else if (disk) {
              await w.del(ch.table, ch.id)
              noteDeleted(parents, ch.table, ch.id)
            }
          }
          // クラウドの内容が新しい base。合わせた結果がクラウドと同じなら送るものは無い
          if (deepEqual(result.record, ch.record)) await db.outbox.delete(k)
          else await db.outbox.put({ k, t: ch.table, id: ch.id, base: ch.record, at: queued.at })
          await w.keepConflict(ch.table, result, opts, ch.id)
        }
        // 応募時の原稿の本文は、この端末の応募計画がまだ使っている間は消さない（送り直して、ほかの端末にも戻す）
        if (textTombstones.length) {
          const inUse = usedTextKeys(await db.tableOf('submissions').toArray())
          for (const ch of textTombstones) {
            const k = outboxKey(ch.table, ch.id)
            if (inUse.has(ch.id)) {
              const queued = await db.outbox.get(k)
              await db.outbox.put({ k, t: ch.table, id: ch.id, base: null, at: queued?.at ?? at })
            } else {
              await w.del(ch.table, ch.id)
              await db.outbox.delete(k)
            }
          }
        }
        if (parents.size) await w.sweepOrphans(parents, opts, resetParents)
        if (opts.cursor !== undefined) await db.meta.put({ key: 'cursor', value: opts.cursor })
      })
      return deferred ? null : [...written.values()]
    },

    async readOutbox(limit) {
      const keys = (await db.outbox.toCollection().primaryKeys()).map(String)
      keys.sort((a, b) => sendRank(a) - sendRank(b) || (a < b ? -1 : a > b ? 1 : 0))
      const rows = (await db.outbox.bulkGet(keys.slice(0, limit))).filter((r): r is OutboxRow => Boolean(r))
      const byTable = new Map<TableName, OutboxRow[]>()
      for (const r of rows) {
        if (!KNOWN_TABLES.has(r.t)) continue
        const list = byTable.get(r.t) ?? []
        list.push(r)
        byTable.set(r.t, list)
      }
      const out: OutboxItem[] = []
      for (const [t, list] of byTable) {
        const locals = await db.tableOf(t).bulkGet(list.map((r) => r.id))
        list.forEach((r, i) =>
          out.push({
            k: r.k,
            table: t,
            id: r.id,
            base: r.base,
            noHistory: Boolean(r.noHistory),
            force: Boolean(r.force),
            local: locals[i] ?? null,
          }),
        )
      }
      return out
    },

    async completeUpload(sent) {
      if (!sent.length) return
      const tables = [...new Set(sent.map((s) => s.table))]
      await db.transaction('rw', [...tables.map((t) => db.tableOf(t)), db.outbox], async () => {
        for (const s of sent) {
          const k = outboxKey(s.table, s.id)
          const row = await db.outbox.get(k)
          if (!row) continue
          const disk = (await db.tableOf(s.table).get(s.id)) ?? null
          // 送った後にこの端末で変わっていなければ送り終わり。変わっていれば、送った内容を新しい base にして残す
          if (deepEqual(disk, s.record)) await db.outbox.delete(k)
          else await db.outbox.put({ k, t: row.t, id: row.id, base: s.record, at: row.at })
        }
      })
    },

    outboxCount() {
      return db.outbox.count()
    },

    async markAllDirty() {
      const at = Date.now()
      await db.transaction('rw', [...allTables(), db.outbox, db.meta], async () => {
        // 共通の履歴が無いので、以前の「クラウドもこの内容に揃える」はやめて、突き合わせるだけにする
        await db.meta.delete('authoritative')
        await db.outbox.toCollection().modify({ base: null, noHistory: true, force: false })
        for (const t of TABLE_NAMES) {
          const ids = await db.tableOf(t).toCollection().primaryKeys()
          if (ids.length)
            await db.outbox.bulkPut(
              ids.map((key) => ({ k: outboxKey(t, String(key)), t, id: String(key), base: null, noHistory: true, at })),
            )
        }
      })
    },

    async localKeys() {
      const keys = new Set<string>()
      await db.transaction('r', [...allTables(), db.outbox], async () => {
        for (const t of TABLE_NAMES) {
          for (const id of await db.tableOf(t).toCollection().primaryKeys()) keys.add(outboxKey(t, String(id)))
        }
        for (const k of await db.outbox.toCollection().primaryKeys()) keys.add(String(k))
      })
      return keys
    },

    async getMeta<T>(key: string) {
      return (await db.meta.get(key))?.value as T | undefined
    },

    async setMeta(key, value) {
      await db.meta.put({ key, value })
    },

    close() {
      db.close()
    },
  }
}
