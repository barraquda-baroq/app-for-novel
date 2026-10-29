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
  /**
   * 2.3: Claude（コネクタ）に見せるか。none = 見せない、read = 読むだけ、write = 読む＋書き込む（推敲案などを足す）。
   * 無い = write（個人のアプリで、原稿を Claude に見てもらうのが前提のため。src/claude/visibility.ts）
   */
  claudeAccess?: ClaudeAccess
  createdAt: number
  updatedAt: number
}

/** タイトルを Claude に見せるか（Title.claudeAccess） */
export type ClaudeAccess = 'none' | 'read' | 'write'

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
  /**
   * 幕（2.2）: 分けた・つないだ時の元の稿（sourceVersionId）の本文の指紋（textHash）。同期で、元の稿が別の端末で
   * 書き換えられていたのに気付けるように（書き換える前の本文から分けた・つないだ稿は、その書き換えを含まない）
   */
  sourceHash?: string
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
  /**
   * 見出し（古い版で書いたもの）。今の版では入力欄がなく、新しいアイデアは空。
   * 空でないものは編集して保存した時に内容の1行目へまとめる（それまでは見出しとして表示する）
   */
  heading: string
  body: string
  /** 済み（実装した・没にした）。無い = 済みでない（古い版のアイデア）。済みにしたものは斜線＋グレーで仕切りの下へ沈む */
  checked?: boolean
  /** 済みにした日時（済みの並び: 新しく済みにしたものから）。済みでなければ null */
  checkedAt?: number | null
  /** 済みでないアイデアの並び順（済みのアイデアの並びには使わない） */
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

// ---------- 2.3: 推敲案・改稿案・戦略メモ・作品批評（Claude 連携） ----------
// どれもタイトルの配下の1レコード = 1文書（並びはタイトルの側に持たない。order か日時で並べる）。
// Claude（コネクタ）は新しく作るだけで、書き換え・削除はしない。作った後は端末のふつうのレコードとして編集・削除できる。
// id は Claude・貼り付けで作ったものは内容から作る（src/claude/derivedId.ts。同じ結果を2回足しても1つ）、手で作ったものは newId()。

/** 記録を作ったもの: claude = コネクタ、paste = 手動連携の貼り付け、manual = アプリで手で書いた */
export type ClaudeSource = 'claude' | 'paste' | 'manual'

/** 2.3 の記録に共通の項目 */
export interface ClaudeRecordBase {
  id: ID
  /** 記録の形の版（いまは 1）。これより新しい版は新しいコネクタ・アプリが書いたもの（「新しいコネクタの記録」と出す） */
  v: number
  source: ClaudeSource
  titleId: ID
  createdAt: number
  updatedAt: number
}

/**
 * 推敲案の種類。知らない値（新しいコネクタが書いた種類）も消さずに残し、categoryLabel で表示する
 * （一覧と日本語名は src/claude/categories.ts）
 */
export type ProofCategory =
  | 'typo'
  | 'ra_nuki'
  | 'i_nuki'
  | 'cliche'
  | 'tic'
  | 'repetition'
  | 'notation'
  | 'symbols'
  | 'ruby'
  | 'grammar'
  | 'other'

/** 推敲案の場所の控え（稿の本文の中の位置）。本文が変わったら excerpt を探し直す（src/claude/anchor.ts の reanchor） */
export interface ProofAnchor {
  /** 稿の本文（記法込みの生の本文）の中の位置（UTF-16） */
  offset: number
  /** excerpt が本文の中で占める長さ（UTF-16。ルビの記法を含む） */
  length: number
  /** 何段落目か（1から。空行は数えない） */
  paragraph: number
  /** 直前・直後の本文（最大20字。サロゲートペアの途中では切らない） */
  before: string
  after: string
  /** 見つけた時の稿の本文の指紋（hashJson(body)。違えば本文が変わった） */
  bodyHash: string
}

/** 推敲案（Claude のワードサーチなどの提案）。並びはフラグ → 新しい順、チェック済みは下へ */
export interface ProofSuggestion extends ClaudeRecordBase {
  /** 見つけた話・特殊ブロック・幕（幕に分けた話なら、excerpt を含む幕） */
  pieceId: ID
  /** pieceId が幕の時、幕の属する話（幕がつないだ・解除したことで無くなっても、話の本文で探し直せるように）。それ以外は null */
  parentId: ID | null
  /** 見つけた時の採用稿（見つからなかった・手で書いた時は null） */
  versionId: ID | null
  /** 作った時点の表記（「第12話　題　第2幕」。話が消えても場所が分かるように） */
  pieceLabel: string
  anchor: ProofAnchor | null
  category: ProofCategory
  /** 種類の日本語名（作った時点のもの。知らない種類でも表示できるように） */
  categoryLabel: string
  /** 本文から抜き出した箇所（記法込み・そのまま） */
  excerpt: string
  /** 直し方の案（無ければ空） */
  suggestion: string
  reason: string
  /** フラグ（常に一番上）。Claude が important としたものは最初から立つ */
  flagged: boolean
  /** チェック（消し込み）。チェックしたものは斜線＋グレーで下へ */
  done: boolean
  doneAt: number | null
  /** 実行（同じ名前・日付のワードサーチ。derivedId('run', …)）。手で書いたものは null */
  runId: ID | null
  /** 1回の追加（proofBatches）。手で書いたものは null */
  batchId: ID | null
  /** 提案したモデルの名前（分かれば） */
  model?: string
}

