// Claude の結果（コネクタの書き込みツールの入力・手動連携で貼り付けた JSON）から、2.3 の記録を作る。
// - 入力の形はコネクタの書き込みツール（W1〜W5）の入力と同じ（キーは snake_case）。貼り付けも同じ形を受け付ける
// - id は内容から作る（src/claude/derivedId.ts）。同じ内容をもう一度足しても同じ id になり、もうあれば duplicate、
//   以前に削除されたもの（ゴミ箱・クラウドの削除の印）は previously_deleted として作らない
// - 推敲案の抜き出した箇所は、話（幕に分けた話は各幕）の採用原稿の中で探して場所を控える（src/claude/anchor.ts）
// - 長い文章（改稿案・戦略メモの本文、コンテストの相性・方針、批評プロンプトの本文、批評の結果）の長さに上限はない。
//   上限があるのは短い項目（名前・見出し・推敲案の引用など）と件数だけ（RECORD_LIMITS）
// - コネクタ（source = claude）が書く記録だけは、1件を JSON にして 200,000 字まで（コネクタは分割文書を書かないため）。
//   超える時は、分け方を書いた理由を返す。貼り付け（source = paste）は端末が大きな記録を分割文書に分けて送るので上限なし
// - ベンチ作品の分析（2.5。W6）は、どのタイトルにも属さない。作品が無ければ new_work を付けた時だけ作品も作る
// 作るだけで、データには入れない（アプリはストアの addClaudeRecords、コネクタは Firestore への作成で入れる）。
import { BENCH_LIMITS, sortedBenchWorks } from '../domain/benchOps'
import { hashJson } from '../domain/hash'
import { adoptedText, isSplit, pieceFullLabel, pieceLabel } from '../domain/structure'
import type {
  AppData,
  BenchAnalysis,
  BenchWork,
  ClaudeTableName,
  CritiquePrompt,
  CritiqueResult,
  CritiqueScope,
  ID,
  Piece,
  ProofBatch,
  ProofCategory,
  ProofCovered,
  ProofSuggestion,
  RevisionIdea,
  StrategyContest,
  StrategyNote,
  Title,
} from '../domain/types'
import { stableStringify } from '../sync/merge'
import { locateExcerpt, safeSlice } from './anchor'
import { benchWorkRef, resolveBenchWork } from './bench'
import { isProofCategory, PROOF_CATEGORY_GUIDE, PROOF_CATEGORY_LABELS } from './categories'
import { isIsoDate, jstDate } from './dates'
import {
  benchAnalysisId,
  benchWorkId,
  critiquePromptId,
  critiqueResultId,
  proofBatchId,
  proofRunId,
  proofSuggestionId,
  revisionIdeaId,
  strategyNoteId,
} from './derivedId'
import { matchesId, readingOrder, resolvePiece, resolveTitle, shortId, type ReadingItem } from './refs'
import { manuscriptOf } from './snapshot'
import { canClaudeWrite, CLAUDE_RECORD_VERSION } from './visibility'

// ---------- 上限 ----------

/**
 * 入力の上限（コネクタのツールの JSON Schema と同じ値。文字数は Unicode の文字（コードポイント）で数える）。
 * 短い項目と件数だけ。長い文章（改稿案・戦略メモの本文、コンテストの相性・方針、批評プロンプトの本文・控え、批評の結果）には無い
 */
export const RECORD_LIMITS = {
  /** コネクタが書く1つの記録の JSON の長さ（UTF-16。アクセスルールと同じ値。貼り付けには無い） */
  recordJson: 200_000,
  proofItems: 100,
  proofCovered: 200,
  runLabel: 60,
  excerpt: 100,
  contextBefore: 30,
  categoryLabel: 20,
  suggestion: 500,
  reason: 300,
  revisionItems: 20,
  revisionHeading: 80,
  revisionPieces: 50,
  noteHeading: 80,
  contests: 10,
  contestName: 80,
  contestOrganizer: 80,
  promptName: 60,
  url: 2_000,
  model: 60,
  // 2.5: ベンチ作品
  benchItems: 20,
  viewpoint: BENCH_LIMITS.viewpoint,
  benchWorkName: BENCH_LIMITS.workName,
  benchAuthor: BENCH_LIMITS.author,
  benchPublisher: BENCH_LIMITS.publisher,
  benchYear: BENCH_LIMITS.year,
  benchGenre: BENCH_LIMITS.genre,
  pdfPlace: BENCH_LIMITS.pdfPlace,
  /** 作品批評の結果の比べた作品（bench_works）の数 */
  benchRefs: 20,
} as const

// ---------- 入力の形（コネクタの書き込みツールの入力と同じ） ----------

/** W1 novel_add_proofreading */
export interface ProofreadingInput {
  title_id: string
  run_label?: string
  /** YYYY-MM-DD（日本時間）。省略時は今日 */
  run_date?: string
  /** 確かめ終えた話（推敲案が無かった話も含む） */
  covered?: string[]
  items: ProofItemInput[]
  model?: string
}

export interface ProofItemInput {
  /** 話の指し方（#12・p:3f2a9c1b・第12話・第3話 第2幕） */
  piece: string
  /** 採用原稿から原文どおりに引用した箇所（ルビの記法も含む） */
  excerpt: string
  /** 同じ箇所が何度もある時に区別する直前の文字 */
  context_before?: string
  category: string
  category_label?: string
  suggestion?: string
  reason: string
  important?: boolean
}

/** W2 novel_add_revision_ideas */
export interface RevisionIdeasInput {
  title_id: string
  items: { heading: string; body: string; pieces?: string[] }[]
}

/** W3 novel_add_strategy_note */
export interface StrategyNoteInput {
  title_id: string
  heading: string
  /** Markdown */
  body: string
  run_date?: string
  contests?: ContestInput[]
  model?: string
}

export interface ContestInput {
  name: string
  organizer?: string
  /** https の URL */
  url?: string
  /** 締切 YYYY-MM-DD */
  deadline?: string
  limit?: { min?: number; max?: number; unit?: 'chars' | 'pages' }
  /** このタイトルとの相性 */
  fit?: string
  /** 応募までの改稿の方針 */
  plan?: string
}

/** W4 novel_save_critique_prompt */
export interface CritiquePromptInput {
  /** scope が title の時に必要 */
  title_id?: string
  scope: 'title' | 'shared'
  name: string
  body: string
}

