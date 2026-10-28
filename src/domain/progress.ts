// 各話の進捗: その話がタイトル全体（採用原稿）の何割の位置にあるか。
// 転機が物語のどこにあるかを見るためのもので、文字数で測る（その話の終わりまでの採用原稿の文字数 ÷ 全体）。
// 幕に分けた話は各幕の採用稿をつないだ本文で数える（幕の位置は actProgress）。
import { actParts, adoptedMetrics, flatten } from './structure'
import { bodyMetrics } from './text'
import type { AppData, ID, Piece } from './types'

export interface PieceProgress {
  /** この話の前までの文字数 */
  before: number
  /** この話の採用原稿の文字数（採用原稿がなければ 0） */
  chars: number
  /** タイトル全体の採用原稿の文字数 */
  total: number
  /** この話の終わりの位置（0〜1）。全体が 0 文字なら null */
  end: number | null
  /** この話の始まりの位置（0〜1）。全体が 0 文字なら null */
  start: number | null
}

/** タイトルの各話の進捗（読む順） */
export function titleProgress(data: AppData, titleId: ID): Map<ID, PieceProgress> {
  const items = flatten(data, titleId)
  const chars = items.map((it) => adoptedMetrics(data, data.pieces[it.pieceId])?.chars ?? 0)
  const total = chars.reduce((a, b) => a + b, 0)
  const out = new Map<ID, PieceProgress>()
  let before = 0
  items.forEach((it, i) => {
    out.set(it.pieceId, {
      before,
      chars: chars[i],
      total,
      start: total > 0 ? before / total : null,
      end: total > 0 ? (before + chars[i]) / total : null,
    })
    before += chars[i]
  })
  return out
}

/**
 * 幕に分けた話の各幕の進捗（幕の終わりがタイトル全体の何割の位置か）。
 * episode はその話の進捗（titleProgress の値）。幕の文字数は各幕の採用稿で数える
 */
export function actProgress(data: AppData, piece: Piece, episode: PieceProgress | undefined): Map<ID, PieceProgress> {
  const out = new Map<ID, PieceProgress>()
  if (!episode) return out
  const { total } = episode
  let before = episode.before
  for (const x of actParts(data, piece)) {
    const chars = x.version ? bodyMetrics(x.version).chars : 0
    out.set(x.act.id, {
      before,
      chars,
      total,
      start: total > 0 ? before / total : null,
      end: total > 0 ? Math.min(1, (before + chars) / total) : null,
    })
    before += chars
  }
  return out
}

/** 「34%」のような表記（全体が 0 文字なら「—」） */
export function formatProgress(ratio: number | null): string {
  if (ratio === null) return '—'
  return `${Math.round(ratio * 100)}%`
}
