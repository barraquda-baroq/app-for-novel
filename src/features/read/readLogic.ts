// 通し読み画面の表示用の純粋な計算（範囲の決定・目次・文字数・縦中横など）。
import type { ReadBlock } from '../../domain/readthrough'
import { activeVersion, chaptersOf } from '../../domain/structure'
import { bodyMetrics } from '../../domain/text'
import type { AppData, ID, Version } from '../../domain/types'

export const FONT_MIN = 14
export const FONT_MAX = 28

export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return 17
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))
}

/**
 * ?chapter= の値から、実際に絞り込む章を決める。
 * 章管理がオフ・存在しない章・別タイトルの章なら undefined（全体を表示）。
 */
export function resolveChapterScope(data: AppData, titleId: ID, chapterParam: string | null): ID | undefined {
  if (!chapterParam) return undefined
  const title = data.titles[titleId]
  if (!title || !title.chaptersEnabled) return undefined
  return chaptersOf(data, titleId).some((c) => c.id === chapterParam) ? chapterParam : undefined
}

export type PieceBlock = Extract<ReadBlock, { type: 'piece' }>

export interface TocGroup {
  chapterId: ID | null
  /** 章見出し（章がない・章の外なら null） */
  name: string | null
  items: PieceBlock[]
}

/** 目次。章見出しごとにまとめる（章見出しより前の話は name = null のグループ） */
export function tocGroups(blocks: ReadBlock[]): TocGroup[] {
  const groups: TocGroup[] = []
  let current: TocGroup | null = null
  for (const b of blocks) {
    if (b.type === 'chapter') {
      current = { chapterId: b.chapterId, name: b.name.trim() || '無題の章', items: [] }
      groups.push(current)
      continue
    }
    if (b.type === 'chapterEnd') continue
    // 章の外に出た話（章が有効なとき、章の後ろにタイトル直下の話がある場合）
    if (!current || (current.chapterId !== null && b.chapterId !== current.chapterId)) {
      current = { chapterId: null, name: null, items: [] }
      groups.push(current)
    }
    current.items.push(b)
  }
  return groups
}

export interface ReadStats {
  pieces: number
  missing: number
  chars: number
  pages: number
}

/** 話の採用中の推敲バージョン（採用原稿がなければ null） */
export function pieceVersion(data: AppData, pieceId: ID): Version | null {
  const piece = data.pieces[pieceId]
  return piece ? activeVersion(data, piece) : null
}

/** 採用原稿の話数・文字数・枚数。文字数は稿ごとに覚えておいた値を使う（長編でも全文を数え直さない） */
export function readStats(data: AppData, blocks: ReadBlock[]): ReadStats {
  const s: ReadStats = { pieces: 0, missing: 0, chars: 0, pages: 0 }
  for (const b of blocks) {
    if (b.type !== 'piece') continue
    s.pieces += 1
    const v = b.body === null ? null : pieceVersion(data, b.pieceId)
    if (!v) {
      s.missing += 1
      continue
    }
    const m = bodyMetrics(v)
    s.chars += m.chars
    s.pages += m.manuscriptPages
  }
  return s
}

export function pieceAnchorId(pieceId: ID): string {
  return `rt-piece-${pieceId}`
}

/**
 * 縦書きで2桁までの半角数字を縦中横にするための分割。
 * 「第12話」→ ['第', { tcy: '12' }, '話']。3桁以上はそのまま（横倒しで表示される）。
 */
export function splitTcy(text: string): (string | { tcy: string })[] {
  const out: (string | { tcy: string })[] = []
  const re = /(?<![0-9])[0-9]{1,2}(?![0-9])/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    out.push({ tcy: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