/** W5 novel_add_critique_result */
export interface CritiqueResultInput {
  title_id: string
  prompt_id?: string
  /** 実行したプロンプト（省略時は prompt_id のプロンプトの本文） */
  prompt_text?: string
  result_markdown?: string
  /** https の URL（アーティファクト） */
  artifact_url?: string
  run_date?: string
  /** 範囲（省略時はタイトル全体） */
  scope?: { from: string; to: string }
  model?: string
  /** 比べたベンチ作品（w:… の短い id・作品名。2.5） */
  bench_works?: string[]
}

/** W6 novel_add_bench_analysis（2.5） */
export interface BenchAnalysisInput {
  /** 作品の指し方（w:… の短い id・id・作品名そのもの） */
  work: string
  /** 作品がまだ棚に無い時に作る（付けた時だけ作る） */
  new_work?: BenchNewWorkInput
  items: BenchAnalysisItemInput[]
  model?: string
}

export interface BenchNewWorkInput {
  name: string
  author: string
  publisher?: string
  year?: string
  genre?: string
  /** PDF の置き場所（claude.ai のプロジェクト名など） */
  pdf_place?: string
}

export interface BenchAnalysisItemInput {
  /** 観点の名前（構成・文体・人物・冒頭の掴み…。40字まで） */
  viewpoint: string
  /** 分析の本文（Markdown。長さの上限なし） */
  body_markdown: string
  /** YYYY-MM-DD（日本時間）。省略時は今日 */
  run_date?: string
}

/** 書き込みツールの名前（コネクタと手動連携の JSON の tool） */
export const WRITE_TOOLS = [
  'novel_add_proofreading',
  'novel_add_revision_ideas',
  'novel_add_strategy_note',
  'novel_save_critique_prompt',
  'novel_add_critique_result',
  'novel_add_bench_analysis',
] as const

export type WriteTool = (typeof WRITE_TOOLS)[number]

export type WriteToolInput = {
  novel_add_proofreading: ProofreadingInput
  novel_add_revision_ideas: RevisionIdeasInput
  novel_add_strategy_note: StrategyNoteInput
  novel_save_critique_prompt: CritiquePromptInput
  novel_add_critique_result: CritiqueResultInput
  novel_add_bench_analysis: BenchAnalysisInput
}

export type WriteToolCall = { [K in WriteTool]: { tool: K; input: WriteToolInput[K] } }[WriteTool]

export function isWriteTool(v: unknown): v is WriteTool {
  return typeof v === 'string' && (WRITE_TOOLS as readonly string[]).includes(v)
}

/** 書き込みツールの日本語の名前（貼り付けの確認画面・結果の表示） */
export const WRITE_TOOL_LABELS: Record<WriteTool, string> = {
  novel_add_proofreading: '推敲案を追加',
  novel_add_revision_ideas: '改稿案を追加',
  novel_add_strategy_note: '戦略メモを追加',
  novel_save_critique_prompt: '批評プロンプトを保存',
  novel_add_critique_result: '作品批評の結果を記録',
  novel_add_bench_analysis: 'ベンチ作品の分析を追加',
}

// ---------- 結果の形 ----------

export type ClaudeRecord =
  | ProofSuggestion
  | ProofBatch
  | RevisionIdea
  | StrategyNote
  | CritiquePrompt
  | CritiqueResult
  | BenchWork
  | BenchAnalysis

export interface NewRecord {
  table: ClaudeTableName
  record: ClaudeRecord
}

/**
 * 入力の1件ごとの結果。created = 作る、duplicate = 同じものがもうある、previously_deleted = 以前に削除された（作らない）、
 * not_found = 話・抜き出した箇所が見つからない、ambiguous = 同じ箇所が何か所もある、invalid = 入力の形が違う・長すぎる
 */
export type ItemStatus = 'created' | 'duplicate' | 'previously_deleted' | 'not_found' | 'ambiguous' | 'invalid'

export interface ItemResult {
  /** 入力の items の何番目か（0から。items の無い入力は 0） */
  index: number
  status: ItemStatus
  /** 作る・作った記録の id（not_found・ambiguous・invalid は無い） */
  id?: ID
  table?: ClaudeTableName
  /** 何の結果か（「第12話 ¶14「見れる」」など） */
  label: string
  /** 直し方（日本語） */
  hint?: string
  /** 候補（ambiguous・not_found の時） */
  candidates?: string[]
}

export interface BuildResult {
  /** false = 入力全体を受け付けなかった（タイトルが無い・書き込めない・形が違う）。error に理由 */
  ok: boolean
  error?: string
  candidates?: string[]
  /** 作る記録（この順に作る。推敲案の実行の記録 proofBatches は最後） */
  records: NewRecord[]
  items: ItemResult[]
  /** 補足（確かめた話の一部が見つからない・URL を外した など） */
  notes: string[]
}

export interface BuildContext {
  /** claude = コネクタ、paste = 手動連携の貼り付け */
  source: 'claude' | 'paste'
  /** 作った時刻（ms）。日付を省略した時の「今日」もこの時刻の日本時間 */
  now: number
  /** 以前に削除された記録か（アプリ: ゴミ箱の中身 trashedIdsOf、コネクタ: クラウドの削除の印） */
  wasDeleted?: (table: ClaudeTableName, id: ID) => boolean
}

// ---------- 小さな道具 ----------

/** 文字（コードポイント）の数 */
export function charLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const h = s.charCodeAt(i - 1)
      if (h >= 0xd800 && h <= 0xdbff) continue
    }
    n += 1
  }
  return n
}

