// 戦略タブの推敲案・改稿案の表示用の純粋な計算（絞り込み・場所の表記・実行の一覧）。データは変えない。
import { reanchor, type ReanchorResult } from '../../../claude/anchor'
import { proofCategoryLabel } from '../../../claude/categories'
import { shortDate } from '../../../claude/dates'
import type { ProofRun } from '../../../claude/order'
import { actLabel, actNumber, episodeNumbers, parentOf, pieceLabel } from '../../../domain/structure'
import type { AppData, ID, Piece, ProofSuggestion } from '../../../domain/types'

export type ProofStatusFilter = 'all' | 'open' | 'done'

/** 手で書いた（実行に属さない）推敲案の絞り込みの値 */
export const MANUAL_RUN = '__manual__'

export interface ProofFilter {
  /** 種類（空 = すべて） */
  category: string
  status: ProofStatusFilter
  /** 実行（空 = すべて、MANUAL_RUN = 手で書いたもの） */
  runId: string
}

export const DEFAULT_PROOF_FILTER: ProofFilter = { category: '', status: 'all', runId: '' }

/** 並び（src/claude/order.ts）を保ったまま絞り込む */
export function filterProofSuggestions(list: readonly ProofSuggestion[], f: ProofFilter): ProofSuggestion[] {
  return list.filter(
    (s) =>
      (!f.category || s.category === f.category) &&
      (f.status === 'all' || (f.status === 'done') === s.done) &&
      (!f.runId || (f.runId === MANUAL_RUN ? s.runId === null : s.runId === f.runId)),
  )
}

export interface CategoryCount {
  value: string
  label: string
  count: number
}

/** 推敲案にある種類（多い順。同じなら名前の順） */
export function categoriesIn(list: readonly ProofSuggestion[]): CategoryCount[] {
  const map = new Map<string, CategoryCount>()
  for (const s of list) {
    const c = map.get(s.category) ?? { value: s.category, label: proofCategoryLabel(s.category, s.categoryLabel), count: 0 }
    c.count += 1
    map.set(s.category, c)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja'))
}

/** 「10/28 ワードサーチ（第1〜20話）37件」 */
export function runLine(run: Pick<ProofRun, 'runDate' | 'runLabel' | 'count'>, today?: string): string {
  return `${shortDate(run.runDate, today)} ${run.runLabel.trim() || 'Claude の推敲案'} ${run.count}件`.replace(/ +/g, ' ').trim()
}

/** 推敲案の場所 */
export interface ProofPlace {
  /** found = いまの本文で見つかった、lost = 本文が変わって見つからない、missing = 話が無い */
  state: 'found' | 'lost' | 'missing'
  /** 「第12話 第2幕 ¶14」（見つからない時は作った時の表記） */
  label: string
  /** 開く話・幕（見つからない時は、まだあれば推敲案の話・属していた話） */
  pieceId: ID | null
  result: ReanchorResult
}

/** 話・幕の短い表記（「第12話」「第12話 第2幕」「プロローグ」） */
export function shortPieceLabel(data: AppData, piece: Piece, numbers: Record<ID, number>): string {
  if (piece.kind === 'act') {
    const parent = parentOf(data, piece)
    const n = actNumber(data, piece)
    const act = n ? actLabel(n) : '第?幕'
    return parent ? `${pieceLabel(data, parent, numbers)} ${act}` : act
  }
  return pieceLabel(data, piece, numbers)
}

/**
 * 推敲案のいまの場所（本文が変わっていれば探し直す）。numbers はタイトルの話数（一覧では1回だけ数えて渡す）
 */
export function proofPlace(data: AppData, s: ProofSuggestion, numbers?: Record<ID, number>): ProofPlace {
  const nums = numbers ?? episodeNumbers(data, s.titleId)
  const result = reanchor(data, s)
  if (result.status !== 'lost') {
    const piece = data.pieces[result.pieceId]
    const base = piece ? shortPieceLabel(data, piece, nums) : s.pieceLabel
    return { state: 'found', label: `${base} ¶${result.paragraph}`, pieceId: result.pieceId, result }
  }
  const piece = data.pieces[s.pieceId] ?? (s.parentId ? data.pieces[s.parentId] : undefined)
  if (!piece || piece.titleId !== s.titleId) {
    return { state: 'missing', label: s.pieceLabel.trim() || '（話が見つかりません）', pieceId: null, result }
  }
  return { state: 'lost', label: shortPieceLabel(data, piece, nums), pieceId: piece.id, result }
}

/** 本文が変わって見つからない時の表記 */
export const LOST_LABEL = '本文が変わりました（直した可能性）'
export const MISSING_LABEL = '話が見つかりません（削除された可能性）'

/** 改稿案に結びつけた話のうち、いまもあるもの（読む順の表記付き） */
export function linkedPieces(
  data: AppData,
  titleId: ID,
  pieceIds: readonly ID[],
  numbers: Record<ID, number>,
): { id: ID; label: string }[] {
  const out: { id: ID; label: string }[] = []
  for (const id of pieceIds) {
    const p = data.pieces[id]
    if (!p || p.titleId !== titleId) continue
    out.push({ id, label: shortPieceLabel(data, p, numbers) })
  }
  return out
}

/** 長い文の最初の数行（カードを閉じている時の抜粋） */
export function previewText(text: string, maxChars = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : one
}
