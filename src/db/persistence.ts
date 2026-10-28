// IndexedDB（Dexie）への保存。ストアの AppData を参照比較して、変わったレコードだけを書き込む。
// 2.x: 書き込んだレコードは同じトランザクションで「送信待ち（_outbox）」に積み、同期の時にクラウドへ送る。
// 送信待ちには、そのレコードを最後にクラウドと揃えた時の内容（base）を控える（3者マージに使う）。
import Dexie, { type Table } from 'dexie'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'
import { contentEqual, deepEqual, mergeFields, mergeRemote, TEXT_TABLES } from '../sync/merge'

export type AnyRecord = { id: string; updatedAt?: number }

/** 送信待ちの1件。k = `${表名}/${id}` */
export interface OutboxRow {
  k: string
  t: TableName
  id: string
  /** 最後にクラウドと揃えた時の内容（null = その時クラウドに無かった） */
  base: AnyRecord | null
  at: number
}

/** 1レコードの変化（record = null は削除） */
export interface Change {
  table: TableName
  id: string
  record: AnyRecord | null
}

export interface OutboxItem {
  k: string
  table: TableName
  id: string
  base: AnyRecord | null
  /** いまの端末内の内容（null = 削除した） */
  local: AnyRecord | null
}

interface MetaRow {
  key: string
  value: unknown
}

const outboxKey = (table: string, id: string) => `${table}/${id}`
const KNOWN_TABLES = new Set<string>(TABLE_NAMES)

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
export function mergeRecord(base: AnyRecord, mine: AnyRecord, theirs: AnyRecord, table?: TableName): AnyRecord {
  if (table) return mergeFields(table, base, mine, theirs, { body: 'mine' }).record
  const out: Record<string, unknown> = { ...theirs }
  const b = base as Record<string, unknown>
  const m = mine as Record<string, unknown>
  for (const key of Object.keys(m)) {
    if (key === 'updatedAt') continue
    if (!deepEqual(m[key], b[key])) out[key] = m[key]
  }
  out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return out as AnyRecord
}

/** 保存時に、別のタブが先に書き換えていたレコードをどう扱ったか */
export interface SaveOutcome {
  /** 別タブの変更とこのタブの変更を項目ごとに合わせて書いたレコード */
  merged: Partial<Record<TableName, AnyRecord[]>>
  /** 別タブで削除されていたので書かなかったレコード */
  dropped: Partial<Record<TableName, string[]>>
  /** 実際に書いた内容 */
  written: Change[]
}

export interface RemoteApplyOptions {
  /** 受け取った位置（差分の取得の続きに使う）。undefined なら変えない */
  cursor?: unknown
  /** 稿の本文が両方で変わっていた時の、この端末の稿の控え（新しい id の稿）を作る */
  versionCopy: (mine: AnyRecord) => AnyRecord
  /** 片方で削除・片方で編集された文章の控え（ゴミ箱のエントリと中身）を作る。控えない時は空 */
  trashCopy: (table: TableName, record: AnyRecord) => Change[]
}

export interface Persistence {
  load(): Promise<AppData>
  /**
   * prev（このタブが最後に保存した内容）から next への差分を書き込む。
   * 保存先のレコードが prev と違っていたら（別タブが書き換えた・prev が修復した表示用の内容）、
   * このタブが変えた項目だけを重ねて書く。書いたレコードは送信待ちに積む。
   */
  save(prev: AppData, next: AppData): Promise<SaveOutcome>
  /** 全データを置き換える（バックアップの読み込み用）。変わったものはすべて送信待ちに積む */
  replaceAll(next: AppData): Promise<void>
  /** クラウドの変更を反映する（送信待ちのレコードは3者マージ）。実際に書いた内容を返す */
  applyRemote(changes: Change[], opts: RemoteApplyOptions): Promise<Change[]>
  /** 送信待ち（最大 limit 件）と、いまの端末内の内容 */
  readOutbox(limit: number): Promise<OutboxItem[]>
  /** 送った内容を記録する。送った後に端末内で変わっていなければ送信待ちから外す */
  completeUpload(sent: Change[]): Promise<void>
  outboxCount(): Promise<number>
  /** 端末内のすべてのレコードを「クラウドに無い」前提で送信待ちにする（初めてログインした時） */
  markAllDirty(): Promise<void>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
  close(): void
}