/** 推敲案の1回の追加（ワードサーチの実行の記録）。確かめた範囲を控え、「未確認 #41〜#300」を出すのに使う */
export interface ProofBatch extends ClaudeRecordBase {
  /** 実行（同じ名前・日付の追加をまとめる） */
  runId: ID
  /** 実行の名前（「ワードサーチ（第1〜20話）」。無ければ空） */
  runLabel: string
  /** 実行した日（日本時間の YYYY-MM-DD） */
  runDate: string
  /** この追加の推敲案の種類（重複なし） */
  categories: ProofCategory[]
  /** 確かめた話（推敲案が無かった話も含む）と、その時の採用原稿の指紋 */
  covered: ProofCovered[]
  /** この追加で作った推敲案 */
  itemIds: ID[]
  model?: string
}

export interface ProofCovered {
  pieceId: ID
  /** 確かめた時の採用稿（幕に分けた話は null） */
  versionId: ID | null
  /** 確かめた時の採用原稿の指紋（hashJson(本文)。違えば「本文が変わった話」） */
  bodyHash: string
  /** その時の表記（第12話など） */
  label: string
}

/** 改稿案。チェック（実装済み・ボツ）したものは斜線＋グレーで下へ沈む。本文の長さに制限はない（ワンシーン丸ごとの案もある） */
export interface RevisionIdea extends ClaudeRecordBase {
  heading: string
  body: string
  checked: boolean
  checkedAt: number | null
  /** 関係する話（チップで開ける）。消えた話は表示しない */
  pieceIds: ID[]
  /** チェックしていない案の並び順 */
  order: number
}

/** 戦略メモの中のコンテストの候補（［応募計画にする］で応募計画の項目に入れる） */
export interface StrategyContest {
  /** メモの中での印（k0, k1, …。並びは変わらない） */
  id: string
  name: string
  organizer: string
  /** https の URL（無ければ空） */
  url: string
  /** 締切 YYYY-MM-DD（無ければ空） */
  deadline: string
  minChars: number | null
  maxChars: number | null
  limitUnit: LimitUnit
  /** このタイトルとの相性（応募計画の概要に入れる） */
  fit: string
  /** 応募までの改稿の方針（応募計画の改稿方針に入れる） */
  plan: string
  /** ［応募計画にする］で作った応募計画（まだなら null） */
  submissionId: ID | null
}

/** 戦略メモ（Claude が採用原稿をもとに考えた今後の戦略。［全体戦略に追記］［応募計画にする］で取り込む） */
export interface StrategyNote extends ClaudeRecordBase {
  /** 考えた日（日本時間の YYYY-MM-DD） */
  runDate: string
  heading: string
  /** Markdown */
  body: string
  contests: StrategyContest[]
  /** ［全体戦略に追記］した日時（まだなら null） */
  appliedAt: number | null
  model?: string
}

/** 批評プロンプト（タイトル全体を、採用原稿で Claude に批評してもらうための依頼文）。titleId = null はどのタイトルでも使える */
export interface CritiquePrompt extends Omit<ClaudeRecordBase, 'titleId'> {
  /** null = 共通（どのタイトルでも使う） */
  titleId: ID | null
  name: string
  body: string
  order: number
}

/** 批評の範囲 */
export type CritiqueScope = { kind: 'whole' } | { kind: 'range'; fromPieceId: ID; toPieceId: ID; label: string }

/** 批評した時点の採用原稿（「286,400字・120話の時点（現在 +3,200字）」を出す） */
export interface CritiqueManuscript {
  /** 採用原稿の文字数（空白・改行・記法を除く） */
  chars: number
  /** 話（第n話・特殊ブロック）の数 */
  pieces: number
  /** 採用原稿の指紋 */
  hash: string
  at: number
}

/** 作品批評の結果（日付ごと）。実行したプロンプトの控えと、結果（Markdown かアーティファクトの URL） */
export interface CritiqueResult extends ClaudeRecordBase {
  /** 使った批評プロンプト（無い・消えた時は promptName / promptText の控えを出す） */
  promptId: ID | null
  promptName: string
  promptText: string
  /** 批評した日（日本時間の YYYY-MM-DD） */
  runDate: string
  /** 結果（Markdown。無ければ空） */
  resultMarkdown: string
  /** アーティファクトの URL（https。無ければ空） */
  artifactUrl: string
  scope: CritiqueScope
  manuscript: CritiqueManuscript | null
  /** 批評したモデルの名前（分かれば。無ければ空） */
  model: string
  /** 利用者のメモ */
  note: string
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
  | 'proofSuggestion'
  | 'revisionIdea'
  | 'strategyNote'
  | 'critiquePrompt'
  | 'critiqueResult'

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
  // 2.3（Claude 連携）
  proofSuggestions: Record<ID, ProofSuggestion>
  proofBatches: Record<ID, ProofBatch>
  revisionIdeas: Record<ID, RevisionIdea>
  strategyNotes: Record<ID, StrategyNote>
  critiquePrompts: Record<ID, CritiquePrompt>
  critiqueResults: Record<ID, CritiqueResult>
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
  'proofSuggestions',
  'proofBatches',
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
  'trashEntries',
  'trashRecords',
]

/** 2.3（Claude 連携）の表。コネクタが作れるのはこの表のレコードだけ（firestore.rules） */
export const CLAUDE_TABLES = [
  'proofSuggestions',
  'proofBatches',
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
] as const satisfies readonly TableName[]

export type ClaudeTableName = (typeof CLAUDE_TABLES)[number]

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
    proofSuggestions: {},
    proofBatches: {},
    revisionIdeas: {},
    strategyNotes: {},
    critiquePrompts: {},
    critiqueResults: {},
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
