// IndexedDB（Dexie）への保存。ストアの AppData を参照比較して、変わったレコードだけを書き込む。
// 2.x: 書き込んだレコードは同じトランザクションで「送信待ち（_outbox）」に積み、同期の時にクラウドへ送る。
// 送信待ちには、そのレコードを最後にクラウドと揃えた時の内容（base）を控える（3者マージに使う）。
//
// 守ること: 送信待ちに無いレコードは「端末内 = 最後に知ったクラウドの内容」、送信待ちにあれば
// 「base = 最後に知ったクラウドの内容」。どちらの文章も黙って消さない（競合は別の稿・ゴミ箱・文章をつないで残す）。
import Dexie, { type Table } from 'dexie'
import { textHash } from '../domain/text'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'
import {
  actIdsOf,
  actsVerdict,
  chooseTarget,
  familyText,
  groupOutbox,
  isActRecord,
  isDirtyEpisodeRow,
  isEpisodeRecord,
  isRedundant,
  parentIdOf,
  resolveActsPieces,
  sameIds,
  type ActsResolution,
  type ActsVerdict,
} from '../sync/acts'
import {
  contentEqual,
  deepEqual,
  mergeRecordLegacy,
  mergeRemote,
  TEXT_TABLES,
  type MergeOptions,
  type MergeResult,
} from '../sync/merge'

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
  /**
   * 幕のまとまり（幕に分けた・つないだ・解除した話と、その幕・稿・この操作で作ったゴミ箱の件）。
   * 同じまとまりは1つのトランザクションで、全部を書けるか、1つも書かない（src/sync/batch.ts）
   */
  group?: string
}

/**
 * 幕（2.2）の構成が別の端末と重なった時の知らせの種類。
 * - lost: 両方で幕の構成を変えていて、別の端末の構成に合わせた（この端末の幕の操作を取り消した）
 * - won: 両方で幕の構成を変えていて、この端末のセパレート解除を優先した
 * - deletedHere / deletedThere: この端末で・別の端末で削除した話の下に、もう一方の端末が幕を作っていた
 * - mineDropped / theirsDropped: 片方の端末の幕の操作で、もう一方（この端末・別の端末）の編集・採用が採用原稿に入らなかった
 * - stale: 別の端末で、書き換える前の稿から分けられた・つながれた（この端末の書き換えが採用原稿に入っていない）
 * - source: この端末で分けた話の、分ける前の採用稿が別の端末で書き換えられていた
 */
export type ActsNoteDetail =
  | 'lost'
  | 'won'
  | 'deletedHere'
  | 'deletedThere'
  | 'mineDropped'
  | 'theirsDropped'
  | 'stale'
  | 'source'

/** 競合をどう残したか（画面で知らせる） */
export type ConflictNote =
  | {
      kind: 'versionCopy' | 'trash' | 'joined'
      table: TableName
      id: string
    }
  | {
      /** 幕（2.2）: 話（id）の幕の構成が別の端末と重なった */
      kind: 'acts'
      table: 'pieces'
      id: string
      detail: ActsNoteDetail
      /** 残した稿の数（稿の一覧に残した・ゴミ箱に入れた） */
      kept?: { versions: number; trash: number }
    }

/** 幕の構成の競合で残す稿の控え方 */
export interface ActsCopyInfo {
  /** 稿が何幕目の稿だったか（別の幕・話へ移す時の名前に使う。分からなければ null） */
  actNumber: number | null
  /** edit = 書き換えた・採用した稿、acts = 幕の操作で作った稿 */
  reason: 'edit' | 'acts'
  /** この端末で書いた・作った稿 */
  mine: boolean
}

