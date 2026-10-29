// 作品批評をした時点の採用原稿の控え（文字数・話数・指紋）。批評の結果に添えて、
// 「286,400字・120話の時点（現在 +3,200字）」のように、いまの原稿とどれだけ違うかを出す。
import { hashJson } from '../domain/hash'
import { adoptedMetrics, flatten } from '../domain/structure'
import { formatCount } from '../domain/text'
import type { AppData, CritiqueManuscript, ID } from '../domain/types'

/**
 * タイトルの採用原稿の控え。chars = 採用原稿の文字数（空白・改行・記法を除く）、pieces = 話（第n話・特殊ブロック）の数、
 * hash = 読む順の各話の採用原稿の指紋をつないだものの指紋（本文が1字でも変われば変わる）
 */
export function manuscriptOf(data: AppData, titleId: ID, at: number): CritiqueManuscript {
  let chars = 0
  let pieces = 0
  const parts: string[] = []
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    pieces += 1
    const m = adoptedMetrics(data, piece)
    if (m) chars += m.chars
    parts.push(`${piece.id}:${m ? `${m.hash}.${m.chars}` : '-'}`)
  }
  return { chars, pieces, hash: hashJson(parts.join('\n')), at }
}

/** 「286,400字・120話の時点（現在 +3,200字）」。current が無ければ括弧を付けない */
export function manuscriptLabel(m: CritiqueManuscript, current?: CritiqueManuscript): string {
  const base = `${formatCount(m.chars)}字・${formatCount(m.pieces)}話の時点`
  if (!current) return base
  if (current.hash === m.hash) return `${base}（現在と同じ）`
  const diff = current.chars - m.chars
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±'
  const pieces = current.pieces !== m.pieces ? `・${formatCount(current.pieces)}話` : ''
  return `${base}（現在 ${sign}${formatCount(Math.abs(diff))}字${pieces}）`
}