/** 短く切る（表示用。サロゲートペアの途中では切らない） */
function short(s: string, max = 16): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (charLength(one) <= max) return one
  return `${Array.from(one).slice(0, max).join('')}…`
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** https の URL か（空は false） */
export function isHttpsUrl(v: unknown): v is string {
  if (!isStr(v) || !v.trim() || charLength(v) > RECORD_LIMITS.url) return false
  try {
    return new URL(v.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

const fmt = (n: number) => n.toLocaleString('ja-JP')

/**
 * 文字列の項目を確かめる（無い・空でよければ optional）。max = null は長い文章（長さの上限なし）。
 * 問題があれば日本語の理由
 */
function checkText(v: unknown, name: string, max: number | null, required: boolean): string | null {
  if (v === undefined || v === null) return required ? `${name} がありません` : null
  if (!isStr(v)) return `${name} は文字列にしてください`
  if (required && !v.trim()) return `${name} が空です`
  if (max !== null && charLength(v) > max) return `${name} が長すぎます（${fmt(max)}字まで。いま ${fmt(charLength(v))}字）`
  return null
}

/** 記録を JSON にした長さが、コネクタが書ける上限に収まるか */
export function recordFits(record: ClaudeRecord): boolean {
  return stableStringify(record).length <= RECORD_LIMITS.recordJson
}

/** 分けた各部の見出し（「（1/2）」など。番号の順に並べる。order.ts の partMarkOf）の分の余裕 */
const SPLIT_MARGIN = 2_000

/**
 * 記録が大きすぎる時の理由（コネクタが書けない時。Claude が直せるように、いまの大きさと分け方を書く）。
 * what は「批評の結果」など、split はどう分けるか
 */
export function recordTooLarge(
  length: number,
  what = '記録',
  split = '内容を2つ以上に分けて、ツールを分けて呼んでください',
): string {
  return `${what}が大きすぎて1件の記録に入りません（コネクタが書ける記録は JSON にして ${fmt(RECORD_LIMITS.recordJson)}字まで。いま ${fmt(length)}字）。${split}`
}

/**
 * コネクタ（source = claude）が書く記録の大きさを確かめる。収まらなければ、長い文章 text を何件に分ければよいかを入れた理由。
 * 貼り付け（source = paste）は確かめない（端末が大きな記録を分割文書に分けて送るため）
 */
function sizeProblem(
  record: ClaudeRecord,
  ctx: BuildContext,
  what: string,
  text: string,
  split: (parts: number) => string,
  tooLong: string,
): string | null {
  if (ctx.source !== 'claude') return null
  const length = stableStringify(record).length
  if (length <= RECORD_LIMITS.recordJson) return null
  const own = JSON.stringify(text).length
  const room = RECORD_LIMITS.recordJson - (length - own) - SPLIT_MARGIN
  return recordTooLarge(length, what, room > 0 ? split(Math.max(2, Math.ceil(own / room))) : tooLong)
}

/** ゴミ箱に入っている 2.3 の記録の id（表ごと）。アプリの貼り付けで previously_deleted を見分ける */
export function trashedIdsOf(data: AppData): (table: ClaudeTableName, id: ID) => boolean {
  const set = new Set<string>()
  for (const r of Object.values(data.trashRecords)) {
    const rec = r.record as { id?: unknown } | undefined
    if (rec && typeof rec.id === 'string') set.add(`${r.table}:${rec.id}`)
  }
  return (table, id) => set.has(`${table}:${id}`)
}

/** 作る前の確かめ（もうある・以前に削除された・同じ入力の中で重なる） */
function existing(data: AppData, ctx: BuildContext, table: ClaudeTableName, id: ID, seen: Set<string>): ItemStatus | null {
  if ((data[table] as Record<ID, unknown>)[id] || seen.has(`${table}:${id}`)) return 'duplicate'
  if (ctx.wasDeleted?.(table, id)) return 'previously_deleted'
  return null
}

const STATUS_HINTS: Partial<Record<ItemStatus, string>> = {
  duplicate: '同じ内容の記録がもうあります（追加しません）',
  previously_deleted: '以前に削除された記録です（追加しません）',
}

interface TitleCheck {
  title?: Title
  error?: string
  candidates?: string[]
}

/** タイトルを読み、コネクタの時は書き込めるタイトルかを確かめる */
function writableTitle(data: AppData, ref: unknown, ctx: BuildContext): TitleCheck {
  if (!isStr(ref) || !ref.trim()) return { error: 'title_id がありません' }
  const r = resolveTitle(data, ref)
  if (!r.ok) return { error: r.message, candidates: r.candidates }
  if (ctx.source === 'claude' && !canClaudeWrite(r.value))
    return {
      error:
        'このタイトルは書き込み不可です（アプリのタイトル画面の「Claude に見せる」を「読む＋書き込む」にすると書き込めます）',
    }
  return { title: r.value }
}

const fail = (error: string, candidates?: string[]): BuildResult => ({
  ok: false,
  error,
  ...(candidates ? { candidates } : {}),
  records: [],
  items: [],
  notes: [],
})

function base(ctx: BuildContext, titleId: ID) {
  return { v: CLAUDE_RECORD_VERSION, source: ctx.source, titleId, createdAt: ctx.now, updatedAt: ctx.now }
}

/** 日付（省略・形が違う時は今日。形が違えば notes に書く） */
function runDateOf(v: unknown, ctx: BuildContext, notes: string[]): string {
  if (v === undefined || v === null || v === '') return jstDate(ctx.now)
  if (isIsoDate(v)) return v
  notes.push(`日付 '${String(v)}' は YYYY-MM-DD でないため、今日の日付にしました`)
  return jstDate(ctx.now)
}

function modelOf(v: unknown): string | undefined {
  return isStr(v) && v.trim() ? Array.from(v.trim()).slice(0, RECORD_LIMITS.model).join('') : undefined
}

// ---------- W1 推敲案 ----------

/** 推敲案の表示（「第12話 ¶14「見れる」」） */
function proofLabel(pieceText: string, paragraph: number | null, excerpt: string): string {
  return `${pieceText}${paragraph ? ` ¶${paragraph}` : ''}「${short(excerpt)}」`
}

export function buildProofreading(data: AppData, input: ProofreadingInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  const t = writableTitle(data, input.title_id, ctx)
  if (!t.title) return fail(t.error!, t.candidates)
  const title = t.title
  if (!Array.isArray(input.items)) return fail('items がありません（推敲案の配列）')
  if (input.items.length > RECORD_LIMITS.proofItems) return fail(`items が多すぎます（1回 ${RECORD_LIMITS.proofItems} 件まで）`)
  const covered = input.covered ?? []
  if (!Array.isArray(covered)) return fail('covered は話の指し方の配列にしてください')
  if (covered.length > RECORD_LIMITS.proofCovered) return fail(`covered が多すぎます（${RECORD_LIMITS.proofCovered} 件まで）`)
  const labelErr = checkText(input.run_label, 'run_label', RECORD_LIMITS.runLabel, false)
  if (labelErr) return fail(labelErr)

  const notes: string[] = []
  const runLabel = (input.run_label ?? '').trim()
  const runDate = runDateOf(input.run_date, ctx, notes)
  const runId = proofRunId(title.id, runLabel, runDate)
  const model = modelOf(input.model)
  const order = readingOrder(data, title.id)
  const seen = new Set<string>()
  const items: ItemResult[] = []
  const created: ProofSuggestion[] = []
  /** この実行の推敲案（作るもの・もうあるもの）の id と種類 */
  const batchItems: { id: ID; category: ProofCategory }[] = []

  input.items.forEach((raw, index) => {
    const bad = (hint: string, label = '推敲案') => items.push({ index, status: 'invalid', label, hint })
    if (!isObj(raw)) return bad('推敲案の形が違います')
    const item = raw as unknown as ProofItemInput
    const err =
      checkText(item.piece, 'piece', 200, true) ??
      checkText(item.excerpt, 'excerpt', RECORD_LIMITS.excerpt, true) ??
      checkText(item.context_before, 'context_before', RECORD_LIMITS.contextBefore, false) ??
      checkText(item.category, 'category', 40, true) ??
      checkText(item.category_label, 'category_label', RECORD_LIMITS.categoryLabel, false) ??
      checkText(item.suggestion, 'suggestion', RECORD_LIMITS.suggestion, false) ??
      checkText(item.reason, 'reason', RECORD_LIMITS.reason, true)
    if (err) return bad(err, isStr(item.excerpt) ? `「${short(item.excerpt)}」` : '推敲案')
    if (item.important !== undefined && typeof item.important !== 'boolean')
      return bad('important は true か false にしてください')

    const resolved = resolvePiece(data, title.id, item.piece, order)
    if (!resolved.ok) {
      items.push({
        index,
        status: 'not_found',
        label: `「${short(item.excerpt)}」`,
        hint: resolved.message,
        candidates: resolved.candidates,
      })
      return
    }
    const piece = resolved.value
    const where = pieceLabelOf(data, piece, order)
    const located = locateExcerpt(data, piece, item.excerpt, item.context_before || undefined)
    if (located.status === 'not_found') {
      const none = !adoptedText(data, piece)
      items.push({
        index,
        status: 'not_found',
        label: proofLabel(where, null, item.excerpt),
        hint: none
          ? `${where}には採用原稿がありません`
          : `抜き出した箇所が${where}の採用原稿に見つかりません。採用原稿から原文どおり（ルビの記法も含めて）引用してください`,
      })
      return
    }
    if (located.status === 'ambiguous') {
      items.push({
        index,
        status: 'ambiguous',
        label: proofLabel(where, null, item.excerpt),
        hint: `同じ箇所が${where}に${located.count}か所あります。context_before に直前の文字（${RECORD_LIMITS.contextBefore}字以内）を入れて区別してください`,
        candidates: located.candidates.map(
          (c) =>
            `${pieceLabelOf(data, data.pieces[c.pieceId] ?? piece, order)} ¶${c.paragraph} [...]${c.before}【${item.excerpt}】${c.after}[...]`,
        ),
      })
      return
    }
    const seg = located.segment
    const known = isProofCategory(item.category)
    const category: ProofCategory = known ? (item.category as ProofCategory) : 'other'
    const categoryLabel =
      item.category_label?.trim() || (known ? PROOF_CATEGORY_LABELS[category] : short(item.category, RECORD_LIMITS.categoryLabel))
    if (!known)
      notes.push(`category '${short(item.category, 20)}' は使えないため other にしました（使える種類: ${PROOF_CATEGORY_GUIDE}）`)
    const suggestion = item.suggestion ?? ''
    const id = proofSuggestionId({
      titleId: title.id,
      pieceId: seg.piece.id,
      contextBefore: item.context_before ?? '',
      excerpt: item.excerpt,
      occurrence: located.occurrence,
      category,
      suggestion,
    })
    const segLabel = pieceLabelOf(data, seg.piece, order)
    const label = proofLabel(segLabel, located.anchor.paragraph, item.excerpt)
    const status = existing(data, ctx, 'proofSuggestions', id, seen)
    if (status !== 'previously_deleted') batchItems.push({ id, category })
    if (status) {
      items.push({ index, status, id, table: 'proofSuggestions', label, hint: STATUS_HINTS[status] })
      return
    }
    seen.add(`proofSuggestions:${id}`)
    const rec: ProofSuggestion = {
      id,
      ...base(ctx, title.id),
      pieceId: seg.piece.id,
      parentId: seg.parentId,
      versionId: seg.version.id,
      pieceLabel: pieceFullLabel(data, seg.piece),
      anchor: located.anchor,
      category,
      categoryLabel,
      excerpt: item.excerpt,
      suggestion,
      reason: item.reason,
      flagged: item.important === true,
      done: false,
      doneAt: null,
      runId,
      batchId: null,
      ...(model ? { model } : {}),
    }
    if (ctx.source === 'claude' && !recordFits(rec))
      return bad(recordTooLarge(stableStringify(rec).length, '推敲案', '直し案・理由を短くしてください'), label)
    created.push(rec)
    items.push({ index, status: 'created', id, table: 'proofSuggestions', label })
  })

  // 確かめ終えた話
  const coveredOut: ProofCovered[] = []
  const coveredSeen = new Set<ID>()
  for (const ref of covered) {
    if (!isStr(ref)) {
      notes.push('covered の中に文字列でないものがあったため飛ばしました')
      continue
    }
    const r = resolvePiece(data, title.id, ref, order)
    if (!r.ok) {
      notes.push(`covered の '${short(ref, 30)}' は見つかりません（${r.message}）`)
      continue
    }
    const piece = r.value
    if (coveredSeen.has(piece.id)) continue
    coveredSeen.add(piece.id)
    const text = adoptedText(data, piece)
    coveredOut.push({
      pieceId: piece.id,
      versionId: isSplit(piece) ? null : (piece.activeVersionId ?? null),
      bodyHash: text ? hashJson(text.body) : '',
      label: pieceFullLabel(data, piece),
    })
  }

  const records: NewRecord[] = []
  if (created.length || coveredOut.length) {
    const itemIds = [...new Set(batchItems.map((x) => x.id))]
    const batchId = proofBatchId(
      runId,
      coveredOut.map((c) => c.pieceId),
      itemIds,
    )
    for (const rec of created) records.push({ table: 'proofSuggestions', record: { ...rec, batchId } })
    if (!existing(data, ctx, 'proofBatches', batchId, seen)) {
      const batch: ProofBatch = {
        id: batchId,
        ...base(ctx, title.id),
        runId,
        runLabel,
        runDate,
        categories: [...new Set(batchItems.map((x) => x.category))],
        covered: coveredOut,
        itemIds,
        ...(model ? { model } : {}),
      }
      if (ctx.source !== 'claude' || recordFits(batch)) records.push({ table: 'proofBatches', record: batch })
      else notes.push('実行の記録が大きすぎるため残しませんでした')
    }
  }
  return { ok: true, records, items, notes }
}

/** 話の表記（「#12 第12話」「#3.2 第3話 第2幕」） */
function pieceLabelOf(data: AppData, piece: Piece, order: readonly ReadingItem[]): string {
  if (piece.kind === 'act' && piece.parentId) {
    const parentItem = order.find((x) => x.piece.id === piece.parentId)
    const n = parentItem ? (parentItem.piece.actIds ?? []).indexOf(piece.id) + 1 : 0
    return parentItem ? `#${parentItem.index}.${n} ${parentItem.label} ${pieceLabel(data, piece)}` : pieceLabel(data, piece)
  }
  const item = order.find((x) => x.piece.id === piece.id)
  return item ? `#${item.index} ${item.label}` : pieceLabel(data, piece)
}

// ---------- W2 改稿案 ----------

export function buildRevisionIdeas(data: AppData, input: RevisionIdeasInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  const t = writableTitle(data, input.title_id, ctx)
  if (!t.title) return fail(t.error!, t.candidates)
  const title = t.title
  if (!Array.isArray(input.items)) return fail('items がありません（改稿案の配列）')
  if (input.items.length > RECORD_LIMITS.revisionItems)
    return fail(`items が多すぎます（1回 ${RECORD_LIMITS.revisionItems} 件まで）`)
  const order = readingOrder(data, title.id)
  const notes: string[] = []
  const items: ItemResult[] = []
  const records: NewRecord[] = []
  const seen = new Set<string>()
  let nextOrder =
    Object.values(data.revisionIdeas)
      .filter((r) => r.titleId === title.id)
      .reduce((m, r) => Math.max(m, r.order), -1) + 1
  input.items.forEach((raw, index) => {
    if (!isObj(raw)) return items.push({ index, status: 'invalid', label: '改稿案', hint: '改稿案の形が違います' })
    const item = raw as unknown as RevisionIdeasInput['items'][number]
    const err =
      checkText(item.heading, 'heading', RECORD_LIMITS.revisionHeading, true) ?? checkText(item.body, 'body', null, true)
    const label = isStr(item.heading) && item.heading.trim() ? `「${short(item.heading, 24)}」` : '改稿案'
    if (err) return items.push({ index, status: 'invalid', label, hint: err })
    const refs = item.pieces ?? []
    if (!Array.isArray(refs) || refs.length > RECORD_LIMITS.revisionPieces)
      return items.push({
        index,
        status: 'invalid',
        label,
        hint: `pieces は話の指し方の配列（${RECORD_LIMITS.revisionPieces}件まで）にしてください`,
      })
    const pieceIds: ID[] = []
    const missing: string[] = []
    for (const ref of refs) {
      const r = isStr(ref) ? resolvePiece(data, title.id, ref, order) : null
      if (r?.ok) {
        if (!pieceIds.includes(r.value.id)) pieceIds.push(r.value.id)
      } else missing.push(String(ref))
    }
    const id = revisionIdeaId(title.id, item.heading, item.body)
    const status = existing(data, ctx, 'revisionIdeas', id, seen)
    if (status) return items.push({ index, status, id, table: 'revisionIdeas', label, hint: STATUS_HINTS[status] })
    const rec: RevisionIdea = {
      id,
      ...base(ctx, title.id),
      heading: item.heading.trim(),
      body: item.body,
      checked: false,
      checkedAt: null,
      pieceIds,
      order: nextOrder,
    }
    const tooBig = sizeProblem(
      rec,
      ctx,
      '改稿案',
      rec.body,
      (k) =>
        `body を${k}つ以上に分け、1つ目から順に、別々の改稿案にして送ってください（見出しに「（1/${k}）」「（2/${k}）」…と番号を付ける）`,
      'heading を短くしてください',
    )
    if (tooBig) return items.push({ index, status: 'invalid', label, hint: tooBig })
    nextOrder += 1
    seen.add(`revisionIdeas:${id}`)
    records.push({ table: 'revisionIdeas', record: rec })
    items.push({
      index,
      status: 'created',
      id,
      table: 'revisionIdeas',
      label,
      ...(missing.length ? { hint: `見つからない話を外しました: ${missing.map((m) => short(m, 20)).join('、')}` } : {}),
    })
  })
  return { ok: true, records, items, notes }
}

// ---------- W3 戦略メモ ----------

function contestOf(raw: unknown, i: number, notes: string[]): StrategyContest | string {
  if (!isObj(raw)) return 'コンテストの形が違います'
  const c = raw as unknown as ContestInput
  const err =
    checkText(c.name, 'name', RECORD_LIMITS.contestName, true) ??
    checkText(c.organizer, 'organizer', RECORD_LIMITS.contestOrganizer, false) ??
    checkText(c.fit, 'fit', null, false) ??
    checkText(c.plan, 'plan', null, false)
  if (err) return err
  let url = ''
  if (c.url !== undefined && c.url !== '') {
    if (isHttpsUrl(c.url)) url = c.url.trim()
    else notes.push(`「${short(c.name, 20)}」の URL は https でないため外しました`)
  }
  let deadline = ''
  if (c.deadline !== undefined && c.deadline !== '') {
    if (isIsoDate(c.deadline)) deadline = c.deadline
    else notes.push(`「${short(c.name, 20)}」の締切 '${String(c.deadline)}' は YYYY-MM-DD でないため外しました`)
  }
  const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
  const limit = isObj(c.limit) ? c.limit : {}
  return {
    id: `k${i}`,
    name: c.name.trim(),
    organizer: (c.organizer ?? '').trim(),
    url,
    deadline,
    minChars: count(limit.min),
    maxChars: count(limit.max),
    limitUnit: limit.unit === 'pages' ? 'pages' : 'chars',
    fit: c.fit ?? '',
    plan: c.plan ?? '',
    submissionId: null,
  }
}

export function buildStrategyNote(data: AppData, input: StrategyNoteInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  const t = writableTitle(data, input.title_id, ctx)
  if (!t.title) return fail(t.error!, t.candidates)
  const title = t.title
  const label = isStr(input.heading) && input.heading.trim() ? `「${short(input.heading, 24)}」` : '戦略メモ'
  const err = checkText(input.heading, 'heading', RECORD_LIMITS.noteHeading, true) ?? checkText(input.body, 'body', null, true)
  if (err) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: err }], notes: [] }
  const rawContests = input.contests ?? []
  if (!Array.isArray(rawContests) || rawContests.length > RECORD_LIMITS.contests)
    return {
      ok: true,
      records: [],
      items: [
        {
          index: 0,
          status: 'invalid',
          label,
          hint: `contests はコンテストの配列（${RECORD_LIMITS.contests}件まで）にしてください`,
        },
      ],
      notes: [],
    }
  const notes: string[] = []
  const contests: StrategyContest[] = []
  rawContests.forEach((raw, i) => {
    const c = contestOf(raw, contests.length, notes)
    if (typeof c === 'string') notes.push(`コンテスト ${i + 1} を外しました: ${c}`)
    else contests.push(c)
  })
  const runDate = runDateOf(input.run_date, ctx, notes)
  const id = strategyNoteId(title.id, runDate, input.heading, input.body)
  const status = existing(data, ctx, 'strategyNotes', id, new Set())
  if (status)
    return {
      ok: true,
      records: [],
      items: [{ index: 0, status, id, table: 'strategyNotes', label, hint: STATUS_HINTS[status] }],
      notes,
    }
  const model = modelOf(input.model)
  const rec: StrategyNote = {
    id,
    ...base(ctx, title.id),
    runDate,
    heading: input.heading.trim(),
    body: input.body,
    contests,
    appliedAt: null,
    ...(model ? { model } : {}),
  }
  const tooBig = sizeProblem(
    rec,
    ctx,
    '戦略メモ',
    rec.body,
    (k) =>
      `body を${k}つ以上に分け、novel_add_strategy_note を分けて呼んでください（同じ run_date で、見出しに「（1/${k}）」「（2/${k}）」…と番号を付ける。アプリと一覧はこの番号の順に並べます。contests は1つ目にだけ入れる）`,
    'contests の相性（fit）・方針（plan）を短くするか、コンテストの候補を別の戦略メモに分けてください',
  )
  if (tooBig) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: tooBig }], notes }
  return {
    ok: true,
    records: [{ table: 'strategyNotes', record: rec }],
    items: [{ index: 0, status: 'created', id, table: 'strategyNotes', label }],
    notes,
  }
}

