// 推敲案・改稿案・戦略メモ・作品批評の並び（アプリの画面と、コネクタの一覧で同じ並びにする）。
// - 改稿案: チェックしていない案は order の順（同じなら作った順）、チェックした案はその後ろにチェックした順（斜線＋グレーで下へ沈む）
// - 推敲案: チェックしていない案が先。その中でフラグを立てた案が先、次に新しい順（同じ時に作った案は読む順・本文の位置の順）。
//   チェックした案も同じ順で、その後ろ
// - 戦略メモ・作品批評の結果・推敲案の実行: 新しい日付から（同じ日なら新しく作った順）。戦略メモ・作品批評の結果を
//   分けて記録したもの（大きすぎてコネクタが分けるように答えた時など。「（1/3）」「（2/3）」…）は、まとめて番号の順
// - 批評プロンプト: このタイトルのもの（order の順）と、共通のもの（order の順）
// - ベンチ作品の分析（2.5）は benchOrder.ts（ホームの棚から読むので、推敲案の場所を探す部品を読み込まないように分けている）
import { adoptedText, isSplit } from '../domain/structure'
import { hashJson } from '../domain/hash'
import type {
  AppData,
  CritiquePrompt,
  CritiqueResult,
  ID,
  ProofBatch,
  ProofSuggestion,
  RevisionIdea,
  StrategyNote,
} from '../domain/types'
import { reanchor } from './anchor'
import { newestFirst, newestFirstWithParts, partMarkOf, type PartOf } from './parts'
import { readingOrder, type ReadingItem } from './refs'

export { partMarkOf, type PartMark } from './parts'

const byId = (a: { id: ID }, b: { id: ID }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 改稿案の並び（チェックしていない案 → チェックした案） */
export function sortRevisionIdeas(list: readonly RevisionIdea[]): RevisionIdea[] {
  return [...list].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1
    if (a.checked) return (a.checkedAt ?? 0) - (b.checkedAt ?? 0) || a.order - b.order || byId(a, b)
    return a.order - b.order || a.createdAt - b.createdAt || byId(a, b)
  })
}

export function revisionIdeasOf(data: AppData, titleId: ID): RevisionIdea[] {
  return sortRevisionIdeas(Object.values(data.revisionIdeas).filter((r) => r.titleId === titleId))
}

/** 推敲案の読む順の位置（話の順・幕の順、本文の位置） */
export type ProofRank = (s: ProofSuggestion) => readonly [number, number]

/** 読む順（話の順 → 幕の順）→ 本文の位置。見つからない話・場所の無い案は後ろ */
export function proofStoryRank(data: AppData, titleId: ID): ProofRank {
  const pos = new Map<ID, number>()
  readingOrder(data, titleId).forEach((it, i) => {
    pos.set(it.piece.id, i * 1000)
    ;(it.piece.actIds ?? []).forEach((a, j) => pos.set(a, i * 1000 + j + 1))
  })
  const END = Number.MAX_SAFE_INTEGER
  return (s) => [pos.get(s.pieceId) ?? (s.parentId ? (pos.get(s.parentId) ?? END) : END), s.anchor?.offset ?? END]
}

/**
 * 推敲案の並び（チェックしていない案 → チェックした案。それぞれフラグ → 新しい順）。同じ時に作った案（1回の追加・貼り付け）は
 * rank があれば読む順（話 → 幕 → 本文の位置）、無ければ id の順
 */
export function sortProofSuggestions(list: readonly ProofSuggestion[], rank?: ProofRank): ProofSuggestion[] {
  const ranks = rank ? new Map(list.map((s) => [s.id, rank(s)])) : null
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    if (ranks) {
      const ra = ranks.get(a.id)!
      const rb = ranks.get(b.id)!
      if (ra[0] !== rb[0]) return ra[0] - rb[0]
      if (ra[1] !== rb[1]) return ra[1] - rb[1]
    }
    return byId(a, b)
  })
}

