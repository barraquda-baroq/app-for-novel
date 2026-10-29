// ゴミ箱: 削除したものを30日とっておき、元の場所へ戻せるようにする。
// 削除の操作（entityOps / storyOps）は putInTrash でレコードを丸ごとここへ移し、削除した時点の場所（TrashOrigin）を控える。
// 戻す時はその場所へ並べ直す（直前にあった要素がまだあればその直後、なければ控えた位置）。
// すべて純粋関数で、新しい AppData を返す。戻せない時は DomainError を投げる。
import { actsOf, isSplit, locatePiece } from './structure'
import { Tx, transact } from './tx'
import {
  DomainError,
  TABLE_NAMES,
  type AppData,
  type Chapter,
  type ContentTableName,
  type CritiquePrompt,
  type CritiqueResult,
  type ID,
  type Idea,
  type Memo,
  type NodeRef,
  type Piece,
  type ProofBatch,
  type ProofSuggestion,
  type RevisionIdea,
  type SettingCategory,
  type SettingEntry,
  type SnapshotText,
  type StrategyNote,
  type Submission,
  type SubmissionSnapshot,
  type Title,
  type TrashEntry,
  type TrashKind,
  type TrashOrigin,
  type TrashRecord,
  type Version,
} from './types'
import { byOrder, newId, nextOrder, now } from './util'
import { pieceVersions, restoredVersionName } from './versionNumber'

// ---------- 定数・表記 ----------

/** ゴミ箱に残す日数。これを過ぎたものは中身ごと完全に削除する */
export const TRASH_RETENTION_DAYS = 30
export const DAY_MS = 24 * 60 * 60 * 1000
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * DAY_MS

/**
 * 削除の確認文の結び。subject には「この話の推敲バージョン（3稿）もいっしょに」のような前置きを渡せる。
 * 例: 「ゴミ箱に移します。30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。」
 */
export function trashNotice(subject = ''): string {
  return `${subject}ゴミ箱に移します。${TRASH_RETENTION_DAYS}日後に完全に削除されます（それまではゴミ箱から元に戻せます）。`
}

/** ゴミ箱に入れられるレコード */
export type ContentRecord = AppData[ContentTableName][string]

/** ゴミ箱以外の表（ゴミ箱に入れられるレコードの表） */
export const CONTENT_TABLES: readonly ContentTableName[] = TABLE_NAMES.filter(
  (t): t is ContentTableName => t !== 'trashEntries' && t !== 'trashRecords',
)

export function isContentTable(v: unknown): v is ContentTableName {
  return typeof v === 'string' && (CONTENT_TABLES as readonly string[]).includes(v)
}

export const TRASH_KINDS: readonly TrashKind[] = [
  'title',
  'chapter',
  'piece',
  'version',
  'memo',
  'idea',
  'settingCategory',
  'settingEntry',
  'submission',
  'proofSuggestion',
  'revisionIdea',
  'strategyNote',
  'critiquePrompt',
  'critiqueResult',
]

export function isTrashKind(v: unknown): v is TrashKind {
  return typeof v === 'string' && (TRASH_KINDS as readonly string[]).includes(v)
}

/** 種類ごとの本体の表 */
export const TRASH_KIND_TABLE: Record<TrashKind, ContentTableName> = {
  title: 'titles',
  chapter: 'chapters',
  piece: 'pieces',
  version: 'versions',
  memo: 'memos',
  idea: 'ideas',
  settingCategory: 'settingCategories',
  settingEntry: 'settingEntries',
  submission: 'submissions',
  proofSuggestion: 'proofSuggestions',
  revisionIdea: 'revisionIdeas',
  strategyNote: 'strategyNotes',
  critiquePrompt: 'critiquePrompts',
  critiqueResult: 'critiqueResults',
}

export const TRASH_KIND_LABELS: Record<TrashKind, string> = {
  title: 'タイトル',
  chapter: '章',
  piece: '話',
  version: '推敲バージョン',
  memo: 'メモ',
  idea: 'アイデア',
  settingCategory: '設定項目',
  settingEntry: '設定エントリ',
  submission: '応募計画',
  proofSuggestion: '推敲案',
  revisionIdea: '改稿案',
  strategyNote: '戦略メモ',
  critiquePrompt: '批評プロンプト',
  critiqueResult: '批評の結果',
}

/** 長い文章の最初の行（見出しが無い時の名前。長ければ切る） */
function firstLine(text: string, max = 24): string {
  const line =
    text
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line
}