// ---------- W4 批評プロンプト ----------

export function buildCritiquePrompt(data: AppData, input: CritiquePromptInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  if (input.scope !== 'title' && input.scope !== 'shared')
    return fail("scope は 'title'（このタイトル）か 'shared'（共通）にしてください")
  let titleId: ID | null = null
  if (input.scope === 'title') {
    const t = writableTitle(data, input.title_id, ctx)
    if (!t.title) return fail(t.error!, t.candidates)
    titleId = t.title.id
  }
  const label = isStr(input.name) && input.name.trim() ? `「${short(input.name, 24)}」` : '批評プロンプト'
  const err = checkText(input.name, 'name', RECORD_LIMITS.promptName, true) ?? checkText(input.body, 'body', null, true)
  if (err) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: err }], notes: [] }
  const id = critiquePromptId(titleId, input.name, input.body)
  const status = existing(data, ctx, 'critiquePrompts', id, new Set())
  if (status)
    return {
      ok: true,
      records: [],
      items: [{ index: 0, status, id, table: 'critiquePrompts', label, hint: STATUS_HINTS[status] }],
      notes: [],
    }
  const order =
    Object.values(data.critiquePrompts)
      .filter((p) => p.titleId === titleId)
      .reduce((m, p) => Math.max(m, p.order), -1) + 1
  const rec: CritiquePrompt = { id, ...base(ctx, ''), titleId, name: input.name.trim(), body: input.body, order }
  const tooBig = sizeProblem(
    rec,
    ctx,
    '批評プロンプト',
    rec.body,
    (k) =>
      `body を短くするか、1つ目から順に ${k}つ以上の批評プロンプトに分けて保存してください（名前に「（1/${k}）」「（2/${k}）」…と番号を付ける）`,
    'name を短くしてください',
  )
  if (tooBig) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: tooBig }], notes: [] }
  return {
    ok: true,
    records: [{ table: 'critiquePrompts', record: rec }],
    items: [{ index: 0, status: 'created', id, table: 'critiquePrompts', label }],
    notes: [],
  }
}