/** 競合の控えの作り方（ストアが用意する） */
export interface ConflictHooks {
  /** この端末の呼び名（文章をつないだ時の印に使う） */
  device: string
  /** 稿の本文が両方で変わっていた時の、この端末の稿の控え（新しい id の稿）を作る */
  versionCopy: (mine: AnyRecord) => AnyRecord
  /**
   * 片方で削除・片方で編集された文章などの控え（ゴミ箱のエントリと中身）を作る。控えない時は空。
   * ctx.piece は稿の話・幕（端末内から消えている時の内容。幕なら、戻せるように属する話も控える）
   */
  trashCopy: (table: TableName, record: AnyRecord, ctx?: { piece?: AnyRecord | null }) => Change[]
  /**
   * 幕の構成の競合で残す稿を、残し先（target）の稿にする。target が稿の幕そのものなら同じ id のまま名前を変え、
   * 別の幕・話なら新しい id の写しを作る（無ければ trashCopy でゴミ箱に残す）
   */
  actsCopy?: (version: AnyRecord, target: AnyRecord, info: ActsCopyInfo) => AnyRecord
  /**
   * 幕の構成の競合で残す稿（採用原稿に入っている稿・削除された話の幕の稿）を、ゴミ箱の1件にまとめる
   * （無ければ trashCopy で1件ずつ）
   */
  actsTrash?: (
    items: { record: AnyRecord; actNumber: number | null }[],
    info: { episodeId: string; episode: AnyRecord | null; target: AnyRecord | null; deleted: boolean },
  ) => Change[]
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
/** 送る順番の中の表の位置（子の表ほど前。知らない表は最後） */
export function tableSendRank(table: string): number {
  const i = SEND_ORDER.indexOf(table as TableName)
  return i < 0 ? SEND_ORDER.length : i
}
const sendRank = (k: string) => tableSendRank(k.slice(0, k.indexOf('/')))

/** 親の表と、その親を指す項目（親が無ければ見えない子になる。項目が無いレコードは確かめない） */
const PARENT_OF: Partial<Record<TableName, { table: TableName; field: string }[]>> = {
  chapters: [{ table: 'titles', field: 'titleId' }],
  pieces: [
    { table: 'titles', field: 'titleId' },
    { table: 'pieces', field: 'parentId' },
  ],
  versions: [{ table: 'pieces', field: 'pieceId' }],
  memos: [{ table: 'titles', field: 'titleId' }],
  settingCategories: [{ table: 'titles', field: 'titleId' }],
  settingEntries: [{ table: 'settingCategories', field: 'categoryId' }],
  submissions: [{ table: 'titles', field: 'titleId' }],
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
  pieces: [
    { table: 'versions', field: 'pieceId' },
    // 幕（kind 'act'）は、幕に分けた話（parentId）の子
    { table: 'pieces', field: 'parentId' },
  ],
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
  /**
   * 購読で届いたのではなく、書けなかったものだけをクラウドから直接読んだ（pullDirectly）。
   * 1回の書き込みの一部だけのことがあるので、幕の並びが知らない幕を指していれば、その話は合わせずに購読で届くのを待つ
   */
  direct?: boolean
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

type PieceRec = AnyRecord & {
  kind?: string
  parentId?: string
  titleId?: string
  actIds?: string[]
  versionIds?: string[]
  activeVersionId?: string | null
  versionSeq?: number
}
type VersionRec = AnyRecord & {
  pieceId?: string
  body?: string
  note?: string
  name?: string
  sourceHash?: unknown
  sourceVersionId?: unknown
}

/** 幕（2.2）: 反映の時の、1つの話（第n話）の幕の構成のまとまり */
interface ActsUnit {
  episodeId: string
  /** conflict = 両方で幕の構成が変わった、theirs / mine = 別の端末・この端末だけが変えた、none = どちらも変えていない・同じに変えた */
  kind: 'conflict' | 'theirs' | 'mine' | 'none'
  /**
   * 両方の端末が幕の並びを base から同じに変えた（同じ操作をした。kind は none）。話・幕の採用稿はクラウド（先に送った端末）に
   * 合わせる（項目ごとに合わせると、この端末の採用稿が勝って、先に送った端末の操作の後の書き換えが採用原稿から抜けるため）
   */
  same: boolean
  /** 幕の並び: base・この端末（反映する前）・クラウド */
  B: string[]
  M: string[]
  T: string[]
  noHistory: boolean
  /** conflict の時に採る側 */
  verdict: ActsVerdict | null
  /** conflict の時に合わせる幕（話は含まない） */
  members: Set<string>
  resolution?: ActsResolution
}

/** 幕・話の稿の控え（反映の最後に、残る幕・話の稿かゴミ箱に残す） */
interface Keep {
  record: AnyRecord
  episodeId: string
  /** 稿の元の話・幕 */
  pieceId: string
  /** この端末で書いた・作った稿 */
  mine: boolean
  /** edit = 書き換えた・採用した稿（いつも見える稿として残す）、acts = 幕の操作で作った稿 */
  reason: 'edit' | 'acts'
  /** 端末内に残っている稿（同じ幕・話に名前を変えて残すか、移す） */
  live: boolean
  /** 知らせの種類（無ければ、まとまりと mine から決める） */
  detail?: ActsNoteDetail
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
    /** この反映・保存で消した話・幕（消す前の内容。消えた幕の稿を控える時に、幕の属する話を知るため） */
    const gone = new Map<string, AnyRecord>()
    const put = async (table: TableName, record: AnyRecord) => {
      await db.tableOf(table).put(record)
      written.set(outboxKey(table, record.id), { table, id: record.id, record })
    }
    const del = async (table: TableName, id: string, before?: AnyRecord | null) => {
      if (table === 'pieces') {
        const prev = before === undefined ? await db.tableOf(table).get(id) : before
        if (prev) gone.set(id, prev)
      }
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
      await del(table, id, before)
      await enqueueLocal(table, id, before)
    }
    /** 稿を話・幕の稿の一覧の末尾に足す（もう載っていれば何もしない） */
    const listVersion = async (pieceId: string, versionId: string) => {
      const piece = (await db.tableOf('pieces').get(pieceId)) as (AnyRecord & { versionIds?: string[] }) | undefined
      const ids = piece?.versionIds
      if (!piece || !Array.isArray(ids) || ids.includes(versionId)) return
      const versionIds = [...ids, versionId]
      const seq = (piece as { versionSeq?: unknown }).versionSeq
      const versionSeq = Math.max(typeof seq === 'number' ? seq : 1, versionIds.length)
      await putLocal('pieces', { ...piece, versionIds, versionSeq, updatedAt: at } as AnyRecord)
    }
    /**
     * 競合の控え（別の稿・ゴミ箱）を書く。
     * keepVersion を渡すと、片方で削除・片方で編集された稿は、ゴミ箱に入れる代わりにそれに渡す（幕の稿は、反映の最後に
     * 残る幕・話の稿として残す。applyRemote）。listCopy = false なら、本文の競合の控えを稿の一覧に載せない（後で載せる）
     */
    const keepConflict = async (
      table: TableName,
      r: MergeResult,
      hooks: ConflictHooks,
      id: string,
      opts: {
        keepVersion?: (kept: AnyRecord) => Promise<boolean>
        /** ゴミ箱に控える稿の話・幕（端末内から消えている時） */
        pieceOf?: (kept: AnyRecord) => Promise<AnyRecord | null>
        listCopy?: (copy: AnyRecord) => boolean
      } = {},
    ) => {
      if (r.bodyConflict) {
        const copy = hooks.versionCopy(r.bodyConflict) as AnyRecord & { pieceId?: string }
        await putLocal('versions', copy)
        if (copy.pieceId && (opts.listCopy?.(copy) ?? true)) await listVersion(copy.pieceId, copy.id)
        hooks.report?.({ kind: 'versionCopy', table, id })
      }
      for (const kept of [r.deletedEdit, r.keptCopy]) {
        if (!kept || !COPY_TABLES.has(table)) continue
        if (table === 'versions' && opts.keepVersion && (await opts.keepVersion(kept))) continue
        const piece = table === 'versions' && opts.pieceOf ? await opts.pieceOf(kept) : null
        await keepInTrash(table, kept, hooks, id, piece ? { piece } : undefined)
      }
      if (r.joined?.length) hooks.report?.({ kind: 'joined', table, id })
    }
    const keepInTrash = async (
      table: TableName,
      record: AnyRecord,
      hooks: ConflictHooks,
      id: string,
      ctx?: { piece?: AnyRecord | null },
    ) => {
      const extras = hooks.trashCopy(table, record, ctx)
      for (const extra of extras) if (extra.record) await putLocal(extra.table, extra.record)
      if (extras.length) hooks.report?.({ kind: 'trash', table, id })
    }
    /**
     * 消えた親（タイトル・話・設定項目）の子を片付ける。別の端末で親が消された時に、この端末で作った・変えた子が
     * 誰にも見えないまま残らないように、文章はゴミ箱に控えて（同じ内容がゴミ箱にあれば控えない）から消す。
     * 復元・すべて削除で親が消えた時も同じ: クラウドにあった子の削除は、親の削除より先か同じ通知で届いて消えている
     * （子から先に書く。SEND_ORDER・エンジンの pushAuthoritative）ので、ここで見つかる子はこの端末だけのもの（送っていない・
     * 書き換えたまま・復元の後に送った）。
     * keepActVersion を渡すと、消えた話・幕の稿をゴミ箱に入れる前にそれに渡す（true を返したら、applyRemote が残る幕・話の稿か
     * ゴミ箱の1件として残すので、ここでは控えない）
     */
    const sweepOrphans = async (
      parents: Map<TableName, Set<string>>,
      hooks: ConflictHooks,
      keepActVersion?: (child: AnyRecord, piece: AnyRecord) => Promise<boolean>,
    ) => {
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
            if (TEXT_TABLES.has(table) && !(await inTrash(table, child))) {
              const parent = parentTable === 'pieces' ? gone.get(parentId) : undefined
              const kept = table === 'versions' && parent && keepActVersion ? await keepActVersion(child, parent) : false
              if (!kept) await keepInTrash(table, child, hooks, child.id, parent ? { piece: parent } : undefined)
            }
            await delLocal(table, child.id)
            if (CHILDREN[table]) {
              const set = pending.get(table) ?? new Set<string>()
              set.add(child.id)
              pending.set(table, set)
            }
          }
        }
      }
    }
    return { gone, put, del, enqueueLocal, putLocal, delLocal, listVersion, keepConflict, keepInTrash, sweepOrphans }
  }

  const noteDeleted = (parents: Map<TableName, Set<string>>, table: TableName, id: string) => {
    if (!CHILDREN[table]) return
    const set = parents.get(table) ?? new Set<string>()
    set.add(id)
    parents.set(table, set)
  }

  /** 送信待ちの行と、いまの端末内の内容（keys の順） */
  async function itemsOf(keys: readonly string[]): Promise<OutboxItem[]> {
    if (!keys.length) return []
    const rows = (await db.outbox.bulkGet([...keys])).filter((r): r is OutboxRow => Boolean(r) && KNOWN_TABLES.has(r!.t))
    const byTable = new Map<TableName, OutboxRow[]>()
    for (const r of rows) {
      const list = byTable.get(r.t) ?? []
      list.push(r)
      byTable.set(r.t, list)
    }
    const items = new Map<string, OutboxItem>()
    for (const [t, list] of byTable) {
      const locals = await db.tableOf(t).bulkGet(list.map((r) => r.id))
      list.forEach((r, i) =>
        items.set(r.k, {
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
    return keys.map((k) => items.get(k)).filter((x): x is OutboxItem => Boolean(x))
  }

  /**
   * クラウドの変更を反映する（applyRemote のトランザクションの中）。
   * 1. 幕の構成のまとまりを決める（届いた話・幕と、幕の構成を変えた話の送信待ちから。話ごとに、両方で変わった・片方だけ）
   * 2. 1件ずつ反映する（3者マージ）。両方で幕の構成が変わった話・幕は後で丸ごと合わせる。片方だけなら、その側の採用稿を採る
   * 3. 応募時の原稿の本文の削除
   * 3b. 別の端末がバックアップから戻した話・幕の下に、この端末だけの幕・稿があれば控えて片付ける
   * 4. 両方で幕の構成が変わった話を、どちらかの構成に合わせる（resolveActsPieces）。採らなかった側の稿を控える
   * 5. この端末で消した幕・話の下に届いた稿・幕を控えて片付ける
   * 6. 消えた親の子を片付ける
   * 7. 控える幕の稿を、残る幕・話の稿（競合の名前付き）かゴミ箱に残す
   * 8. 書き換えられる前の稿から分けた・つないだ稿が届いたら知らせる（8b: 分けてから解除した話の、幕をつないだ稿も）
   */
  async function applyRemoteTx(
    changes: Change[],
    opts: RemoteApplyOptions,
    at: number,
    written: Map<string, Change>,
  ): Promise<void> {
    const w = writer(at, written)
    const parents = new Map<TableName, Set<string>>()
    const piecesT = db.tableOf('pieces')
    const versionsT = db.tableOf('versions')
    const getPiece = async (id: string) => ((await piecesT.get(id)) as PieceRec | undefined) ?? null
    const getVersion = async (id: string) => ((await versionsT.get(id)) as VersionRec | undefined) ?? null
    const rowOf = (table: TableName, id: string) => db.outbox.get(outboxKey(table, id))
    /** 反映する前の話・幕 */
    const pre = new Map<string, PieceRec | null>()
    const prePiece = async (id: string) => {
      if (!pre.has(id)) pre.set(id, await getPiece(id))
      return pre.get(id) ?? null
    }
    const incoming = new Map<string, Change>()
    for (const ch of changes) incoming.set(outboxKey(ch.table, ch.id), ch)
    /** ほかの端末からの話・幕の変化（この端末が書いたもの・復元を除く） */
    const remotePieces = new Map<string, Change>()
    for (const ch of changes) if (ch.table === 'pieces' && !ch.own && !ch.reset) remotePieces.set(ch.id, ch)

    /** 幕の知らせ（話ごと・種類ごとに1つ） */
    const actsNotes = new Map<string, { id: string; detail: ActsNoteDetail; kept: { versions: number; trash: number } }>()
    const noteActs = (episodeId: string, detail: ActsNoteDetail, kept?: { versions?: number; trash?: number }) => {
      const key = `${episodeId}:${detail}`
      const n = actsNotes.get(key) ?? { id: episodeId, detail, kept: { versions: 0, trash: 0 } }
      n.kept.versions += kept?.versions ?? 0
      n.kept.trash += kept?.trash ?? 0
      actsNotes.set(key, n)
    }

    // ---------- 1. 幕の構成のまとまり ----------
    const units = new Map<string, ActsUnit>()
    const skip = new Set<string>()
    const pieceRows = await db.outbox.where('k').startsWith('pieces/').toArray()
    const candidates = new Set<string>()
    for (const [id, ch] of remotePieces) {
      const disk = await prePiece(id)
      const row = await rowOf('pieces', id)
      const recs = [ch.record, disk, row?.base ?? null]
      const act = recs.find((r) => r && isActRecord(r))
      if (act) {
        const parentId = parentIdOf(act)
        if (parentId) {
          candidates.add(parentId)
          await prePiece(parentId)
        }
      } else if (recs.some((r) => r && isEpisodeRecord(r) && actIdsOf(r).length > 0)) candidates.add(id)
    }
    for (const row of pieceRows) {
      if (row.force) continue
      const local = await prePiece(row.id)
      if (isDirtyEpisodeRow({ base: row.base, local, noHistory: Boolean(row.noHistory), force: false })) candidates.add(row.id)
    }
    for (const ep of candidates) {
      const disk = await prePiece(ep)
      const row = await rowOf('pieces', ep)
      if (row?.force) continue
      const inc = remotePieces.get(ep)
      const baseRec = row ? row.base : disk
      const cloudRec = inc ? inc.record : baseRec
      if (!isEpisodeRecord(disk ?? cloudRec ?? baseRec)) continue
      const B = actIdsOf(baseRec)
      const M = actIdsOf(disk)
      const T = actIdsOf(cloudRec)
      const noHistory = Boolean(row?.noHistory)
      // 両方で幕の構成が変わった（話がどちらにもあり、この端末も変えている）。共通の履歴が無ければ、違っていれば
      const conflict =
        Boolean(disk && inc?.record && row) &&
        ((!sameIds(M, B) && !sameIds(T, B) && !sameIds(M, T)) || (noHistory && !sameIds(M, T)))
      const kind: ActsUnit['kind'] = conflict
        ? 'conflict'
        : !sameIds(T, B) && sameIds(M, B)
          ? 'theirs'
          : !sameIds(M, B) && sameIds(T, B)
            ? 'mine'
            : 'none'
      const unit: ActsUnit = {
        episodeId: ep,
        kind,
        same: Boolean(disk && inc?.record && row) && !noHistory && sameIds(M, T) && !sameIds(M, B),
        B,
        M,
        T,
        noHistory,
        verdict: conflict ? (noHistory ? 'theirs' : actsVerdict(B, M, T)) : null,
        members: new Set(),
      }
      if (conflict) {
        const members = new Set<string>([...B, ...M, ...T])
        for (const p of await piecesT.filter((r) => isActRecord(r) && parentIdOf(r) === ep).toArray()) members.add(p.id)
        for (const [id, ch] of remotePieces) {
          const r = ch.record ?? (await prePiece(id))
          if (r && isActRecord(r) && parentIdOf(r) === ep) members.add(id)
        }
        for (const r of pieceRows) {
          const rec = (await prePiece(r.id)) ?? r.base
          if (rec && isActRecord(rec) && parentIdOf(rec) === ep) members.add(r.id)
        }
        members.delete(ep)
        for (const id of members) await prePiece(id)
        if (opts.direct) {
          // 直接読んだ時は1回の書き込みの一部だけのことがある: 知らない幕を指していれば合わせずに、購読で届くのを待つ
          let unknown = false
          for (const id of T) if (!remotePieces.has(id) && !(await prePiece(id)) && !(await rowOf('pieces', id))) unknown = true
          if (unknown) {
            for (const id of [ep, ...members]) skip.add(outboxKey('pieces', id))
            continue
          }
        }
        unit.members = members
      }
      units.set(ep, unit)
    }
    /** 両方で幕の構成が変わった話と、その幕 → まとまり */
    const conflictOf = new Map<string, ActsUnit>()
    for (const u of units.values()) {
      if (u.kind !== 'conflict') continue
      conflictOf.set(u.episodeId, u)
      for (const id of u.members) conflictOf.set(id, u)
    }
    /** 話・幕の変化を合わせる時に、幕の構成を片方だけが変えていればその側。両方が同じに変えていればクラウド */
    const structureOf = (rec: AnyRecord | null, id: string): MergeOptions['acts'] => {
      const ep = rec && isActRecord(rec) ? parentIdOf(rec) : id
      const u = ep ? units.get(ep) : undefined
      if (!u) return undefined
      if (u.kind === 'theirs' || u.kind === 'mine') return { structure: u.kind }
      return u.same ? { structure: 'theirs' } : undefined
    }
    /** 稿の話・幕（端末内 → この反映で消した → 反映する前 → base → 届いたもの） */
    const pieceOfVersion = async (v: AnyRecord): Promise<PieceRec | null> => {
      const pieceId = (v as VersionRec).pieceId
      if (typeof pieceId !== 'string') return null
      const disk = await getPiece(pieceId)
      if (disk) return disk
      const gone = w.gone.get(pieceId) as PieceRec | undefined
      if (gone) return gone
      const before = pre.get(pieceId)
      if (before) return before
      const base = (await rowOf('pieces', pieceId))?.base as PieceRec | null | undefined
      if (base) return base
      return (incoming.get(outboxKey('pieces', pieceId))?.record as PieceRec | null | undefined) ?? null
    }
    const keeps: Keep[] = []
    /** 両方で幕の構成が変わった幕・話の稿の、本文の競合の控え（合わせた後で、残る幕・話の稿の一覧に載せる） */
    const listOnly = new Set<string>()
    /** 片方で削除・片方で編集された幕・話の稿は、ゴミ箱でなく、反映の最後に残る幕・話の稿として残す */
    const keepVersionOf = (editedHere: boolean) => async (kept: AnyRecord) => {
      const piece = await pieceOfVersion(kept)
      if (!piece) return false
      const ep = isActRecord(piece) ? parentIdOf(piece) : units.has(piece.id) ? piece.id : null
      if (!ep) return false
      keeps.push({ record: kept, episodeId: ep, pieceId: piece.id, mine: editedHere, reason: 'edit', live: false })
      return true
    }
    const bodyOf = async (id: unknown) => {
      if (typeof id !== 'string') return null
      const inc = incoming.get(outboxKey('versions', id))
      if (inc) return ((inc.record as VersionRec | null)?.body as string | undefined) ?? null
      return ((await getVersion(id))?.body as string | undefined) ?? null
    }
    /** 話・幕を合わせた結果、どちらかの採用・編集が採用原稿に入らなかったら知らせる */
    const notePieceMerge = async (ch: Change, result: MergeResult, disk: AnyRecord | null, base: AnyRecord | null) => {
      const rec = (ch.record ?? disk ?? base) as PieceRec | null
      if (!rec) return
      const ep = isActRecord(rec) ? parentIdOf(rec) : ch.id
      if (!ep) return
      if (result.overridden) {
        const a = await bodyOf((disk as PieceRec | null)?.activeVersionId)
        const b = await bodyOf((ch.record as PieceRec | null)?.activeVersionId)
        if (a === null || a !== b) noteActs(ep, result.overridden === 'mine' ? 'mineDropped' : 'theirsDropped')
      }
      // 幕がつないだ・解除したことで消えた一方で、もう一方の端末がその幕の採用稿を変えていた
      if (result.deletedEdit && isActRecord(result.deletedEdit) && base) {
        const edited = result.deletedEdit as PieceRec
        if (!deepEqual(edited.activeVersionId, (base as PieceRec).activeVersionId))
          noteActs(ep, disk ? 'mineDropped' : 'theirsDropped')
      }
    }
    /** この端末で分けた話の、分ける前の採用稿の、別の端末での書き換え（反映した後も分けたままなら 8 で知らせる） */
    const sourceEdits: VersionRec[] = []
    const checkSource = async (v: VersionRec, old: VersionRec) => {
      if (v.body === old.body || typeof v.pieceId !== 'string') return
      const piece = await prePiece(v.pieceId)
      if (piece && isEpisodeRecord(piece) && actIdsOf(piece).length > 0 && piece.activeVersionId === v.id) sourceEdits.push(v)
    }

    // ---------- 2. 1件ずつ反映する ----------
    /** 応募時の原稿の本文の削除は、ほかの変更を当てた後で、使われていないことを確かめてから当てる */
    const textTombstones: Change[] = []
    /** 両方で幕の構成が変わった話・幕の、ほかの端末からの変化（4で丸ごと合わせる） */
    const deferredMembers = new Map<string, Change>()
    /** 届いた新しい稿（この端末に無かった） */
    const newVersions: string[] = []
    /** この端末で変えていたのに、別の端末で消された話・幕 */
    const editedHere = new Set<string>()
    /**
     * 別の端末の復元・すべて削除の内容をそのまま当てた話・幕（3b で、その下のこの端末だけの幕・稿を片付ける）。
     * この端末の内容を残した時（この端末が書いたものの返事・この端末の復元をまだ送っていない）は入れない
     */
    const resetApplied = new Set<string>()
    for (const ch of changes) {
      if (!KNOWN_TABLES.has(ch.table)) continue
      const k = outboxKey(ch.table, ch.id)
      if (skip.has(k)) continue
      if (ch.table === 'pieces' && !ch.own && !ch.reset && conflictOf.has(ch.id)) {
        deferredMembers.set(ch.id, ch)
        continue
      }
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
          if (ch.table === 'pieces') resetApplied.add(ch.id)
        } else if (disk) {
          await w.del(ch.table, ch.id, disk)
          noteDeleted(parents, ch.table, ch.id)
        }
        continue
      }
      if (!queued) {
        if (deepEqual(disk, ch.record)) continue
        if (ch.table === 'versions' && ch.record && !ch.own) {
          if (!disk) newVersions.push(ch.id)
          else await checkSource(ch.record as VersionRec, disk as VersionRec)
        }
        if (ch.record) await w.put(ch.table, ch.record)
        else if (disk) {
          await w.del(ch.table, ch.id, disk)
          noteDeleted(parents, ch.table, ch.id)
        }
        continue
      }
      const acts = ch.table === 'pieces' && !ch.own ? structureOf(ch.record ?? disk ?? queued.base, ch.id) : undefined
      const result = mergeRemote(ch.table, queued.base, disk, ch.record, {
        device: opts.device,
        noHistory: queued.noHistory,
        ...(acts ? { acts } : {}),
      })
      // クラウドと同じ内容になったら、クラウドの内容そのものを使う（更新日時まで揃える）
      if (contentEqual(result.record, ch.record)) result.record = ch.record
      if (!deepEqual(result.record, disk)) {
        if (result.record) await w.put(ch.table, result.record)
        else if (disk) {
          await w.del(ch.table, ch.id, disk)
          noteDeleted(parents, ch.table, ch.id)
        }
      }
      // クラウドの内容が新しい base。合わせた結果がクラウドと同じなら送るものは無い
      if (deepEqual(result.record, ch.record)) await db.outbox.delete(k)
      else await db.outbox.put({ k, t: ch.table, id: ch.id, base: ch.record, at: queued.at })
      if (ch.table === 'pieces') {
        await notePieceMerge(ch, result, disk, queued.base)
        // この端末で変えた幕・話が別の端末で消された: その稿（もう送った稿も）はこの端末のもの
        if (result.deletedEdit && disk) editedHere.add(ch.id)
      }
      await w.keepConflict(ch.table, result, opts, ch.id, {
        keepVersion: keepVersionOf(disk !== null),
        pieceOf: pieceOfVersion,
        listCopy: (copy) => {
          const pieceId = (copy as VersionRec).pieceId
          if (typeof pieceId !== 'string' || !conflictOf.has(pieceId)) return true
          listOnly.add(copy.id)
          return false
        },
      })
    }

    // ---------- 3. 応募時の原稿の本文の削除 ----------
    // この端末の応募計画がまだ使っている間は消さない（送り直して、ほかの端末にも戻す）
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

    // ---------- 3b. 別の端末がバックアップから戻した話・幕の下の、この端末だけの幕・稿 ----------
    // 戻した内容を正とする（この端末の送信待ちは 2 で消した）。この端末で分けた・つないだまま送っていない幕・稿は
    // クラウドに無いので、戻した端末は消さない。話の幕の並び・稿の一覧に載らないまま残らないように、稿を控えて片付ける
    // （稿は 7 で、残る幕・話の稿「（競合: ○○での幕の操作）」か、採用原稿にそのまま入っていればゴミ箱の1件に）。
    // 2 で戻した内容をそのまま当てた話・幕だけ（端末内 = 戻した内容）。この端末の内容を残した話・幕は、端末内の幕の並び・
    // 稿の一覧がこの端末の幕・稿を載せているので片付けない
    // この端末の復元の返事は見ない（復元で端末内を置き換えたので、この端末だけの幕・稿は、その後で作ったもの）
    const restored = changes.filter((ch) => !ch.own && ch.reset && ch.table === 'pieces' && ch.record && resetApplied.has(ch.id))
    // この端末だけの幕・稿（base が null の送信待ち。2 で、届いた復元のレコードの送信待ちは消してある）を、話・幕ごとに
    // 一度だけ集める（復元はすべての話・幕に届くので、話・幕ごとに表を読み直さない）
    const unsentActs = new Map<string, PieceRec[]>()
    const unsentVersions = new Map<string, VersionRec[]>()
    if (restored.length) {
      const localOnlyIds = async (t: TableName) =>
        (await db.outbox.where('k').startsWith(`${t}/`).toArray()).filter((r) => r.base === null).map((r) => r.id)
      for (const p of (await piecesT.bulkGet(await localOnlyIds('pieces'))) as (PieceRec | undefined)[]) {
        const parentId = p && isActRecord(p) ? parentIdOf(p) : null
        if (p && parentId) unsentActs.set(parentId, [...(unsentActs.get(parentId) ?? []), p])
      }
      for (const v of (await versionsT.bulkGet(await localOnlyIds('versions'))) as (VersionRec | undefined)[])
        if (v && typeof v.pieceId === 'string') unsentVersions.set(v.pieceId, [...(unsentVersions.get(v.pieceId) ?? []), v])
    }
    /** 話・幕の稿（片付ける幕がある時だけ、稿の表を一度だけ読む） */
    let versionsByPiece: Map<string, VersionRec[]> | null = null
    const versionsUnder = async (pieceId: string) => {
      if (!versionsByPiece) {
        const byPiece = new Map<string, VersionRec[]>()
        for (const v of (await versionsT.toArray()) as VersionRec[])
          if (typeof v.pieceId === 'string') byPiece.set(v.pieceId, [...(byPiece.get(v.pieceId) ?? []), v])
        versionsByPiece = byPiece
      }
      return versionsByPiece.get(pieceId) ?? []
    }
    for (const ch of restored) {
      const rec = ch.record as PieceRec
      const ep = isEpisodeRecord(rec) ? ch.id : isActRecord(rec) ? parentIdOf(rec) : null
      if (!ep) continue
      const keepLocal = (v: AnyRecord, pieceId: string) =>
        keeps.push({ record: v, episodeId: ep, pieceId, mine: true, reason: 'acts', live: true, detail: 'lost' })
      if (isEpisodeRecord(rec)) {
        const listed = new Set(actIdsOf(rec))
        for (const a of unsentActs.get(ch.id) ?? []) {
          if (listed.has(a.id)) continue
          for (const v of await versionsUnder(a.id)) keepLocal(v, a.id)
          await w.delLocal('pieces', a.id)
          noteActs(ep, 'lost')
        }
        // 話の幕の構成は戻した内容になった（この端末の構成の変更は残っていない）
        units.delete(ch.id)
      }
      const listedVersions = new Set(Array.isArray(rec.versionIds) ? rec.versionIds : [])
      for (const v of unsentVersions.get(ch.id) ?? []) {
        if (listedVersions.has(v.id)) continue
        // 幕の操作（さらに分ける・つなぐ・解除）で作った稿（sourceHash）だけ控える。ふつうに足した・複製した稿は、
        // 名前も変えずに戻した話・幕の稿の一覧に載せ直す（幕の操作ではないので、幕の知らせも出さない）
        if (typeof v.sourceHash !== 'string') {
          await w.listVersion(ch.id, v.id)
          continue
        }
        keepLocal(v, ch.id)
        noteActs(ep, 'lost')
      }
    }

    // ---------- 4. 両方で幕の構成が変わった話を、どちらかの構成に合わせる ----------
    for (const u of units.values()) {
      if (u.kind !== 'conflict' || !u.verdict) continue
      const ep = u.episodeId
      const tri = async (id: string) => {
        const local = await getPiece(id)
        const row = await rowOf('pieces', id)
        const inc = deferredMembers.get(id)
        const base = row ? row.base : local
        return { base, local, cloud: inc ? inc.record : base, row }
      }
      const tris = new Map<string, Awaited<ReturnType<typeof tri>>>([[ep, await tri(ep)]])
      for (const id of u.members) tris.set(id, await tri(id))
      const res = resolveActsPieces({
        episodeId: ep,
        episode: tris.get(ep)!,
        acts: new Map([...tris].filter(([id]) => id !== ep)),
        verdict: u.verdict,
        noHistory: u.noHistory,
        device: opts.device,
      })
      u.resolution = res
      for (const [id, f] of res.pieces) {
        const t = tris.get(id)!
        if (!deepEqual(f, t.local)) {
          if (f) await w.put('pieces', f)
          else if (t.local) {
            await w.del('pieces', id, t.local)
            noteDeleted(parents, 'pieces', id)
          }
        }
        // クラウドの内容が新しい base。合わせた結果がクラウドと同じなら送るものは無い
        const k = outboxKey('pieces', id)
        if (deepEqual(f, t.cloud)) {
          if (t.row) await db.outbox.delete(k)
        } else await db.outbox.put({ k, t: 'pieces', id, base: t.cloud, at: t.row?.at ?? at })
      }
      // 稿: 消える幕の稿・残る幕に載らないこの端末の稿は控える。この端末の操作で消した稿は、幕が戻るなら戻す
      const finalOf = (pieceId: string) => res.pieces.get(pieceId) as PieceRec | null | undefined
      const memberIds = new Set(res.pieces.keys())
      const vids = new Set<string>()
      for (const v of await versionsT.filter((r) => memberIds.has(String((r as VersionRec).pieceId))).toArray()) vids.add(v.id)
      for (const r of await db.outbox.where('k').startsWith('versions/').toArray()) {
        const pieceId = (r.base as VersionRec | null)?.pieceId
        if (typeof pieceId === 'string' && memberIds.has(pieceId)) vids.add(r.id)
      }
      for (const ch of changes) {
        const pieceId = (ch.record as VersionRec | null)?.pieceId
        if (ch.table === 'versions' && typeof pieceId === 'string' && memberIds.has(pieceId)) vids.add(ch.id)
      }
      const add = new Map<string, string[]>()
      const remove = new Map<string, string[]>()
      const push = (m: Map<string, string[]>, pieceId: string, id: string) => m.set(pieceId, [...(m.get(pieceId) ?? []), id])
      for (const vid of vids) {
        const v = await getVersion(vid)
        const row = await rowOf('versions', vid)
        if (v) {
          const pieceId = String(v.pieceId)
          const f = finalOf(pieceId)
          if (f === undefined) continue
          const edited = listOnly.has(vid) || Boolean(row && row.base !== null && !deepEqual(row.base, v))
          if (f === null) {
            keeps.push({
              record: v,
              episodeId: ep,
              pieceId,
              mine: listOnly.has(vid) || Boolean(row && !deepEqual(row.base, v)),
              reason: edited ? 'edit' : 'acts',
              live: false,
            })
            await w.delLocal('versions', vid)
          } else if (!(f.versionIds ?? []).includes(vid)) {
            if (listOnly.has(vid)) push(add, pieceId, vid)
            else if (row && row.base === null)
              keeps.push({ record: v, episodeId: ep, pieceId, mine: true, reason: edited ? 'edit' : 'acts', live: true })
          }
        } else if (row?.base) {
          const pieceId = String((row.base as VersionRec).pieceId)
          const f = finalOf(pieceId)
          if (!f || !(f.versionIds ?? []).includes(vid)) continue
          if (res.resurrected.has(pieceId) || f.activeVersionId === vid) {
            // この端末の操作で消した幕が戻る・採った側の幕がこの稿を採用している（この端末で別の稿を採用してから消した稿）:
            // その稿も戻す（base = クラウドの内容。両方で変わっていれば 2 で届いた内容が base になっている）
            await w.put('versions', row.base)
            await db.outbox.delete(row.k)
          } else push(remove, pieceId, vid)
        }
      }
      for (const pieceId of new Set([...add.keys(), ...remove.keys()])) {
        const cur = await getPiece(pieceId)
        if (!cur) continue
        const drop = new Set(remove.get(pieceId) ?? [])
        const versionIds = [...(cur.versionIds ?? []).filter((id) => !drop.has(id)), ...(add.get(pieceId) ?? [])]
        const seq = typeof cur.versionSeq === 'number' ? cur.versionSeq : 1
        await w.putLocal('pieces', {
          ...cur,
          versionIds,
          versionSeq: Math.max(seq, versionIds.length),
          updatedAt: at,
        } as AnyRecord)
      }
      // この端末の操作でゴミ箱に入れた稿（まだ送っていない件）が、すべて稿に戻ったら、その件を消す
      for (const r of await db.outbox.where('k').startsWith('trashEntries/').toArray()) {
        if (r.base !== null) continue
        const entry = (await db.tableOf('trashEntries').get(r.id)) as
          | (AnyRecord & { kind?: string; origin?: { parentId?: string; pieceId?: string }; recordIds?: string[] })
          | undefined
        if (!entry || entry.kind !== 'version') continue
        const origin = entry.origin
        if (!(origin?.parentId === ep || (origin?.pieceId && memberIds.has(origin.pieceId)))) continue
        const recs = await db
          .tableOf('trashRecords')
          .filter((x) => (x as { entryId?: string }).entryId === entry.id)
          .toArray()
        let back = recs.length > 0
        for (const x of recs) {
          const rec = (x as { table?: string; record?: VersionRec }).record
          const cur = rec && (x as { table?: string }).table === 'versions' ? await getVersion(rec.id) : null
          if (!cur || !rec || cur.body !== rec.body || (cur.note ?? '') !== (rec.note ?? '')) back = false
        }
        if (!back) continue
        for (const x of recs) await w.delLocal('trashRecords', x.id)
        await w.delLocal('trashEntries', entry.id)
      }
      noteActs(ep, u.verdict === 'mine' ? 'won' : 'lost')
    }

    // ---------- 5. この端末で消した幕・話の下に届いた稿・幕 ----------
    for (const ch of changes) {
      if (ch.own || ch.reset || !ch.record || skip.has(outboxKey(ch.table, ch.id))) continue
      if (ch.table === 'versions') {
        const v = await getVersion(ch.id)
        const pieceId = v?.pieceId
        if (!v || typeof pieceId !== 'string' || w.gone.has(pieceId) || (await getPiece(pieceId))) continue
        // 消した幕、または幕の構成のまとまりの話（分けていた・この反映で分けた・解除した）の稿
        const prow = await rowOf('pieces', pieceId)
        const owner = prow?.base
        const ep = owner && isActRecord(owner) ? parentIdOf(owner) : owner && units.has(pieceId) ? pieceId : null
        if (!ep) continue
        keeps.push({ record: v, episodeId: ep, pieceId, mine: false, reason: 'edit', live: false })
        await w.delLocal('versions', v.id)
      } else if (ch.table === 'pieces' && isActRecord(ch.record)) {
        const ep = parentIdOf(ch.record)
        if (!ep || !(await getPiece(ch.id)) || (await getPiece(ep))) continue
        if (await rowOf('pieces', ep)) noteDeleted(parents, 'pieces', ep)
      }
    }

    // ---------- 6. 消えた親の子を片付ける ----------
    if (parents.size)
      await w.sweepOrphans(parents, opts, async (child, piece) => {
        // 消えた幕の稿、幕の構成のまとまりの話が消えた時のその話の稿は、反映の最後に残す（それ以外は今までどおりゴミ箱）
        const ep = isActRecord(piece) ? parentIdOf(piece) : units.has(piece.id) ? piece.id : null
        if (!ep) return false
        const row = await rowOf('versions', child.id)
        keeps.push({
          record: child,
          episodeId: ep,
          pieceId: piece.id,
          mine: Boolean(row && !deepEqual(row.base, child)) || editedHere.has(piece.id),
          reason: 'edit',
          live: false,
        })
        return true
      })

    // ---------- 7. 幕の稿を、残る幕・話の稿かゴミ箱に残す ----------
    if (keeps.length) await flushKeeps(keeps, { opts, w, units, pre, noteActs, getPiece, getVersion, rowOf, pieceOfVersion })

    // ---------- 8. 書き換えられる前の稿から分けた・つないだ稿 ----------
    // この端末で分けた話の分ける前の採用稿が書き換えられた: 反映した後もその話を分けていて、その稿を採用している時だけ
    // （同じ反映でセパレートを解除した話なら、解除した稿が採用原稿になっている）
    for (const v of sourceEdits) {
      const piece = await getPiece(String(v.pieceId))
      if (piece && isEpisodeRecord(piece) && actIdsOf(piece).length > 0 && piece.activeVersionId === v.id)
        noteActs(piece.id, 'source')
    }
    /** 届いた新しい稿のうち、幕の操作で作った稿（元の稿と、その本文の指紋を控えている）。届いた内容で選ぶ（読み直さない） */
    const fromActs = newVersions.filter((vid) => {
      const inc = incoming.get(outboxKey('versions', vid))?.record as VersionRec | null | undefined
      return Boolean(inc) && typeof inc!.sourceHash === 'string' && typeof inc!.sourceVersionId === 'string'
    })
    for (const vid of fromActs) {
      const v = await getVersion(vid)
      if (!v || typeof v.sourceHash !== 'string' || typeof v.sourceVersionId !== 'string') continue
      // 同じ反映で別の端末から届いた元の稿の書き換えは見ない（分けた・つないだ後の書き換えのことがある。オフラインだった
      // 端末が両方をまとめて受け取った時・送った端末がオフラインの間に両方をした時）
      const srcChange = incoming.get(outboxKey('versions', v.sourceVersionId))
      if (srcChange && !srcChange.own) continue
      // 別の端末だけが幕の構成を変えた話（稿の話そのもの、または幕の属する話）
      const piece = await getPiece(String(v.pieceId))
      if (!piece) continue
      const ep = units.get(piece.id)?.kind === 'theirs' ? piece.id : parentIdOf(piece)
      if (!ep || units.get(ep)?.kind !== 'theirs') continue
      const src = await getVersion(v.sourceVersionId)
      if (src && typeof src.body === 'string' && textHash(src.body) !== v.sourceHash) noteActs(ep, 'stale')
    }

    // ---------- 8b. セパレートを解除した話の採用稿が、書き換えられる前の話の稿から分けた本文だった ----------
    // 別の端末が分けてから解除した（この端末ではずっと分けていない）時は、どの記録の幕の並びも空なので、まとまりはできない
    for (const vid of fromActs) {
      const v = await getVersion(vid)
      if (!v || typeof v.sourceHash !== 'string' || typeof v.sourceVersionId !== 'string') continue
      const piece = await getPiece(String(v.pieceId))
      if (!piece || !isEpisodeRecord(piece) || actIdsOf(piece).length > 0 || piece.activeVersionId !== v.id) continue
      // 同じ反映で別の端末から届いた元の稿の書き換えは見ない（解除より後に書き換えられたことがある。
      // 長くオフラインだった端末が、両方をまとめて受け取った時）
      const srcChange = incoming.get(outboxKey('versions', v.sourceVersionId))
      if (srcChange && !srcChange.own) continue
      const src = await getVersion(v.sourceVersionId)
      if (!src || src.pieceId !== piece.id || typeof src.body !== 'string') continue
      if (textHash(src.body) !== v.sourceHash) noteActs(piece.id, 'stale')
    }

    // 話が消えた知らせがあれば、その話の幕の採用・編集が入らなかった知らせは出さない（話ごと消えたので）
    const gone = new Set(
      [...actsNotes.values()].filter((n) => n.detail === 'deletedHere' || n.detail === 'deletedThere').map((n) => n.id),
    )
    for (const n of actsNotes.values()) {
      if (gone.has(n.id) && (n.detail === 'mineDropped' || n.detail === 'theirsDropped') && !n.kept.versions && !n.kept.trash)
        continue
      opts.report?.({
        kind: 'acts',
        table: 'pieces',
        id: n.id,
        detail: n.detail,
        ...(n.kept.versions || n.kept.trash ? { kept: n.kept } : {}),
      })
    }
  }

  /**
   * 控える幕の稿を残す（話ごと）。
   * - 話が消えた: ゴミ箱の1件（削除された話の幕の稿）
   * - 稿の幕・話が残っていて、書き換えた稿が削除と重なった: ゴミ箱（2.1 と同じ）
   * - 幕の操作で作った稿で、本文が採用原稿にそのまま入っている（推敲メモも空）: ゴミ箱の1件（幕の分け方の競合で残した稿）
   * - それ以外: 稿の幕が残っていればその幕、なければ近くの残る幕・話の稿（「第2幕の第1稿（競合: ○○での編集）」。採用しない）
   */
  async function flushKeeps(
    keeps: readonly Keep[],
    c: {
      opts: RemoteApplyOptions
      w: ReturnType<typeof writer>
      units: ReadonlyMap<string, ActsUnit>
      pre: ReadonlyMap<string, PieceRec | null>
      noteActs: (episodeId: string, detail: ActsNoteDetail, kept?: { versions?: number; trash?: number }) => void
      getPiece: (id: string) => Promise<PieceRec | null>
      getVersion: (id: string) => Promise<VersionRec | null>
      rowOf: (table: TableName, id: string) => Promise<OutboxRow | undefined>
      pieceOfVersion: (v: AnyRecord) => Promise<PieceRec | null>
    },
  ): Promise<void> {
    const { opts, w } = c
    let trash: AnyRecord[] | null = null
    /** 同じ稿（id・本文・推敲メモ）がもうゴミ箱にある */
    const inTrash = async (v: VersionRec) => {
      trash ??= await db.tableOf('trashRecords').toArray()
      return trash.some((t) => {
        const tr = t as unknown as { table?: string; record?: VersionRec }
        return (
          tr.table === 'versions' &&
          tr.record?.id === v.id &&
          tr.record.body === v.body &&
          (tr.record.note ?? '') === (v.note ?? '')
        )
      })
    }
    const byEpisode = new Map<string, Keep[]>()
    for (const k of keeps) byEpisode.set(k.episodeId, [...(byEpisode.get(k.episodeId) ?? []), k])
    for (const [ep, list] of byEpisode) {
      const u = c.units.get(ep)
      const pending: Keep[] = []
      for (const k of list) {
        const rec = k.record as VersionRec
        if (!k.live) {
          // 稿に戻っている（この端末の操作で消した幕が戻った時など）
          const cur = await c.getVersion(rec.id)
          if (cur && cur.body === rec.body && (cur.note ?? '') === (rec.note ?? '')) continue
        }
        if (await inTrash(rec)) continue
        if (pending.some((p) => p.record.id === rec.id)) continue
        pending.push(k)
      }
      if (!pending.length) continue
      const episode = await c.getPiece(ep)
      const before = c.pre.get(ep) ?? (w.gone.get(ep) as PieceRec | undefined) ?? null
      const orders = [
        u ? u.M : actIdsOf(before),
        u ? u.B : actIdsOf((await c.rowOf('pieces', ep))?.base ?? before),
        u ? u.T : actIdsOf(episode),
      ]
      const numberIn = (pieceId: string) => {
        const o = orders.find((x) => x.includes(pieceId))
        return o ? o.indexOf(pieceId) + 1 : null
      }
      // 幕の順（同じ幕の中は控えた順）に並べる
      const rank = (k: Keep) => numberIn(k.pieceId) ?? Number.MAX_SAFE_INTEGER
      pending.sort((a, b) => rank(a) - rank(b))
      const fallback = async (k: Keep) =>
        w.keepInTrash('versions', k.record, opts, k.record.id, { piece: await c.pieceOfVersion(k.record) })

      if (!episode) {
        // 話が消えた（この端末・別の端末で削除した）: 幕の稿はゴミ箱の1件に（話を戻すと、話の稿として戻せる）
        const items = pending.map((k) => ({ record: k.record, actNumber: numberIn(k.pieceId) }))
        for (const k of pending) if (k.live) await w.delLocal('versions', k.record.id)
        const extras = opts.actsTrash?.(items, { episodeId: ep, episode: before, target: null, deleted: true })
        if (extras) {
          for (const x of extras) if (x.record) await w.putLocal(x.table, x.record)
        } else for (const k of pending) await fallback(k)
        const deletedHere = c.pre.has(ep) ? c.pre.get(ep) === null : !w.gone.has(ep)
        c.noteActs(ep, deletedHere ? 'deletedHere' : 'deletedThere', { trash: items.length })
        continue
      }

      // 話が残っている: 残る幕と採用原稿
      const acts = new Map<string, PieceRec>()
      const versions = new Map<string, VersionRec>()
      const live: string[] = []
      for (const id of actIdsOf(episode)) {
        const a = await c.getPiece(id)
        if (!a || parentIdOf(a) !== ep) continue
        acts.set(id, a)
        live.push(id)
        const av = typeof a.activeVersionId === 'string' ? await c.getVersion(a.activeVersionId) : null
        if (av) versions.set(av.id, av)
      }
      if (!live.length && typeof episode.activeVersionId === 'string') {
        const ev = await c.getVersion(episode.activeVersionId)
        if (ev) versions.set(ev.id, ev)
      }
      const text = familyText(
        live.length ? episode : { ...episode, actIds: [] },
        (id) => acts.get(id),
        (id) => versions.get(id),
      )
      const kept = new Map<ActsNoteDetail, { versions: number; trash: number }>()
      const count = (d: ActsNoteDetail, f: 'versions' | 'trash') => {
        const n = kept.get(d) ?? { versions: 0, trash: 0 }
        n[f] += 1
        kept.set(d, n)
      }
      const trashItems: { record: AnyRecord; actNumber: number | null; detail: ActsNoteDetail }[] = []
      let trashTarget: AnyRecord | null = null
      for (const k of pending) {
        const detail: ActsNoteDetail =
          k.detail ??
          (u?.kind === 'conflict' && u.verdict
            ? u.verdict === 'mine'
              ? 'won'
              : 'lost'
            : k.mine
              ? 'mineDropped'
              : 'theirsDropped')
        const own = await c.getPiece(k.pieceId)
        const ownLive = own !== null && (own.id === ep || live.includes(own.id))
        if (k.reason === 'edit' && !k.live && ownLive) {
          // 稿の幕・話が残っている: 削除と編集が重なった稿（2.1 と同じくゴミ箱へ）
          await w.keepInTrash('versions', k.record, opts, k.record.id, { piece: own })
          continue
        }
        const { targetId, actNumber } = chooseTarget({
          episodeId: ep,
          live,
          orders,
          pieceId: k.pieceId,
          createdHere: !(u?.B ?? orders[1]).includes(k.pieceId) && !(u?.T ?? orders[2]).includes(k.pieceId),
        })
        if (k.reason === 'acts' && isRedundant(k.record as VersionRec, text)) {
          trashItems.push({ record: k.record, actNumber: numberIn(k.pieceId), detail })
          trashTarget ??= await c.getPiece(targetId)
          if (k.live) await w.delLocal('versions', k.record.id)
          continue
        }
        const target = ownLive && k.live ? own : await c.getPiece(targetId)
        if (!target || !opts.actsCopy) {
          await fallback(k)
          if (k.live) await w.delLocal('versions', k.record.id)
          count(detail, 'trash')
          continue
        }
        const copy = opts.actsCopy(k.record, target, { actNumber, reason: k.reason, mine: k.mine })
        if (k.live && copy.id !== k.record.id) await w.delLocal('versions', k.record.id)
        await w.putLocal('versions', copy)
        await w.listVersion(target.id, copy.id)
        count(detail, 'versions')
      }
      if (trashItems.length) {
        const extras = opts.actsTrash?.(
          trashItems.map((x) => ({ record: x.record, actNumber: x.actNumber })),
          { episodeId: ep, episode, target: trashTarget ?? episode, deleted: false },
        )
        if (extras) {
          for (const x of extras) if (x.record) await w.putLocal(x.table, x.record)
        } else
          for (const x of trashItems)
            await w.keepInTrash('versions', x.record, opts, x.record.id, { piece: await c.pieceOfVersion(x.record) })
        for (const x of trashItems) count(x.detail, 'trash')
      }
      for (const [detail, n] of kept) c.noteActs(ep, detail, n)
    }
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
            for (const parent of PARENT_OF[job.table] ?? []) {
              for (const rec of job.puts) {
                if (prev[job.table][rec.id as never]) continue
                const parentId = (rec as unknown as Record<string, string>)[parent.field]
                if (!parentId || (await db.tableOf(parent.table).get(parentId))) continue
                const set = parents.get(parent.table) ?? new Set<string>()
                set.add(parentId)
                parents.set(parent.table, set)
              }
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
      let deferred = false
      await db.transaction('rw', [...allTables(), db.outbox, db.meta], async () => {
        if ((await db.meta.get('authoritative'))?.value) {
          deferred = true
          return
        }
        await applyRemoteTx(changes, opts, at, written)
        if (opts.cursor !== undefined) await db.meta.put({ key: 'cursor', value: opts.cursor })
      })
      return deferred ? null : [...written.values()]
    },

    readOutbox(limit) {
      // 送信待ちの一覧・行・端末内の内容を1つの読み取りトランザクションで読む（読んでいる途中に保存が入って、幕のまとまりが
      // 操作の前と後の混ざった内容にならないように。途中に始まった保存は、読み終わるのを待ってからまとめて書かれる）
      return db.transaction('r', [db.outbox, ...allTables()], async () => {
        const keys = (await db.outbox.toCollection().primaryKeys()).map(String)
        keys.sort((a, b) => sendRank(a) - sendRank(b) || (a < b ? -1 : a > b ? 1 : 0))
        // 幕の構成を変えた話があれば、その話・幕・稿・ゴミ箱の件を1つのまとまりとして続けて並べる（全部を1回で送る）
        const pieceItems = await itemsOf(keys.filter((k) => k.startsWith('pieces/')))
        if (!pieceItems.some(isDirtyEpisodeRow)) return itemsOf(keys.slice(0, limit))
        const known = new Map<string, OutboxItem>()
        const related = keys.filter((k) => /^(versions|trashEntries|trashRecords)\//.test(k))
        for (const it of [...pieceItems, ...(await itemsOf(related))]) known.set(it.k, it)
        const groups = groupOutbox([...known.values()])
        const members = new Map<string, string[]>()
        for (const k of keys) {
          const g = groups.get(k)
          if (!g) continue
          const list = members.get(g) ?? []
          list.push(k)
          members.set(g, list)
        }
        const order: string[] = []
        const done = new Set<string>()
        for (const k of keys) {
          // 上限に達しても、並べ始めたまとまりは最後まで入れる
          if (order.length >= limit) break
          if (done.has(k)) continue
          const g = groups.get(k)
          for (const m of g ? members.get(g)! : [k]) {
            order.push(m)
            done.add(m)
          }
        }
        for (const it of await itemsOf(order.filter((k) => !known.has(k)))) known.set(it.k, it)
        const out: OutboxItem[] = []
        for (const k of order) {
          const it = known.get(k)
          if (!it) continue
          const g = groups.get(k)
          out.push(g ? { ...it, group: g } : it)
        }
        return out
      })
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