export function proofSuggestionsOf(data: AppData, titleId: ID): ProofSuggestion[] {
  return sortProofSuggestions(
    Object.values(data.proofSuggestions).filter((s) => s.titleId === titleId),
    proofStoryRank(data, titleId),
  )
}

/**
 * 話・幕のチェックしていない推敲案（原稿画面の「推敲案 n」）。話は、話のものと、その話の幕のもの
 * （幕に分けている間の幕のもの・幕をつないだ／セパレートを解除する前に幕を指していたもの。parentId が話）。
 * 幕は、その幕のもの（いま別の幕で見つかるものは除く）と、話のもの（幕に分ける前に作った案）・ほかの幕や無くなった幕の
 * もの（さらに分けた・つないだ後）のうち、いまこの幕で見つかるもの（reanchor）
 */
export function openProofSuggestionsFor(data: AppData, pieceId: ID): ProofSuggestion[] {
  const piece = data.pieces[pieceId]
  const ids = new Set<ID>([pieceId])
  if (piece && isSplit(piece)) for (const id of piece.actIds ?? []) ids.add(id)
  const parentId = piece?.kind === 'act' ? (piece.parentId ?? null) : null
  const list = Object.values(data.proofSuggestions).filter((s) => {
    if (s.done) return false
    if (!parentId) return ids.has(s.pieceId) || (s.parentId !== null && ids.has(s.parentId))
    const mine = s.pieceId === pieceId
    if (!mine && s.pieceId !== parentId && s.parentId !== parentId) return false
    const r = reanchor(data, s)
    // 見つからない案はその幕に残す（「本文が変わりました」を出す）
    if (r.status === 'lost') return mine
    return r.pieceId === pieceId
  })
  return sortProofSuggestions(list, piece ? proofStoryRank(data, piece.titleId) : undefined)
}

/** 戦略メモの分けた部分: 見出し（無ければ本文の最初の行）の番号。同じ日・同じ数に分けたものをまとめる */
const notePart: PartOf<StrategyNote> = (n) => {
  const mark = partMarkOf(n.heading) ?? partMarkOf(n.body)
  return mark ? { key: `${n.runDate}\u0000${mark.count}`, mark } : null
}

/** 批評の結果の分けた部分: 結果の最初の行の番号。同じ日・同じプロンプト・同じ範囲・同じ数に分けたものをまとめる */
const resultPart: PartOf<CritiqueResult> = (r) => {
  const mark = partMarkOf(r.resultMarkdown)
  if (!mark) return null
  const scope = r.scope?.kind === 'range' ? `${r.scope.fromPieceId}-${r.scope.toPieceId}` : 'whole'
  return { key: [r.runDate, r.promptId ?? '', r.promptId ? '' : r.promptName, scope, mark.count].join('\u0000'), mark }
}

export function strategyNotesOf(data: AppData, titleId: ID): StrategyNote[] {
  return newestFirstWithParts(
    Object.values(data.strategyNotes).filter((n) => n.titleId === titleId),
    notePart,
  )
}

export function critiqueResultsOf(data: AppData, titleId: ID): CritiqueResult[] {
  return newestFirstWithParts(
    Object.values(data.critiqueResults).filter((r) => r.titleId === titleId),
    resultPart,
  )
}

export function proofBatchesOf(data: AppData, titleId: ID): ProofBatch[] {
  return Object.values(data.proofBatches)
    .filter((b) => b.titleId === titleId)
    .sort(newestFirst)
}

const byOrder = (a: CritiquePrompt, b: CritiquePrompt) => a.order - b.order || a.createdAt - b.createdAt || byId(a, b)

/** 批評プロンプト（このタイトルのものと、共通のもの） */
export function critiquePromptsOf(data: AppData, titleId: ID): { title: CritiquePrompt[]; shared: CritiquePrompt[] } {
  const all = Object.values(data.critiquePrompts)
  return {
    title: all.filter((p) => p.titleId === titleId).sort(byOrder),
    shared: all.filter((p) => p.titleId === null).sort(byOrder),
  }
}