// ---------- W5 作品批評の結果 ----------

/** タイトルで使える批評プロンプト（このタイトルのものと共通のもの）から、指し方（短い id・id・名前）で探す */
export function resolveCritiquePrompt(
  data: AppData,
  titleId: ID,
  ref: string,
): { ok: true; value: CritiquePrompt } | { ok: false; message: string; candidates: string[] } {
  const usable = Object.values(data.critiquePrompts).filter((p) => p.titleId === titleId || p.titleId === null)
  const byId = usable.filter((p) => matchesId('critiquePrompt', ref, p.id))
  const hits = byId.length ? byId : usable.filter((p) => p.name.trim() === ref.trim())
  if (hits.length === 1) return { ok: true, value: hits[0] }
  const candidates = (hits.length ? hits : usable).slice(0, 20).map((p) => `${shortId('critiquePrompt', p.id)}「${p.name}」`)
  return {
    ok: false,
    message: hits.length ? `批評プロンプト '${ref}' が複数あります` : `批評プロンプト '${ref}' が見つかりません`,
    candidates,
  }
}

export function buildCritiqueResult(data: AppData, input: CritiqueResultInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  const t = writableTitle(data, input.title_id, ctx)
  if (!t.title) return fail(t.error!, t.candidates)
  const title = t.title
  const notes: string[] = []
  let prompt: CritiquePrompt | null = null
  if (input.prompt_id !== undefined && input.prompt_id !== null && input.prompt_id !== '') {
    if (!isStr(input.prompt_id)) return fail('prompt_id は文字列にしてください')
    const r = resolveCritiquePrompt(data, title.id, input.prompt_id)
    if (!r.ok) return fail(r.message, r.candidates)
    prompt = r.value
  }
  const label = prompt ? `「${short(prompt.name, 24)}」の結果` : '作品批評の結果'
  const err =
    checkText(input.prompt_text, 'prompt_text', null, false) ?? checkText(input.result_markdown, 'result_markdown', null, false)
  if (err) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: err }], notes }
  const markdown = input.result_markdown ?? ''
  let url = ''
  if (input.artifact_url !== undefined && input.artifact_url !== null && input.artifact_url !== '') {
    if (!isHttpsUrl(input.artifact_url))
      return {
        ok: true,
        records: [],
        items: [{ index: 0, status: 'invalid', label, hint: 'artifact_url は https の URL にしてください' }],
        notes,
      }
    url = input.artifact_url.trim()
  }
  if (!markdown.trim() && !url)
    return {
      ok: true,
      records: [],
      items: [{ index: 0, status: 'invalid', label, hint: 'result_markdown か artifact_url のどちらかを入れてください' }],
      notes,
    }
  let scope: CritiqueScope = { kind: 'whole' }
  if (input.scope !== undefined && input.scope !== null) {
    const s = input.scope
    const order = readingOrder(data, title.id)
    const from = isObj(s) && isStr(s.from) ? resolvePiece(data, title.id, s.from, order) : null
    const to = isObj(s) && isStr(s.to) ? resolvePiece(data, title.id, s.to, order) : null
    if (from?.ok && to?.ok) {
      scope = {
        kind: 'range',
        fromPieceId: from.value.id,
        toPieceId: to.value.id,
        label: `${pieceFullLabel(data, from.value)}〜${pieceFullLabel(data, to.value)}`,
      }
    } else notes.push('scope の話が見つからないため、タイトル全体の批評として記録しました')
  }
  const runDate = runDateOf(input.run_date, ctx, notes)
  const benchWorkIds = benchRefsOf(data, input.bench_works, notes)
  if (typeof benchWorkIds === 'string')
    return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: benchWorkIds }], notes }
  const promptText = input.prompt_text ?? prompt?.body ?? ''
  const id = critiqueResultId({ titleId: title.id, runDate, promptText, resultMarkdown: markdown, artifactUrl: url })
  const status = existing(data, ctx, 'critiqueResults', id, new Set())
  if (status)
    return {
      ok: true,
      records: [],
      items: [{ index: 0, status, id, table: 'critiqueResults', label, hint: STATUS_HINTS[status] }],
      notes,
    }
  const rec: CritiqueResult = {
    id,
    ...base(ctx, title.id),
    promptId: prompt?.id ?? null,
    promptName: prompt?.name ?? '',
    promptText,
    runDate,
    resultMarkdown: markdown,
    artifactUrl: url,
    scope,
    manuscript: manuscriptOf(data, title.id, ctx.now),
    model: modelOf(input.model) ?? '',
    note: '',
    ...(benchWorkIds.length ? { benchWorkIds } : {}),
  }
  const tooBig = sizeProblem(
    rec,
    ctx,
    '批評の結果',
    markdown,
    (k) =>
      `result_markdown を${k}つ以上に分け（前半・後半のように、見出しの切れ目で）、novel_add_critique_result を分けて呼んでください（同じ prompt_id・scope・run_date で、各部の result_markdown の1行目に「（1/${k}）」「（2/${k}）」…と番号を書く。アプリと一覧はこの番号の順に並べます）`,
    'プロンプトの控え（prompt_text。省いた時は prompt_id の本文）が長すぎて、結果と一緒に入りません。prompt_text に依頼の要約（短いもの）を入れてください',
  )
  if (tooBig) return { ok: true, records: [], items: [{ index: 0, status: 'invalid', label, hint: tooBig }], notes }
  return {
    ok: true,
    records: [{ table: 'critiqueResults', record: rec }],
    items: [{ index: 0, status: 'created', id, table: 'critiqueResults', label }],
    notes,
  }
}

