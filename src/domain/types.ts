// アプリ全体のデータモデル。
// 原稿の最小管理単位は「話（Piece）」で、Piece は 第n話（episode）か 特殊ブロック（special）のどちらか。
// 第n話の n は保存せず、タイトルの構成（structure / chapter.pieceIds）の並び順から常に導出する。
// これにより「話数の表記は変更できない」「ソート後は並び順どおりに話数が書き換わる」を構造的に保証する。

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

export type PieceKind = 'episode' | 'special'

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
}

export type TableName = keyof AppData

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