// ---------- 推敲案の実行（ワードサーチの記録） ----------

export interface ProofRun {
  runId: ID
  runLabel: string
  runDate: string
  /** この実行で作った推敲案の数（いま残っているもの） */
  count: number
  batches: ProofBatch[]
}

/** 推敲案の実行（新しい日付から）。「10/28 ワードサーチ（第1〜20話）37件」の一覧に使う */
export function proofRunsOf(data: AppData, titleId: ID): ProofRun[] {
  const runs = new Map<ID, ProofRun>()
  for (const b of proofBatchesOf(data, titleId)) {
    let run = runs.get(b.runId)
    if (!run) {
      run = { runId: b.runId, runLabel: b.runLabel, runDate: b.runDate, count: 0, batches: [] }
      runs.set(b.runId, run)
    }
    run.batches.push(b)
  }
  for (const s of Object.values(data.proofSuggestions)) {
    if (s.titleId !== titleId || !s.runId) continue
    const run = runs.get(s.runId)
    if (run) run.count += 1
  }
  return [...runs.values()]
}

/** 確かめた範囲（「未確認 #41〜#300、本文が変わった話 #12」） */
export interface ProofCoverage {
  /** 一度も確かめていない話（読む順） */
  unchecked: ReadingItem[]
  /** 確かめた後に採用原稿が変わった話 */
  changed: ReadingItem[]
  /** 一度でも確かめた話がある */
  any: boolean
  /** 「未確認 #41〜#300、本文が変わった話 #12」（すべて確かめていて変わっていなければ「すべて確認済み」、記録が無ければ空） */
  text: string
}

/** 話の採用原稿の指紋（確かめた時の控えと比べる。幕に分けた話は各幕の採用稿をつないだもの） */
export function adoptedBodyHash(data: AppData, pieceId: ID): string {
  const piece = data.pieces[pieceId]
  const t = piece ? adoptedText(data, piece) : null
  return t ? hashJson(t.body) : ''
}

/** 読む順の番号の並びを「#1〜#3、#5」のようにまとめる */
export function indexRanges(indexes: readonly number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
    out.push(j > i ? `#${sorted[i]}〜#${sorted[j]}` : `#${sorted[i]}`)
    i = j + 1
  }
  return out.join('、')
}

/** タイトルの推敲案の実行で確かめた範囲。話ごとに、最後に確かめた時の採用原稿の指紋といまの指紋を比べる */
export function proofCoverage(data: AppData, titleId: ID): ProofCoverage {
  const latest = new Map<ID, { at: number; bodyHash: string }>()
  for (const b of Object.values(data.proofBatches)) {
    if (b.titleId !== titleId) continue
    for (const c of b.covered) {
      const prev = latest.get(c.pieceId)
      if (!prev || b.createdAt >= prev.at) latest.set(c.pieceId, { at: b.createdAt, bodyHash: c.bodyHash })
    }
  }
  const order = readingOrder(data, titleId)
  const unchecked: ReadingItem[] = []
  const changed: ReadingItem[] = []
  for (const item of order) {
    const seen = latest.get(item.piece.id)
    // 幕を確かめた記録は、話の記録として扱わない（幕の採用稿が変わっても話の全体は分からない）
    if (!seen) unchecked.push(item)
    else if (seen.bodyHash !== adoptedBodyHash(data, item.piece.id)) changed.push(item)
  }
  const any = latest.size > 0 && unchecked.length < order.length
  const parts: string[] = []
  if (unchecked.length) parts.push(`未確認 ${indexRanges(unchecked.map((x) => x.index))}`)
  if (changed.length) parts.push(`本文が変わった話 ${indexRanges(changed.map((x) => x.index))}`)
  const text = !any ? '' : parts.length ? parts.join('、') : 'すべて確認済み'
  return { unchecked, changed, any, text }
}