/**
 * 作品批評の比べた作品（bench_works）を作品の id にする（見つからない作品は外して notes に書く）。
 * 形が違えば理由の文字列
 */
function benchRefsOf(data: AppData, refs: unknown, notes: string[]): ID[] | string {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs) || refs.length > RECORD_LIMITS.benchRefs)
    return `bench_works はベンチ作品の指し方（w:… か作品名）の配列（${RECORD_LIMITS.benchRefs}件まで）にしてください`
  const ids: ID[] = []
  for (const ref of refs) {
    const r = isStr(ref) && ref.trim() ? resolveBenchWork(data, ref) : null
    if (r?.ok) {
      if (!ids.includes(r.value.id)) ids.push(r.value.id)
    } else notes.push(`bench_works の '${short(String(ref), 30)}' は見つからないため外しました${r ? `（${r.message}）` : ''}`)
  }
  return ids
}

// ---------- W6 ベンチ作品の分析（2.5） ----------

/** 作品がまだ無い時に作る作品（形が違えば理由） */
function newWorkOf(raw: unknown): BenchNewWorkInput | string {
  if (!isObj(raw)) return 'new_work の形が違います（{"name": …, "author": …}）'
  const w = raw as unknown as BenchNewWorkInput
  const err =
    checkText(w.name, 'new_work.name', RECORD_LIMITS.benchWorkName, true) ??
    checkText(w.author, 'new_work.author', RECORD_LIMITS.benchAuthor, false) ??
    checkText(w.publisher, 'new_work.publisher', RECORD_LIMITS.benchPublisher, false) ??
    checkText(w.year, 'new_work.year', RECORD_LIMITS.benchYear, false) ??
    checkText(w.genre, 'new_work.genre', RECORD_LIMITS.benchGenre, false) ??
    checkText(w.pdf_place, 'new_work.pdf_place', RECORD_LIMITS.pdfPlace, false)
  return err ?? w
}