/** 一覧に出す名前（画面の表記と同じ。空なら「無題の…」） */
export const trashLabel = {
  title: (t: Pick<Title, 'name'>) => t.name.trim() || '無題のタイトル',
  chapter: (c: Pick<Chapter, 'name'>) => c.name.trim() || '無題の章',
  version: (v: Pick<Version, 'name'>) => v.name.trim() || '（無題の稿）',
  memo: (m: Pick<Memo, 'name'>) => m.name.trim() || '無題のメモ',
  /** 見出し、なければ内容の最初の行（長ければ切る） */
  idea: (i: Pick<Idea, 'heading' | 'body'>) => {
    const line =
      i.heading.trim() ||
      (i.body
        .split(/\r\n?|\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ??
        '')
    const chars = Array.from(line)
    return (chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : line) || '（空のアイデア）'
  },
  category: (c: Pick<SettingCategory, 'name'>) => c.name.trim() || '無題の設定項目',
  entry: (e: Pick<SettingEntry, 'name'>) => e.name.trim() || '（名前未設定）',
  submission: (s: Pick<Submission, 'contestName'>) => s.contestName.trim() || '（コンテスト名未設定）',
  /** 「見れる」→「見られる」のような表記（抜き出した箇所と直し方） */
  proofSuggestion: (p: Pick<ProofSuggestion, 'excerpt' | 'suggestion'>) => {
    const ex = firstLine(p.excerpt, 16)
    const sug = firstLine(p.suggestion, 16)
    return (ex ? `「${ex}」${sug ? `→「${sug}」` : ''}` : sug) || '（空の推敲案）'
  },
  /** 「チェック済みを削除」でまとめて削除した推敲案 */
  proofSuggestions: (n: number) => `チェック済みの推敲案（${n}件）`,
  revisionIdea: (r: Pick<RevisionIdea, 'heading' | 'body'>) => r.heading.trim() || firstLine(r.body) || '（空の改稿案）',
  strategyNote: (n: Pick<StrategyNote, 'heading' | 'runDate'>) => n.heading.trim() || `戦略メモ（${n.runDate}）`,
  critiquePrompt: (p: Pick<CritiquePrompt, 'name'>) => p.name.trim() || '無題の批評プロンプト',
  critiqueResult: (r: Pick<CritiqueResult, 'promptName' | 'runDate'>) =>
    `${r.runDate ? `${r.runDate} ` : ''}${r.promptName.trim() || '作品批評'}の結果`,
}

/** 同じ id のものが残っていて複製として戻した稿の名前に付ける */
export const RESTORED_COPY_SUFFIX = '（ゴミ箱から復元）'

// ---------- ゴミ箱へ入れる ----------

export interface TrashSpec {
  kind: TrashKind
  label: string
  titleName: string
  parentLabel?: string
  origin: TrashOrigin
  /** 中身。先頭が削除したもの本体 */
  records: { table: ContentTableName; record: ContentRecord }[]
  reason?: TrashEntry['reason']
  at?: number
}

/**
 * レコードをゴミ箱の1件にまとめて入れ、元の表から消す。親からの参照（並び）は呼び出し側で外す。
 * 応募時の原稿の控え（snapshotTexts）は他の応募記録と共有されていることがあるので、写しを取るだけで消さない
 * （呼び出し側で使われなくなった控えを片付ける）。
 */
export function putInTrash(tx: Tx, spec: TrashSpec): ID {
  const ts = spec.at ?? now()
  const entryId = newId()
  const recordIds: ID[] = []
  const seen = new Set<string>()
  for (const { table, record } of spec.records) {
    const key = `${table}:${record.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const trashRecord: TrashRecord = { id: newId(), entryId, table, record, createdAt: ts, updatedAt: ts }
    tx.put('trashRecords', trashRecord)
    recordIds.push(trashRecord.id)
    if (table !== 'snapshotTexts') tx.delete(table, record.id)
  }
  const entry: TrashEntry = {
    id: entryId,
    kind: spec.kind,
    label: spec.label,
    titleName: spec.titleName,
    ...(spec.parentLabel ? { parentLabel: spec.parentLabel } : {}),
    origin: spec.origin,
    recordIds,
    reason: spec.reason ?? 'deleted',
    deletedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }
  tx.put('trashEntries', entry)
  return entryId
}

/** order で並ぶ一覧（peers）の中での場所。index には order の値を控える（戻す時に、間の要素が欠けていても順番を保てる） */
export function orderOrigin(peers: { id: ID; order: number }[], id: ID): Pick<TrashOrigin, 'index' | 'prevId'> {
  const sorted = [...peers].sort(byOrder)
  const i = sorted.findIndex((r) => r.id === id)
  if (i < 0) return { index: nextOrder(sorted), prevId: sorted.at(-1)?.id ?? null }
  return { index: sorted[i].order, prevId: i > 0 ? sorted[i - 1].id : null }
}

/** 話の場所（入っていた章・その並びの中の位置・直前の要素）。直前の要素はタイトル直下なら章のこともある */
export function pieceOrigin(data: AppData, pieceId: ID): TrashOrigin {
  const piece = data.pieces[pieceId]
  const title = data.titles[piece.titleId]
  const slot = locatePiece(data, pieceId)
  if (!title || !slot) return { titleId: piece.titleId, chapterId: null, index: title?.structure.length ?? 0, prevId: null }
  const prevId =
    slot.index === 0
      ? null
      : slot.chapterId
        ? (data.chapters[slot.chapterId]?.pieceIds[slot.index - 1] ?? null)
        : (title.structure[slot.index - 1]?.id ?? null)
  return { titleId: piece.titleId, chapterId: slot.chapterId, index: slot.index, prevId }
}

// ---------- 一覧 ----------

/** 新しく削除したものから順に */
export function listTrash(entries: AppData['trashEntries']): TrashEntry[] {
  return Object.values(entries).sort((a, b) => b.deletedAt - a.deletedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

/** 完全に削除される日時 */
export function trashExpiresAt(entry: Pick<TrashEntry, 'deletedAt'>): number {
  return entry.deletedAt + TRASH_RETENTION_MS
}

/** 削除してから30日たった（この時点で完全に削除する） */
export function isTrashExpired(entry: Pick<TrashEntry, 'deletedAt'>, nowTs: number): boolean {
  return nowTs >= trashExpiresAt(entry)
}

/** 完全に削除されるまでの残り日数（切り上げ。1日未満でも「あと1日」。端末の時計が戻っていても30日を超えない） */
export function trashDaysLeft(entry: Pick<TrashEntry, 'deletedAt'>, nowTs: number): number {
  const left = trashExpiresAt(entry) - nowTs
  if (left <= 0) return 0
  return Math.min(TRASH_RETENTION_DAYS, Math.ceil(left / DAY_MS))
}

/** 1件の中身（recordIds の順。載っていないが同じ件に属するものは後ろに付ける） */
export function trashContents(data: AppData, entry: TrashEntry): TrashRecord[] {
  const out: TrashRecord[] = []
  const seen = new Set<ID>()
  for (const id of entry.recordIds) {
    const r = data.trashRecords[id]
    if (!r || r.entryId !== entry.id || seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  for (const r of Object.values(data.trashRecords)) {
    if (r.entryId === entry.id && !seen.has(r.id)) {
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

/** 本体のレコード（一覧で特殊ブロックかどうかなどを見る用） */
export function trashMainRecord(data: AppData, entry: TrashEntry): TrashRecord | undefined {
  const r = data.trashRecords[entry.recordIds[0]]
  return r && r.entryId === entry.id ? r : undefined
}

// ---------- 完全に削除 ----------

function removeEntries(tx: Tx, ids: Set<ID>): void {
  if (ids.size === 0) return
  for (const id of ids) {
    const entry = tx.get('trashEntries', id)
    for (const rid of entry?.recordIds ?? []) {
      if (tx.get('trashRecords', rid)?.entryId === id) tx.delete('trashRecords', rid)
    }
    tx.delete('trashEntries', id)
  }
  for (const r of tx.all('trashRecords')) if (ids.has(r.entryId)) tx.delete('trashRecords', r.id)
}

/** ゴミ箱の1件を中身ごと完全に削除する（もう無ければ何もしない） */
export function deleteTrashEntry(data: AppData, entryId: ID): AppData {
  if (!data.trashEntries[entryId]) return data
  return transact(data, (tx) => removeEntries(tx, new Set([entryId]))).data
}

/** ゴミ箱を空にする */
export function emptyTrash(data: AppData): AppData {
  if (Object.keys(data.trashEntries).length === 0 && Object.keys(data.trashRecords).length === 0) return data
  return transact(data, (tx) => {
    for (const e of tx.all('trashEntries')) tx.delete('trashEntries', e.id)
    for (const r of tx.all('trashRecords')) tx.delete('trashRecords', r.id)
  }).data
}

/**
 * 削除してから30日たったものを中身ごと完全に削除する。消すものがなければ data をそのまま返す。
 * 同期中は件（entry）より中身が先に届くことがあるので、件のない中身はここでは消さない。
 */
export function purgeExpiredTrash(data: AppData, nowTs: number): AppData {
  const expired = new Set(
    Object.values(data.trashEntries)
      .filter((e) => isTrashExpired(e, nowTs))
      .map((e) => e.id),
  )
  if (expired.size === 0) return data
  return transact(data, (tx) => removeEntries(tx, expired)).data
}

// ---------- 元に戻す ----------

export interface RestoreResult {
  entryId: ID
  kind: TrashKind
  label: string
  /** 戻したもの本体の id（複製として戻した時は新しい id） */
  id: ID
  /** 戻したものが属するタイトル（タイトル自体ならその id。どのタイトルにも属さないアイデアは null） */
  titleId: ID | null
  /** 同じ id のものが残っていたので、新しい id の複製として戻した */
  copied: boolean
  /** 元のタイトルがなかったので「どのタイトルにも属さない」へ戻した（アイデアのみ） */
  movedToUnassigned: boolean
  /** 戻す先に同じ名前の稿があったので名前を変えて戻した稿の、新しい名前（「第3稿（復元）」。稿のみ。無ければ空） */
  renamed: string[]
}

/** 控えた位置が分かるか（負の値や数でないものは「分からない」。修復で補った件など） */
const knownIndex = (origin: TrashOrigin) => Number.isFinite(origin.index) && origin.index >= 0

/**
 * 稿を戻す先の話・幕と、稿の元の話・幕から移して戻すか（moved）。
 * 1. 稿の話・幕（ふつうはこれ）
 * 2. 控えた場所（origin.pieceId。幕をつないだ・セパレートを解除した時の、つないだ先の幕・話）
 * 3. 幕の稿だった時は、その幕の属していた話（origin.parentId）。幕がつないだ・解除したことで無くなっていても戻せるように。
 *    話をまだ幕に分けていれば最初の幕へ（つなぐと前の幕が本文を引き継ぐので、最初の幕はいつも残っている）
 */
function versionTarget(tx: Tx, v: Version, origin: TrashOrigin | undefined): { piece: Piece; moved: boolean } | undefined {
  const own = tx.get('pieces', v.pieceId)
  if (own) return { piece: own, moved: false }
  const at = origin?.pieceId ? tx.get('pieces', origin.pieceId) : undefined
  if (at) return { piece: at, moved: true }
  const parent = origin?.parentId ? tx.get('pieces', origin.parentId) : undefined
  if (!parent || parent.kind !== 'episode') return undefined
  if (!isSplit(parent)) return { piece: parent, moved: true }
  const first = actsOf(tx.data, parent)[0]
  return first ? { piece: first, moved: true } : undefined
}

/** 戻す先（親）が残っているか。なければ何を先に戻せばよいかを伝える */
function requireParents(tx: Tx, kind: TrashKind, record: ContentRecord, origin?: TrashOrigin): void {
  const titleOf = (titleId: ID | null | undefined) => {
    if (!titleId || !tx.get('titles', titleId))
      throw new DomainError('元のタイトルがないため戻せません。先にタイトルを戻してください。')
  }
  switch (kind) {
    case 'title':
    case 'idea':
      return
    case 'chapter':
    case 'memo':
    case 'settingCategory':
    case 'submission':
      titleOf((record as { titleId: ID }).titleId)
      return
    case 'piece': {
      const p = record as Piece
      titleOf(p.titleId)
      // 幕（古い版の端末が第n話として削除した幕も parentId を持つ）は、属する話を今も幕に分けている時だけ幕として戻す
      if (isActRecord(p)) {
        const parent = tx.get('pieces', p.parentId as ID)
        if (!parent || parent.kind !== 'episode') throw new DomainError('元の話がないため戻せません。先に話を戻してください。')
        if (!isSplit(parent)) {
          throw new DomainError('元の話のセパレートを解除しているため、幕として戻せません。話をまた幕に分けると戻せます。')
        }
      }
      return
    }
    case 'version': {
      const v = record as Version
      const piece = versionTarget(tx, v, origin)?.piece
      if (!piece) {
        // タイトルごと消えているなら、タイトルを戻せば話も戻る
        if (!tx.get('titles', v.titleId)) titleOf(v.titleId)
        throw new DomainError('元の話がないため戻せません。先に話を戻してください。')
      }
      // 幕に分けた話の稿は、セパレートを解除するまで変えられない
      if (isSplit(piece)) throw new DomainError('元の話を幕に分けているため戻せません。先にセパレートを解除してください。')
      return
    }
    case 'settingEntry': {
      const e = record as SettingEntry
      if (!tx.get('settingCategories', e.categoryId)) {
        if (!tx.get('titles', e.titleId)) titleOf(e.titleId)
        throw new DomainError('元の設定項目がないため戻せません。先に設定項目を戻してください。')
      }
      return
    }
    case 'proofSuggestion':
    case 'revisionIdea':
    case 'strategyNote':
    case 'critiqueResult':
      titleOf((record as { titleId: ID }).titleId)
      return
    case 'critiquePrompt': {
      // 共通の批評プロンプト（titleId = null）は、どのタイトルにも属さない
      const p = record as CritiquePrompt
      if (p.titleId !== null) titleOf(p.titleId)
      return
    }
  }
}

/** 複製として戻すレコードの id を付け替えた時に、中身の参照も付け替える */
function rewriteRefs(table: ContentTableName, record: ContentRecord, ids: Map<ID, ID>, texts: Map<ID, ID>): ContentRecord {
  const m = (id: ID) => ids.get(id) ?? id
  const mn = (id: ID | null) => (id === null ? null : m(id))
  const list = (v: ID[]) => (Array.isArray(v) ? v.map(m) : v)
  switch (table) {
    case 'titles': {
      const r = record as Title
      return {
        ...r,
        id: m(r.id),
        structure: Array.isArray(r.structure) ? r.structure.map((n): NodeRef => ({ ...n, id: m(n.id) })) : r.structure,
      }
    }
    case 'chapters': {
      const r = record as Chapter
      return { ...r, id: m(r.id), titleId: m(r.titleId), pieceIds: list(r.pieceIds) }
    }
    case 'pieces': {
      const r = record as Piece
      const out: Piece = {
        ...r,
        id: m(r.id),
        titleId: m(r.titleId),
        activeVersionId: mn(r.activeVersionId),
        versionIds: list(r.versionIds),
      }
      // 幕の属する話と、幕に分けた話の幕の並び
      if (typeof r.parentId === 'string') out.parentId = m(r.parentId)
      if (Array.isArray(r.actIds)) out.actIds = list(r.actIds)
      return out
    }
    case 'versions': {
      const r = record as Version
      return { ...r, id: m(r.id), titleId: m(r.titleId), pieceId: m(r.pieceId), sourceVersionId: mn(r.sourceVersionId) }
    }
    case 'memos': {
      const r = record as Memo
      return { ...r, id: m(r.id), titleId: m(r.titleId) }
    }
    case 'ideas': {
      const r = record as Idea
      return { ...r, id: m(r.id), titleId: mn(r.titleId) }
    }
    case 'settingCategories': {
      const r = record as SettingCategory
      return { ...r, id: m(r.id), titleId: m(r.titleId) }
    }
    case 'settingEntries': {
      const r = record as SettingEntry
      return { ...r, id: m(r.id), titleId: m(r.titleId), categoryId: m(r.categoryId) }
    }
    case 'submissions': {
      const r = record as Submission
      return { ...r, id: m(r.id), titleId: m(r.titleId), snapshot: rewriteSnapshot(r.snapshot, m, texts) }
    }
    case 'snapshotTexts':
      return record
    case 'proofSuggestions': {
      const r = record as ProofSuggestion
      return {
        ...r,
        id: m(r.id),
        titleId: m(r.titleId),
        pieceId: m(r.pieceId),
        parentId: mn(r.parentId ?? null),
        versionId: mn(r.versionId ?? null),
        batchId: mn(r.batchId ?? null),
      }
    }
    case 'proofBatches': {
      const r = record as ProofBatch
      return {
        ...r,
        id: m(r.id),
        titleId: m(r.titleId),
        covered: Array.isArray(r.covered)
          ? r.covered.map((c) => ({ ...c, pieceId: m(c.pieceId), versionId: mn(c.versionId ?? null) }))
          : r.covered,
        itemIds: list(r.itemIds),
      }
    }
    case 'revisionIdeas': {
      const r = record as RevisionIdea
      return { ...r, id: m(r.id), titleId: m(r.titleId), pieceIds: list(r.pieceIds) }
    }
    case 'strategyNotes': {
      const r = record as StrategyNote
      return {
        ...r,
        id: m(r.id),
        titleId: m(r.titleId),
        contests: Array.isArray(r.contests)
          ? r.contests.map((c) => ({ ...c, submissionId: mn(c.submissionId ?? null) }))
          : r.contests,
      }
    }
    case 'critiquePrompts': {
      const r = record as CritiquePrompt
      return { ...r, id: m(r.id), titleId: mn(r.titleId) }
    }
    case 'critiqueResults': {
      const r = record as CritiqueResult
      const scope =
        r.scope && r.scope.kind === 'range'
          ? { ...r.scope, fromPieceId: m(r.scope.fromPieceId), toPieceId: m(r.scope.toPieceId) }
          : r.scope
      return { ...r, id: m(r.id), titleId: m(r.titleId), promptId: mn(r.promptId ?? null), scope }
    }
  }
}

function rewriteSnapshot(s: SubmissionSnapshot | null, m: (id: ID) => ID, texts: Map<ID, ID>): SubmissionSnapshot | null {
  if (!s || typeof s !== 'object') return s
  const out: SubmissionSnapshot = {
    ...s,
    activeVersions: Object.fromEntries(
      Object.entries(s.activeVersions ?? {}).map(([pid, vid]) => [m(pid), vid === null ? null : m(vid)]),
    ),
  }
  if (Array.isArray(s.order)) out.order = s.order.map(m)
  if (s.pieces) {
    out.pieces = Object.fromEntries(
      Object.entries(s.pieces).map(([pid, p]) => [
        m(pid),
        {
          ...p,
          versionId: p.versionId === null ? null : m(p.versionId),
          textKey: p.textKey ? (texts.get(p.textKey) ?? p.textKey) : p.textKey,
        },
      ]),
    )
  }
  return out
}

/**
 * 応募時の原稿の控えを戻す。控えは内容から作ったキーなので、同じキーで同じ本文が残っていればそれを使う。
 * 万一同じキーで別の本文があれば、別のキーで戻して参照を付け替える。
 */
function restoreSnapshotText(tx: Tx, text: SnapshotText, texts: Map<ID, ID>): void {
  const live = tx.get('snapshotTexts', text.id)
  if (!live) {
    tx.put('snapshotTexts', text)
    return
  }
  if (live.body === text.body) return
  for (let n = 1; ; n++) {
    const key = `${text.id}-r${n}`
    const other = tx.get('snapshotTexts', key)
    if (other && other.body !== text.body) continue
    if (!other) tx.put('snapshotTexts', { ...text, id: key })
    texts.set(text.id, key)
    return
  }
}

/**
 * 並び list の中の差し込み位置。先頭にあった（prevId = null）なら先頭、直前にあった要素がまだあればその直後、
 * なければ控えた位置（範囲内に収める。分からなければ末尾）
 */
function insertIndex(list: readonly ID[], origin: TrashOrigin): number {
  if (origin.prevId === null) return 0
  const prev = origin.prevId ? list.indexOf(origin.prevId) : -1
  if (prev >= 0) return prev + 1
  return knownIndex(origin) ? Math.min(origin.index, list.length) : list.length
}

type OrderedTable =
  | 'titles'
  | 'memos'
  | 'ideas'
  | 'settingCategories'
  | 'settingEntries'
  | 'submissions'
  | 'revisionIdeas'
  | 'critiquePrompts'

/**
 * order で並ぶ一覧へ戻す。先頭にあった（prevId = null）なら先頭、直前にあった要素がまだあればその直後、
 * なければ削除した時の order の値の位置（その値より大きい最初の要素の前）。並びは 0..n-1 に詰め直し、変わったものだけ書く。
 */
function placeInOrder<T extends OrderedTable>(
  tx: Tx,
  table: T,
  id: ID,
  isPeer: (r: AppData[T][string]) => boolean,
  origin: TrashOrigin,
): void {
  const self = tx.get(table, id)
  if (!self) return
  const list = (tx.all(table) as AppData[T][string][]).filter((r) => r.id !== id && isPeer(r)).sort(byOrder)
  const prev = origin.prevId ? list.findIndex((r) => r.id === origin.prevId) : -1
  let at: number
  if (origin.prevId === null) at = 0
  else if (prev >= 0) at = prev + 1
  else {
    const key = knownIndex(origin) ? origin.index : self.order
    at = list.findIndex((r) => r.order > key)
    if (at < 0) at = list.length
  }
  list.splice(at, 0, self)
  const ts = now()
  list.forEach((r, i) => {
    if (r.order !== i) tx.put(table, { ...r, order: i, updatedAt: ts } as AppData[T][string])
  })
}

function touchTitle(tx: Tx, titleId: ID, patch: Partial<Title> = {}): void {
  const t = tx.get('titles', titleId)
  if (t) tx.put('titles', { ...t, ...patch, updatedAt: now() })
}

/** 話を元の章・位置へ戻す。元の章がもう無ければ、直前にあった話の後ろ（それも無ければタイトル直下の末尾） */
function relinkPiece(tx: Tx, piece: Piece, origin: TrashOrigin): void {
  const title = tx.get('titles', piece.titleId)
  // 幕は本編の並びに載らない（話といっしょに戻り、話の幕の並びに入っている）
  if (!title || piece.kind === 'act' || locatePiece(tx.data, piece.id)) return
  const node: NodeRef = { type: 'piece', id: piece.id }
  const ts = now()
  const ch = origin.chapterId ? tx.get('chapters', origin.chapterId) : undefined
  const inStructure = ch && ch.titleId === title.id && title.structure.some((n) => n.type === 'chapter' && n.id === ch.id)
  if (ch && inStructure) {
    const pieceIds = [...ch.pieceIds]
    pieceIds.splice(insertIndex(pieceIds, origin), 0, piece.id)
    tx.put('chapters', { ...ch, pieceIds, updatedAt: ts })
    touchTitle(tx, title.id)
    return
  }
  const structure = [...title.structure]
  if (!origin.chapterId) {
    structure.splice(
      insertIndex(
        structure.map((n) => n.id),
        origin,
      ),
      0,
      node,
    )
    touchTitle(tx, title.id, { structure })
    return
  }
  const prev = origin.prevId && tx.get('pieces', origin.prevId) ? locatePiece(tx.data, origin.prevId) : null
  if (prev?.chapterId) {
    const prevChapter = tx.get('chapters', prev.chapterId)!
    const pieceIds = [...prevChapter.pieceIds]
    pieceIds.splice(prev.index + 1, 0, piece.id)
    tx.put('chapters', { ...prevChapter, pieceIds, updatedAt: ts })
    touchTitle(tx, title.id)
    return
  }
  structure.splice(prev ? prev.index + 1 : structure.length, 0, node)
  touchTitle(tx, title.id, { structure })
}

/**
 * 解除した章を元の位置に作り直す。章に入っていた話のうち、今もタイトル直下にあるものを元の並び順で章へ戻す
 * （別の章へ移したもの・削除したものはそのまま）。
 */
function relinkChapter(tx: Tx, chapter: Chapter, origin: TrashOrigin): void {
  const title = tx.get('titles', chapter.titleId)
  if (!title || title.structure.some((n) => n.type === 'chapter' && n.id === chapter.id)) return
  const loose = new Set(title.structure.filter((n) => n.type === 'piece').map((n) => n.id))
  const former = Array.isArray(chapter.pieceIds) ? chapter.pieceIds : []
  const pieceIds = former.filter(
    (pid, i) => loose.has(pid) && tx.get('pieces', pid)?.titleId === title.id && former.indexOf(pid) === i,
  )
  const reclaimed = new Set(pieceIds)
  const structure = title.structure.filter((n) => !(n.type === 'piece' && reclaimed.has(n.id)))
  structure.splice(
    insertIndex(
      structure.map((n) => n.id),
      origin,
    ),
    0,
    { type: 'chapter', id: chapter.id },
  )
  const same = pieceIds.length === former.length && pieceIds.every((id, i) => former[i] === id)
  if (!same) tx.put('chapters', { ...chapter, pieceIds, updatedAt: now() })
  touchTitle(tx, title.id, { structure })
}

/**
 * 稿を元の話の元の位置へ戻す。採用中だった稿は、その話に今は採用している稿がなければ採用に戻す。
 * 消えた幕の稿は、控えた場所（つないだ先の幕・話）の稿として戻す。元の話・幕から移して戻す稿は採用しない
 * （つないだ本文の採用稿などを、戻した稿が黙って入れ替えないように）
 */
function relinkVersion(tx: Tx, version: Version, origin: TrashOrigin): void {
  const target = versionTarget(tx, version, origin)
  if (!target) return
  const { piece, moved } = target
  if (version.titleId !== piece.titleId || version.pieceId !== piece.id) {
    tx.put('versions', { ...version, pieceId: piece.id, titleId: piece.titleId })
  }
  const versionIds = [...piece.versionIds]
  if (!versionIds.includes(version.id)) versionIds.splice(insertIndex(versionIds, origin), 0, version.id)
  const hasActive = piece.activeVersionId !== null && Boolean(tx.get('versions', piece.activeVersionId))
  const activeVersionId = origin.wasActive && !moved && !hasActive ? version.id : piece.activeVersionId
  // 古い版のアプリは versionSeq + 1 で「第n稿」の名前を付けるので、稿の数より小さくしない（この版の名前は今ある稿から決める）
  const versionSeq = Math.max(piece.versionSeq, versionIds.length)
  tx.put('pieces', { ...piece, versionIds, activeVersionId, versionSeq, updatedAt: now() })
}

/**
 * 戻した稿（ids。戻した順）と同じ名前の稿が、戻した先の話・幕にもうあれば「第3稿（復元）」のように名前を変える
 * （稿の名前が重ならないように。「第n稿」の番号は今ある稿の名前から決めるので、削除した後に同じ名前の稿ができていることがある）。
 * 同じ件で一緒に戻した稿は、先に戻した稿だけと比べる。戻り値は名前を変えた稿の新しい名前（戻した順）
 */
function keepVersionNamesUnique(tx: Tx, ids: readonly ID[]): string[] {
  const renamed: string[] = []
  const pending = new Set(ids)
  for (const id of ids) {
    pending.delete(id)
    const v = tx.get('versions', id)
    const piece = v ? tx.get('pieces', v.pieceId) : undefined
    if (!v || !piece) continue
    const taken = new Set(
      pieceVersions(tx.data, piece)
        .filter((x) => x.id !== id && !pending.has(x.id))
        .map((x) => x.name),
    )
    const name = restoredVersionName(v.name, taken)
    if (name === v.name) continue
    tx.put('versions', { ...v, name })
    renamed.push(name)
  }
  return renamed
}

/** 幕のレコードか（古い版の端末は幕を第n話として書くことがあるので、属する話 parentId で見る） */
function isActRecord(p: Piece): boolean {
  return p.kind === 'act' || (p.kind !== 'special' && typeof p.parentId === 'string')
}

/**
 * 幕を、属する話の幕の並びへ戻す（古い版の端末が第n話として削除した幕は、幕に直す）。
 * 並びに載っていなければ（複製として戻した時など）、作られた順の位置へ入れる
 */
function relinkAct(tx: Tx, restored: Piece): void {
  const act: Piece = restored.kind === 'act' ? restored : { ...restored, kind: 'act' }
  if (act !== restored) tx.put('pieces', act)
  const parent = typeof act.parentId === 'string' ? tx.get('pieces', act.parentId) : undefined
  if (!parent || !isSplit(parent) || parent.actIds!.includes(act.id)) return
  const ids = [...parent.actIds!]
  const later = actsOf(tx.data, parent).find((a) => a.id !== act.id && a.createdAt > act.createdAt)
  ids.splice(later ? ids.indexOf(later.id) : ids.length, 0, act.id)
  tx.put('pieces', { ...parent, actIds: ids, updatedAt: now() })
}

/**
 * ゴミ箱の1件を元の場所へ戻し、ゴミ箱から消す。
 * - 親（タイトル・話・設定項目）がもう無ければ DomainError（先に親を戻すよう伝える）
 * - 同じ id のものが残っていれば上書きせず、新しい id の複製として戻す（稿は名前に「（ゴミ箱から復元）」を付ける）
 * - 稿は、戻す先の話・幕に同じ名前の稿が今あれば「（復元）」「（復元2）」…を付けて戻す
 * - アイデアは元のタイトルが無ければ「どのタイトルにも属さない」へ戻す（タイトルを消した時と同じ扱い）
 */
export function restoreTrashEntry(data: AppData, entryId: ID): { data: AppData; result: RestoreResult } {
  const entry = data.trashEntries[entryId]
  if (!entry) throw new DomainError('ゴミ箱に見つかりません。すでに元に戻したか、完全に削除されています。')
  const contents = trashContents(data, entry)
  const main = contents[0]
  if (!main || main.table !== TRASH_KIND_TABLE[entry.kind] || !main.record || typeof main.record.id !== 'string') {
    throw new DomainError('ゴミ箱の中身が見つからないため戻せません。')
  }
  return transact(data, (tx) => {
    requireParents(tx, entry.kind, main.record, entry.origin)

    // 同じ id のものが残っていれば新しい id を振る（残っている方は上書きしない）
    const ids = new Map<ID, ID>()
    const texts = new Map<ID, ID>()
    const seen = new Set<string>()
    const items: { table: ContentTableName; record: ContentRecord }[] = []
    for (const r of contents) {
      if (!isContentTable(r.table) || !r.record || typeof r.record.id !== 'string') continue
      const key = `${r.table}:${r.record.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (r.table === 'snapshotTexts') {
        restoreSnapshotText(tx, r.record as SnapshotText, texts)
        continue
      }
      // 推敲案・推敲案の実行の記録は内容から作った id なので、同じ id が残っていれば同じ提案（もう一度足された）。複製は作らない
      if ((r.table === 'proofSuggestions' || r.table === 'proofBatches') && tx.get(r.table, r.record.id)) continue
      if (tx.get(r.table, r.record.id)) ids.set(r.record.id, newId())
      items.push({ table: r.table, record: r.record })
    }
    const remap = ids.size > 0 || texts.size > 0
    for (const item of items) {
      let record = remap ? rewriteRefs(item.table, item.record, ids, texts) : item.record
      if (item.table === 'versions' && ids.has(item.record.id)) {
        const v = record as Version
        record = { ...v, name: `${v.name.trim() || '無題の稿'}${RESTORED_COPY_SUFFIX}` }
      }
      tx.put(item.table, record)
    }

    const mainId = ids.get(main.record.id) ?? main.record.id
    const restored = tx.get(main.table, mainId)!
    const origin = entry.origin ?? { titleId: null, index: -1 }
    let titleId: ID | null = null
    let movedToUnassigned = false
    let renamed: string[] = []
    switch (entry.kind) {
      case 'title':
        titleId = mainId
        placeInOrder(tx, 'titles', mainId, () => true, origin)
        break
      case 'chapter': {
        const c = restored as Chapter
        titleId = c.titleId
        relinkChapter(tx, c, origin)
        break
      }
      case 'piece': {
        const p = restored as Piece
        titleId = p.titleId
        if (isActRecord(p)) relinkAct(tx, p)
        else relinkPiece(tx, p, origin)
        break
      }
      case 'version': {
        const v = restored as Version
        titleId = versionTarget(tx, v, origin)?.piece.titleId ?? v.titleId
        relinkVersion(tx, v, origin)
        // 1件に複数の稿があることがある（幕をつないだ・セパレートを解除した時の、採用していなかった稿）。
        // 残りは本体の後ろに、もとの順で並べる
        const restoredIds = [v.id]
        let prevId = v.id
        for (const item of items) {
          if (item.table !== 'versions' || item.record.id === main.record.id) continue
          const id = ids.get(item.record.id) ?? item.record.id
          const other = tx.get('versions', id)
          if (!other) continue
          relinkVersion(tx, other, { ...origin, index: -1, prevId, wasActive: false })
          restoredIds.push(id)
          prevId = id
        }
        renamed = keepVersionNamesUnique(tx, restoredIds)
        break
      }
      case 'memo': {
        const m = restored as Memo
        titleId = m.titleId
        placeInOrder(tx, 'memos', mainId, (x) => x.titleId === m.titleId, origin)
        break
      }
      case 'idea': {
        const i = restored as Idea
        if (i.titleId !== null && !tx.get('titles', i.titleId)) {
          // 元のタイトルがない: タイトルを消した時と同じく「どのタイトルにも属さない」の末尾へ
          const order = nextOrder(tx.all('ideas').filter((x) => x.id !== i.id && x.titleId === null))
          tx.put('ideas', { ...i, titleId: null, order, updatedAt: now() })
          movedToUnassigned = true
        } else {
          titleId = i.titleId
          placeInOrder(tx, 'ideas', mainId, (x) => x.titleId === i.titleId, origin)
        }
        break
      }
      case 'settingCategory': {
        const c = restored as SettingCategory
        titleId = c.titleId
        placeInOrder(tx, 'settingCategories', mainId, (x) => x.titleId === c.titleId, origin)
        break
      }
      case 'settingEntry': {
        const e = restored as SettingEntry
        const cat = tx.get('settingCategories', e.categoryId)!
        titleId = cat.titleId
        if (e.titleId !== cat.titleId) tx.put('settingEntries', { ...e, titleId: cat.titleId })
        placeInOrder(tx, 'settingEntries', mainId, (x) => x.categoryId === e.categoryId, origin)
        break
      }
      case 'submission': {
        const s = restored as Submission
        titleId = s.titleId
        placeInOrder(tx, 'submissions', mainId, (x) => x.titleId === s.titleId, origin)
        break
      }
      case 'revisionIdea': {
        const r = restored as RevisionIdea
        titleId = r.titleId
        placeInOrder(tx, 'revisionIdeas', mainId, (x) => x.titleId === r.titleId, origin)
        break
      }
      case 'critiquePrompt': {
        const p = restored as CritiquePrompt
        titleId = p.titleId
        placeInOrder(tx, 'critiquePrompts', mainId, (x) => x.titleId === p.titleId, origin)
        break
      }
      // 推敲案（「チェック済みを削除」の時は複数）・戦略メモ・批評結果は日時で並ぶので、戻すだけ
      case 'proofSuggestion':
      case 'strategyNote':
      case 'critiqueResult':
        titleId = (restored as { titleId: ID }).titleId
        break
    }

    removeEntries(tx, new Set([entry.id]))
    return {
      entryId: entry.id,
      kind: entry.kind,
      label: entry.label,
      id: mainId,
      titleId,
      copied: ids.has(main.record.id),
      movedToUnassigned,
      renamed,
    }
  })
}
