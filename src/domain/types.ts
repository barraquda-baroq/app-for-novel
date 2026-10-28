// アプリ全体のデータモデル。
// 原稿の最小管理単位は「話（Piece）」で、Piece は 第n話（episode）か 特殊ブロック（special）か 幕（act）。
// 第n話の n は保存せず、タイトルの構成（structure / chapter.pieceIds）の並び順から常に導出する。
// これにより「話数の表記は変更できない」「ソート後は並び順どおりに話数が書き換わる」を構造的に保証する。
// 幕（2.2 セパレート）は採用した第n話を WEB 掲載用に分けたもの。話（parentId）の actIds の並びにだけ載り、
// structure・chapter.pieceIds には載らない。第x幕の x も保存せず、actIds の中の位置から導出する。

export type ID = string

/** タイトル直下の並び。章（フォルダ）か、章に属さない話/特殊ブロック */
export type NodeRef = { type: 'chapter'; id: ID } | { type: 'piece'; id: ID }

/** 話数の振り方。章が有効なときだけ意味を持つ（章が無効なら常に通し番号） */
export type NumberingMode = 'continuous' | 'perChapter'

export interface Title {
  id: ID
  name: string
  /** あらすじ・概要 */
  synopsis: string
  /** 大長編向けの章管理のオン/オフ */
  chaptersEnabled: boolean
  numbering: NumberingMode
  /** タイトル直下の並び順 */
  structure: NodeRef[]
  /** 全体の応募戦略メモ */
  strategyNote: string
  /** タイトル一覧での並び順 */
  order: number
  createdAt: number
  updatedAt: number
}

export interface Chapter {
  id: ID
  titleId: ID
  name: string
  note: string
  /** 章フォルダ内の並び順 */
  pieceIds: ID[]
  createdAt: number
  updatedAt: number
}

/** episode = 第n話、special = 特殊ブロック（プロローグ等）、act = 幕に分けた話の幕（第x幕） */
export type PieceKind = 'episode' | 'special' | 'act'

export interface Piece {
  id: ID
  titleId: ID
  kind: PieceKind
  /** 特殊ブロックの見出し（プロローグ等）。episode では使わない（第n話は導出） */
  label: string
  /** 話の題（第n話の下に付ける任意のサブタイトル） */
  subtitle: string
  /** 採用中（アクティブ）の推敲バージョン。null なら「採用原稿がありません」 */
  activeVersionId: ID | null
  /** 推敲バージョンの並び（作成順） */
  versionIds: ID[]
  /** 「第n稿」の自動命名用カウンタ（削除しても番号を再利用しない） */
  versionSeq: number
  /** 幕（kind 'act'）: 属する話（幕に分けた第n話）。それ以外は無い */
  parentId?: ID | null
  /**
   * 幕に分けた第n話: 幕の並び（読む順）。無い・空なら分けていない。
   * 分けている間、話の本文は各幕の採用稿をつないだもので、話自身の稿・採用は変えられない（セパレート解除まで）
   */
  actIds?: ID[]
  createdAt: number
  updatedAt: number
}

export interface Version {
  id: ID
  pieceId: ID
  titleId: ID
  name: string
  body: string
  /** 推敲メモ（この稿で何を変えたか等） */
  note: string
  /** 複製元のバージョン */
  sourceVersionId: ID | null
  createdAt: number
  updatedAt: number
}

export interface Memo {
  id: ID
  titleId: ID
  name: string
  body: string
  order: number
  createdAt: number
  updatedAt: number
}

export interface Idea {
  id: ID
  /** null = どのタイトルにも属さないアイデア */
  titleId: ID | null
  heading: string
  body: string
  order: number
  createdAt: number
  updatedAt: number
}

export interface SettingCategory {
  id: ID
  titleId: ID
  /** キャラクター・世界観など、ユーザーが任意に追加できる設定項目 */
  name: string
  /** この項目で新規エントリを作るときに用意するフィールド名 */
  fieldTemplate: string[]
  order: number
  createdAt: number
  updatedAt: number
}

export interface SettingField {
  id: ID
  key: string
  value: string
}

export interface SettingEntry {
  id: ID
  titleId: ID
  categoryId: ID
  name: string
  fields: SettingField[]
  body: string
  order: number
  createdAt: number
  updatedAt: number
}

export type SubmissionStatus = 'considering' | 'planned' | 'submitted' | 'reviewing' | 'passed' | 'won' | 'rejected' | 'withdrawn'

/** 応募時点の1話分の控え */
export interface SnapshotPiece {
  kind: PieceKind
  /** 当時の表記（第3話・プロローグ等） */
  label: string
  subtitle: string
  versionId: ID | null
  versionName: string | null
  chars: number
  /**
   * 当時の採用原稿の本文の控え（snapshotTexts のキー）。稿が後で編集・削除されても応募した原稿が残る。
   * 同じ本文は複数の応募記録で1つだけ保存される。採用原稿がなかった話は null。
   */
  textKey: ID | null
  /** 古い記録だけが持つ本文（読み込み時に snapshotTexts へ移す） */
  body?: string | null
  /** 本文の指紋（記録後に本文が変わったかの判定用） */
  hash: string
}

/** 応募時の原稿の本文（内容で重複をまとめて保存する） */
export interface SnapshotText {
  /** 内容から作ったキー */
  id: ID
  body: string
}

export interface SubmissionSnapshot {
  at: number
  /** 応募時点の採用原稿の総文字数（空白・改行を除く） */
  charCount: number
  /** pieceId -> 採用していた versionId */
  activeVersions: Record<ID, ID | null>
  /** 400字詰め原稿用紙換算の枚数（古い記録には無い） */
  pages?: number
  /** 読む順の pieceId（古い記録には無い） */
  order?: ID[]
  /** pieceId -> 当時の内容（古い記録には無い） */
  pieces?: Record<ID, SnapshotPiece>
}