export function buildBenchAnalysis(data: AppData, input: BenchAnalysisInput, ctx: BuildContext): BuildResult {
  if (!isObj(input)) return fail('入力の形が違います')
  if (!Array.isArray(input.items) || input.items.length === 0) return fail('items がありません（分析の配列）')
  if (input.items.length > RECORD_LIMITS.benchItems)
    return fail(`items が多すぎます（1回 ${RECORD_LIMITS.benchItems} 件まで。観点ごとに分けて呼んでください）`)
  const ref = isStr(input.work) ? input.work.trim() : ''
  const newWork = input.new_work === undefined || input.new_work === null ? null : newWorkOf(input.new_work)
  if (typeof newWork === 'string') return fail(newWork)
  if (!ref && !newWork) return fail('work がありません（ベンチ作品の w:… か作品名。棚に無い作品は new_work も付ける）')
  const notes: string[] = []
  const records: NewRecord[] = []
  // 作品: work → new_work の作品名の順に探し、無ければ new_work がある時だけ作る
  let work: BenchWork | null = null
  let created: BenchWork | null = null
  const found = ref ? resolveBenchWork(data, ref) : null
  if (found?.ok) work = found.value
  else if (found && found.reason === 'ambiguous') return fail(found.message, found.candidates)
  else if (newWork) {
    const byName = resolveBenchWork(data, newWork.name)
    if (byName.ok) work = byName.value
    else if (byName.reason === 'ambiguous') return fail(byName.message, byName.candidates)
    else {
      const id = benchWorkId(newWork.name, newWork.author ?? '')
      const same = data.benchWorks[id]
      if (same) work = same
      else if (ctx.wasDeleted?.('benchWorks', id))
        return fail(
          `ベンチ作品『${short(newWork.name, 30)}』は以前に削除されています（作り直す時は、アプリのホームの「ベンチ作品」で作るか、ゴミ箱から戻してください）`,
        )
      else {
        const opt = (v: string | undefined) => (isStr(v) && v.trim() ? v.trim() : undefined)
        const publisher = opt(newWork.publisher)
        const year = opt(newWork.year)
        const genre = opt(newWork.genre)
        created = {
          id,
          name: newWork.name.trim(),
          author: (newWork.author ?? '').trim(),
          ...(publisher ? { publisher } : {}),
          ...(year ? { year } : {}),
          ...(genre ? { genre } : {}),
          pdfPlace: (newWork.pdf_place ?? '').trim(),
          note: '',
          order: sortedBenchWorks(data).reduce((m, w) => Math.max(m, w.order), -1) + 1,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          source: ctx.source,
        }
        work = created
      }
    }
  } else
    return fail(
      `${found?.message ?? 'ベンチ作品が見つかりません'}。棚に無い作品は new_work（name・author など）を付けると、作品も作ります`,
      found?.candidates,
    )

  const model = modelOf(input.model)
  const seen = new Set<string>()
  const items: ItemResult[] = []
  input.items.forEach((raw, index) => {
    if (!isObj(raw)) return items.push({ index, status: 'invalid', label: '分析', hint: '分析の形が違います' })
    const item = raw as unknown as BenchAnalysisItemInput
    const label =
      isStr(item.viewpoint) && item.viewpoint.trim()
        ? `『${short(work!.name, 20)}』の「${short(item.viewpoint, 20)}」`
        : `『${short(work!.name, 20)}』の分析`
    const err =
      checkText(item.viewpoint, 'viewpoint', RECORD_LIMITS.viewpoint, true) ??
      checkText(item.body_markdown, 'body_markdown', null, true)
    if (err) return items.push({ index, status: 'invalid', label, hint: err })
    const itemNotes: string[] = []
    const runDate = runDateOf(item.run_date, ctx, itemNotes)
    notes.push(...itemNotes)
    const id = benchAnalysisId({ workId: work!.id, viewpoint: item.viewpoint, runDate, body: item.body_markdown })
    const status = existing(data, ctx, 'benchAnalyses', id, seen)
    if (status) return items.push({ index, status, id, table: 'benchAnalyses', label, hint: STATUS_HINTS[status] })
    // 同じ呼び出しの分析は、送った順に1ずつずらした時刻にする（観点のまとまりの順が送った順になるように）
    const at = ctx.now + index
    const rec: BenchAnalysis = {
      id,
      workId: work!.id,
      viewpoint: item.viewpoint.trim(),
      body: item.body_markdown,
      runDate,
      source: ctx.source,
      ...(model ? { model } : {}),
      v: CLAUDE_RECORD_VERSION,
      createdAt: at,
      updatedAt: at,
    }
    const tooBig = sizeProblem(
      rec,
      ctx,
      'ベンチ作品の分析',
      rec.body,
      (k) =>
        `body_markdown を${k}つ以上に分け（前半・後半のように、見出しの切れ目で）、同じ viewpoint・run_date の別々の items にして送ってください（各部の body_markdown の1行目に「（1/${k}）」「（2/${k}）」…と番号を書く。アプリと一覧はこの番号の順に並べます。items が多くなる時は novel_add_bench_analysis を分けて呼ぶ）`,
      'viewpoint を短くしてください',
    )
    if (tooBig) return items.push({ index, status: 'invalid', label, hint: tooBig })
    seen.add(`benchAnalyses:${id}`)
    records.push({ table: 'benchAnalyses', record: rec })
    items.push({ index, status: 'created', id, table: 'benchAnalyses', label })
  })
  // 作品は、分析を1つでも作る時だけ作る（先に作る）
  if (created && records.length) {
    records.unshift({ table: 'benchWorks', record: created })
    notes.push(`ベンチ作品 ${benchWorkRef(created)} を棚に足しました`)
  }
  return { ok: true, records, items, notes }
}

