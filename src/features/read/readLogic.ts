// 通し読み画面の表示用の純粋な計算（範囲の決定・目次・文字数・縦中横など）。
import type { ReadBlock } from '../../domain/readthrough'
import { activeVersion, adoptedText, chaptersOf } from '../../domain/structure'
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
  /** 採用原稿のない話（幕に分けた話は数えず、採用稿のない幕を missingActs に数える） */
  missing: number
  /** 採用稿のない幕 */
  missingActs: number
  chars: number
  pages: number
}

/**
 * 話の採用原稿（本文を持つレコード。採用原稿がなければ null）。
 * 幕に分けた話は各幕の採用稿をつないだもの（本文が変わらない限り同じオブジェクトなので、文字数などを覚えておける）
 */
export function pieceVersion(data: AppData, pieceId: ID): { body: string } | null {
  const piece = data.pieces[pieceId]
  return piece ? adoptedText(data, piece) : null
}

/** 幕の採用稿（採用稿がなければ null） */
export function actVersion(data: AppData, actId: ID): Version | null {
  const act = data.pieces[actId]
  return act ? activeVersion(data, act) : null
}

/** 採用原稿の話数・文字数・枚数。文字数は稿ごとに覚えておいた値を使う（長編でも全文を数え直さない） */
export function readStats(data: AppData, blocks: ReadBlock[]): ReadStats {
  const s: ReadStats = { pieces: 0, missing: 0, missingActs: 0, chars: 0, pages: 0 }
  for (const b of blocks) {
    if (b.type !== 'piece') continue
    s.pieces += 1
    if (b.acts) s.missingActs += b.acts.reduce((n, a) => n + (a.body === null ? 1 : 0), 0)
    const v = b.body === null ? null : pieceVersion(data, b.pieceId)
    if (!v) {
      if (!b.acts) s.missing += 1
      continue
    }
    const m = bodyMetrics(v)
    s.chars += m.chars
    s.pages += m.manuscriptPages
  }
  return s
}

/** 「採用原稿なし 2話＋1幕」（なければ空文字） */
export function readMissingLabel(s: Pick<ReadStats, 'missing' | 'missingActs'>): string {
  const parts: string[] = []
  if (s.missing > 0) parts.push(`${s.missing}話`)
  if (s.missingActs > 0) parts.push(`${s.missingActs}幕`)
  return parts.length > 0 ? `採用原稿なし ${parts.join('＋')}` : ''
}

export function pieceAnchorId(pieceId: ID): string {
  return `rt-piece-${pieceId}`
}

export function actAnchorId(actId: ID): string {
  return `rt-act-${actId}`
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
