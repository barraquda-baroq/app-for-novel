// 各話の進捗: その話がタイトル全体（採用原稿）の何割の位置にあるか。
// 転機が物語のどこにあるかを見るためのもので、文字数で測る（その話の終わりまでの採用原稿の文字数 ÷ 全体）。
import { activeVersion, flatten } from './structure'
import { bodyMetrics } from './text'
import type { AppData, ID } from './types'

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
  const chars = items.map((it) => {
    const v = activeVersion(data, data.pieces[it.pieceId])
    return v ? bodyMetrics(v).chars : 0
  })
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

/** 「34%」のような表記（全体が 0 文字なら「—」） */
export function formatProgress(ratio: number | null): string {
  if (ratio === null) return '—'
  return `${Math.round(ratio * 100)}%`
}