// ---------- まとめ ----------

/** 書き込みツールの呼び出し1つから記録を作る */
export function buildToolCall(data: AppData, call: WriteToolCall, ctx: BuildContext): BuildResult {
  switch (call.tool) {
    case 'novel_add_proofreading':
      return buildProofreading(data, call.input, ctx)
    case 'novel_add_revision_ideas':
      return buildRevisionIdeas(data, call.input, ctx)
    case 'novel_add_strategy_note':
      return buildStrategyNote(data, call.input, ctx)
    case 'novel_save_critique_prompt':
      return buildCritiquePrompt(data, call.input, ctx)
    case 'novel_add_critique_result':
      return buildCritiqueResult(data, call.input, ctx)
    case 'novel_add_bench_analysis':
      return buildBenchAnalysis(data, call.input, ctx)
    default:
      return fail(`知らないツールです: ${String((call as { tool?: unknown }).tool)}`)
  }
}

/** 結果の件数（「追加 12件・重複 3件・見つからない 1件」） */
export function summarizeItems(items: readonly ItemResult[]): string {
  const names: Record<ItemStatus, string> = {
    created: '追加',
    duplicate: '重複',
    previously_deleted: '以前に削除',
    not_found: '見つからない',
    ambiguous: '場所が決まらない',
    invalid: '形が違う',
  }
  const counts = new Map<ItemStatus, number>()
  for (const it of items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1)
  return (Object.keys(names) as ItemStatus[])
    .filter((s) => counts.get(s))
    .map((s) => `${names[s]} ${counts.get(s)}件`)
    .join('・')
}

/** 表示用に本文の一部を切り出す（サロゲートペアの途中で切らない） */
export function excerptAround(body: string, offset: number, length: number, context = 20): string {
  const before = safeSlice(body, offset - context, offset)
  const hit = safeSlice(body, offset, offset + length)
  const after = safeSlice(body, offset + length, offset + length + context)
  return `${offset - context > 0 ? '[...]' : ''}${before}【${hit}】${after}${offset + length + context < body.length ? '[...]' : ''}`
}