/** 規定の単位。chars = 文字数（空白・改行除く）、pages = 400字詰め原稿用紙換算の枚数 */
export type LimitUnit = 'chars' | 'pages'

export interface Submission {
  id: ID
  titleId: ID
  /** 応募順 */
  order: number
  contestName: string
  organizer: string
  url: string
  /** yyyy-mm-dd（未定は空文字） */
  deadline: string
  submittedOn: string
  resultOn: string
  status: SubmissionStatus
  /** 選考段階の詳細（例: 二次選考通過） */
  stage: string
  /** コンテストの概要（対象ジャンル・賞典・選考方法など） */
  overview: string
  /** 規定（未設定は null）。単位は limitUnit（古いデータでは未設定 = 文字数） */
  minChars: number | null
  maxChars: number | null
  limitUnit?: LimitUnit
  /** 結果の詳細・講評 */
  result: string
  /** 結果を踏まえた改稿方針 */
  revisionPlan: string
  /** 再応募方針 */
  resubmissionPlan: string
  snapshot: SubmissionSnapshot | null
  createdAt: number
  updatedAt: number
}

/** ゴミ箱に入れたものの種類（戻し方が変わる） */
export type TrashKind =
  | 'title'
  | 'chapter'
  | 'piece'
  | 'version'
  | 'memo'
  | 'idea'
  | 'settingCategory'
  | 'settingEntry'
  | 'submission'

/** 削除した時点の場所。戻す時はここへ戻す（無くなっていれば近い所へ） */
export interface TrashOrigin {
  /** 属していたタイトル（タイトル自体と、どのタイトルにも属さないアイデアは null） */
  titleId: ID | null
  /** 章・話: 入っていた章（タイトル直下なら null） */
  chapterId?: ID | null
  /** 稿: 属していた話 */
  pieceId?: ID
  /**
   * 稿: 幕の稿だった時、その幕の属する話。幕がつないだ・セパレートを解除したことで無くなっていても、
   * 話（まだ分けていればその幕）へ戻せるように
   */
  parentId?: ID
  /** 設定エントリ: 属していた設定項目 */
  categoryId?: ID
  /** 並びの中の位置（structure・pieceIds・versionIds の添字、または order の値） */
  index: number
  /** 直前にあった要素の id（並びが変わっていても、その直後に戻せるように） */
  prevId?: ID | null
  /** 稿: 採用中だった */
  wasActive?: boolean
}

/**
 * ゴミ箱の1件（削除の単位）。話を削除したら、話とその稿がまとめて1件になる。
 * 中身のレコードは1件ずつ trashRecords に入れる（同期の時に1つの文書が大きくなりすぎないように）。
 * 30日たったら中身ごと消す。
 */
export interface TrashEntry {
  id: ID
  kind: TrashKind
  /** 一覧に出す名前（削除した時点の表記。例: 「第3話　旅立ち」「第2稿」） */
  label: string
  /** 削除した時点のタイトル名（タイトルが後で消えても一覧に出せるように） */
  titleName: string
  /**
   * 削除した時点の親の表記（稿なら属していた話の「第3話　旅立ち」、設定エントリなら設定項目名、章の中の話なら章名）。
   * 一覧で「どこにあったか」を出すためだけに使う（無くてもよい）
   */
  parentLabel?: string
  origin: TrashOrigin
  /** 中身（trashRecords の id）。先頭が削除したもの本体 */
  recordIds: ID[]
  /**
   * deleted = 利用者が削除した。
   * conflict = 同期の時、片方の端末で削除され、もう片方の端末で編集されていたので、編集された内容をここに残した
   * （中身は1件だけ。戻す時に同じ id が残っていれば、新しい id の複製として戻す）
   */
  reason: 'deleted' | 'conflict'
  deletedAt: number
  createdAt: number
  updatedAt: number
}

/** ゴミ箱の中身の1レコード（削除した時点の内容そのもの） */
export interface TrashRecord {
  id: ID
  entryId: ID
  /** 元の表 */
  table: ContentTableName
  /** 元のレコード（id もそのまま） */
  record: AppData[ContentTableName][string]
  createdAt: number
  updatedAt: number
}

export interface AppData {
  titles: Record<ID, Title>
  chapters: Record<ID, Chapter>
  pieces: Record<ID, Piece>
  versions: Record<ID, Version>
  memos: Record<ID, Memo>
  ideas: Record<ID, Idea>
  settingCategories: Record<ID, SettingCategory>
  settingEntries: Record<ID, SettingEntry>
  submissions: Record<ID, Submission>
  snapshotTexts: Record<ID, SnapshotText>
  trashEntries: Record<ID, TrashEntry>
  trashRecords: Record<ID, TrashRecord>
}

export type TableName = keyof AppData

/** ゴミ箱以外の表（ゴミ箱に入れられるレコードの表） */
export type ContentTableName = Exclude<TableName, 'trashEntries' | 'trashRecords'>

export const TABLE_NAMES: TableName[] = [
  'titles',
  'chapters',
  'pieces',
  'versions',
  'memos',
  'ideas',
  'settingCategories',
  'settingEntries',
  'submissions',
  'snapshotTexts',
  'trashEntries',
  'trashRecords',
]

export function emptyData(): AppData {
  return {
    titles: {},
    chapters: {},
    pieces: {},
    versions: {},
    memos: {},
    ideas: {},
    settingCategories: {},
    settingEntries: {},
    submissions: {},
    snapshotTexts: {},
    trashEntries: {},
    trashRecords: {},
  }
}

/** 本編の並びの中での位置。chapterId = null はタイトル直下 */
export interface Slot {
  chapterId: ID | null
  index: number
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