export function createPersistence(dbName = DEFAULT_DB_NAME): Persistence {
  const db = new NovelDB(dbName)
  const allTables = () => TABLE_NAMES.map((t) => db.tableOf(t))

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

    async save(prev, next) {
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
      const outcome: SaveOutcome = { merged: {}, dropped: {}, written: [] }
      if (work.length === 0) return outcome
      const at = Date.now()
      await db.transaction('rw', [...work.map((w) => db.tableOf(w.table)), db.outbox], async () => {
        for (const w of work) {
          const table = db.tableOf(w.table)
          const base = prev[w.table] as Record<string, AnyRecord>
          const ids = [...w.puts.map((r) => r.id), ...w.dels]
          const onDisk = await table.bulkGet(ids)
          const queued = await db.outbox.bulkGet(ids.map((id) => outboxKey(w.table, id)))
          const toWrite: AnyRecord[] = []
          const toDelete: string[] = []
          const enqueue: OutboxRow[] = []
          const track = (i: number, id: string, disk: AnyRecord | undefined) => {
            if (!queued[i]) enqueue.push({ k: outboxKey(w.table, id), t: w.table, id, base: disk ?? null, at })
          }
          w.puts.forEach((mine, i) => {
            const before = base[mine.id]
            const disk = onDisk[i]
            if (before && !disk) {
              // 別タブで削除されていた: 復活させない
              ;(outcome.dropped[w.table] ??= []).push(mine.id)
              return
            }
            let record = mine
            if (before && disk && !deepEqual(disk, before)) {
              // 保存先が prev と違う: このタブが変えた項目だけを重ねる
              record = mergeRecord(before, mine, disk, w.table)
              ;(outcome.merged[w.table] ??= []).push(record)
            }
            toWrite.push(record)
            outcome.written.push({ table: w.table, id: record.id, record })
            track(i, mine.id, disk)
          })
          w.dels.forEach((id, j) => {
            const i = w.puts.length + j
            const disk = onDisk[i]
            if (!disk) return
            toDelete.push(id)
            outcome.written.push({ table: w.table, id, record: null })
            track(i, id, disk)
          })
          if (toWrite.length) await table.bulkPut(toWrite)
          if (toDelete.length) await table.bulkDelete(toDelete)
          if (enqueue.length) await db.outbox.bulkPut(enqueue)
        }
      })
      return outcome
    },

    async replaceAll(next) {
      const at = Date.now()
      await db.transaction('rw', [...allTables(), db.outbox], async () => {
        const queued = new Set(await db.outbox.toCollection().primaryKeys())
        for (const t of TABLE_NAMES) {
          const table = db.tableOf(t)
          const old = new Map((await table.toArray()).map((r) => [r.id, r]))
          const rows = Object.values(next[t] as Record<string, AnyRecord>)
          await table.clear()
          if (rows.length) await table.bulkPut(rows)
          const enqueue: OutboxRow[] = []
          const ids = new Set([...old.keys(), ...rows.map((r) => r.id)])
          for (const id of ids) {
            const k = outboxKey(t, id)
            if (!queued.has(k)) enqueue.push({ k, t, id, base: old.get(id) ?? null, at })
          }
          if (enqueue.length) await db.outbox.bulkPut(enqueue)
        }
      })
    },

    async applyRemote(changes, opts) {
      const written = new Map<string, Change>()
      const at = Date.now()
      await db.transaction('rw', [...allTables(), db.outbox, db.meta], async () => {
        const put = async (table: TableName, record: AnyRecord) => {
          await db.tableOf(table).put(record)
          written.set(outboxKey(table, record.id), { table, id: record.id, record })
        }
        const del = async (table: TableName, id: string) => {
          await db.tableOf(table).delete(id)
          written.set(outboxKey(table, id), { table, id, record: null })
        }
        /** この端末で作った・変えたレコードを送信待ちに積む（積まれていなければ、いまの内容を base にする） */
        const enqueueLocal = async (table: TableName, id: string, before: AnyRecord | null) => {
          const k = outboxKey(table, id)
          if (!(await db.outbox.get(k))) await db.outbox.put({ k, t: table, id, base: before, at })
        }
        const putLocal = async (table: TableName, record: AnyRecord) => {
          const before = (await db.tableOf(table).get(record.id)) ?? null
          await put(table, record)
          await enqueueLocal(table, record.id, before)
        }

        for (const ch of changes) {
          if (!KNOWN_TABLES.has(ch.table)) continue
          const k = outboxKey(ch.table, ch.id)
          const disk = (await db.tableOf(ch.table).get(ch.id)) ?? null
          const queued = await db.outbox.get(k)
          if (!queued) {
            if (deepEqual(disk, ch.record)) continue
            if (ch.record) await put(ch.table, ch.record)
            else if (disk) await del(ch.table, ch.id)
            continue
          }
          const result = mergeRemote(ch.table, queued.base, disk, ch.record)
          if (!deepEqual(result.record, disk)) {
            if (result.record) await put(ch.table, result.record)
            else if (disk) await del(ch.table, ch.id)
          }
          // クラウドの内容が新しい base。合わせた結果がクラウドと同じなら送るものは無い
          if (contentEqual(result.record, ch.record)) await db.outbox.delete(k)
          else await db.outbox.put({ ...queued, base: ch.record })

          if (result.bodyConflict) {
            const copy = opts.versionCopy(result.bodyConflict) as AnyRecord & { pieceId?: string }
            await putLocal('versions', copy)
            const piece = copy.pieceId ? await db.tableOf('pieces').get(copy.pieceId) : undefined
            const ids = (piece as { versionIds?: string[] } | undefined)?.versionIds
            if (piece && Array.isArray(ids) && !ids.includes(copy.id)) {
              await putLocal('pieces', { ...piece, versionIds: [...ids, copy.id], updatedAt: at } as AnyRecord)
            }
          }
          if (result.deletedEdit && TEXT_TABLES.has(ch.table)) {
            for (const extra of opts.trashCopy(ch.table, result.deletedEdit)) {
              if (extra.record) await putLocal(extra.table, extra.record)
            }
          }
        }
        if (opts.cursor !== undefined) await db.meta.put({ key: 'cursor', value: opts.cursor })
      })
      return [...written.values()]
    },

    async readOutbox(limit) {
      const rows = await db.outbox.limit(limit).toArray()
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
        list.forEach((r, i) => out.push({ k: r.k, table: t, id: r.id, base: r.base, local: locals[i] ?? null }))
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
          else await db.outbox.put({ ...row, base: s.record })
        }
      })
    },

    outboxCount() {
      return db.outbox.count()
    },

    async markAllDirty() {
      const at = Date.now()
      await db.transaction('rw', [...allTables(), db.outbox], async () => {
        await db.outbox.toCollection().modify({ base: null })
        for (const t of TABLE_NAMES) {
          const ids = await db.tableOf(t).toCollection().primaryKeys()
          if (ids.length)
            await db.outbox.bulkPut(ids.map((key) => ({ k: outboxKey(t, String(key)), t, id: String(key), base: null, at })))
        }
      })
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
