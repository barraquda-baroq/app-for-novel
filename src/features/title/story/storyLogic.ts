// 本編タブ・章ページで使う、表示用の純粋な計算（データは変更しない）。
import { entriesOf } from '../../../domain/entityOps'
import * as S from '../../../domain/storyOps'
import type { InsertOption } from '../../../domain/storyOps'
import {
  activeBody,
  effectiveNumbering,
  episodeLabel,
  episodeNumbers,
  flatten,
  locatePiece,
  pieceLabel,
} from '../../../domain/structure'
import { countChars, textStats } from '../../../domain/text'
import type { AppData, Chapter, ID, Piece, Slot } from '../../../domain/types'

// ---------- 話数追加のプレビュー ----------

export interface EpisodePreview {
  /** 作成される話の話数 */
  number: number
  /** 入る章（タイトル直下なら null） */
  chapterId: ID | null
  /** 「第4話」や「「第2章」の第1話」のような説明 */
  description: string
  /** どこに入るかの説明（「「第2話」の後（「エピローグ」の前）に入ります。」）。前後に何もなければ null */
  placement: string | null
}

/**
 * 話数追加をしたら何話が作られるかを、現在のデータ上でシミュレーションして求める。
 * 追加できない指定なら null。
 */
export function previewEpisode(data: AppData, titleId: ID, target?: ID | null): EpisodePreview | null {
  const title = data.titles[titleId]
  if (!title) return null
  try {
    const r = S.addEpisode(data, titleId, target)
    const number = episodeNumbers(r.data, titleId)[r.result]
    const chapterId = locatePiece(r.data, r.result)?.chapterId ?? null
    const label = `第${number}話`
    let description = label
    if (effectiveNumbering(title) === 'perChapter') {
      description = chapterId ? `「${chapterName(data.chapters[chapterId])}」の${label}` : `タイトル直下の${label}`
    }
    return { number, chapterId, description, placement: describePlacement(data, r.data, titleId, r.result) }
  } catch {
    return null
  }
}

/**
 * 新しい話（sim 上の newId。planEpisodeSlot の位置に入っている）の前後の並びから、入る位置を説明する。
 * 章が有効なら同じ章（またはタイトル直下）の中の前後、無効なら読む順の前後。表記は追加前の data で数える。
 */
function describePlacement(data: AppData, sim: AppData, titleId: ID, newId: ID): string | null {
  const title = sim.titles[titleId]
  if (!title) return null
  const numbers = episodeNumbers(data, titleId)
  const pieceName = (id: ID | undefined) => {
    const p = id ? data.pieces[id] : undefined
    return p ? `「${pieceLabel(data, p, numbers)}」` : null
  }
  let prev: string | null = null
  let next: string | null = null
  let where = ''
  if (!title.chaptersEnabled) {
    const flat = flatten(sim, titleId)
    const i = flat.findIndex((f) => f.pieceId === newId)
    if (i < 0) return null
    prev = pieceName(flat[i - 1]?.pieceId)
    next = pieceName(flat[i + 1]?.pieceId)
  } else {
    const slot = locatePiece(sim, newId)
    if (!slot) return null
    if (slot.chapterId) {
      const ids = sim.chapters[slot.chapterId]?.pieceIds ?? []
      const chName = `「${chapterName(data.chapters[slot.chapterId])}」`
      prev = pieceName(ids[slot.index - 1])
      next = pieceName(ids[slot.index + 1])
      if (!prev && !next) return `${chName}に入ります。`
      where = `${chName}の中の`
    } else {
      const nodeName = (i: number) => {
        const node = title.structure[i]
        if (!node) return null
        return node.type === 'piece' ? pieceName(node.id) : `「${chapterName(data.chapters[node.id])}」`
      }
      prev = nodeName(slot.index - 1)
      next = nodeName(slot.index + 1)
      where = 'タイトル直下の'
    }
  }
  if (prev && next) return `${where}${prev}の後（${next}の前）に入ります。`
  if (prev) return `${where}${prev}の後に入ります。`
  if (next) return `${where}先頭（${next}の前）に入ります。`
  return null
}

export function chapterName(chapter: Chapter | undefined): string {
  return chapter?.name.trim() || '無題の章'
}

/**
 * 話数追加ダイアログの「追加先の章」の既定値。
 * 最新話（読む順で最後の話）がある章が候補にあればそれ、なければ最初の候補。
 */
export function defaultEpisodeTarget(data: AppData, titleId: ID, targets: { chapterId: ID | null }[]): ID | null | undefined {
  if (targets.length === 0) return undefined
  const flat = flatten(data, titleId)
  for (let i = flat.length - 1; i >= 0; i--) {
    if (data.pieces[flat[i].pieceId].kind !== 'episode') continue
    const chapterId = flat[i].chapterId
    if (targets.some((t) => t.chapterId === chapterId)) return chapterId
    break
  }
  return targets[0].chapterId
}

// ---------- 特殊追加 ----------

export const SPECIAL_SUGGESTIONS = ['プロローグ', 'エピローグ', '幕間', '間章', '番外編', 'あとがき'] as const

/** 見出しから既定の差し込み位置を決める（プロローグは先頭、エピローグ・あとがきは末尾） */
export function specialPositionPreference(label: string): 'first' | 'last' | null {
  const l = label.trim()
  if (l === 'プロローグ') return 'first'
  if (l === 'エピローグ' || l === 'あとがき') return 'last'
  return null
}

export function sameSlot(a: Slot, b: Slot): boolean {
  return a.chapterId === b.chapterId && a.index === b.index
}

/** 選択肢の中で slot と同じ位置を指すもののインデックス（なければ -1） */
export function findSlotIndex(options: InsertOption[], slot: Slot | null): number {
  if (!slot) return -1
  return options.findIndex((o) => sameSlot(o.slot, slot))
}

/** 章の中だけに絞った差し込み位置 */
export function optionsWithinChapter(options: InsertOption[], chapterId: ID): InsertOption[] {
  return options.filter((o) => o.slot.chapterId === chapterId)
}

// ---------- 移動のプレビュー ----------

/** 移動したらその話の表記（第n話）がどうなるか。移動できなければ null */
export function previewMoveLabel(data: AppData, pieceId: ID, slot: Slot): string | null {
  try {
    const sim = S.movePiece(data, pieceId, slot)
    const piece = sim.pieces[pieceId]
    return piece ? pieceLabel(sim, piece) : null
  } catch {
    return null
  }
}

/**
 * 各話を1つ上/下に動かせるか（movePieceStep が実際に動かすかどうか）。
 * 章が無効なら読む順の端は動かせない。章が有効なら、章の中の話は章の外へ出られるので常に動かせる。
 */
export function stepAvailability(data: AppData, titleId: ID): Record<ID, { up: boolean; down: boolean }> {
  const title = data.titles[titleId]
  const result: Record<ID, { up: boolean; down: boolean }> = {}
  if (!title) return result
  const flat = flatten(data, titleId)
  if (!title.chaptersEnabled) {
    flat.forEach((f, i) => {
      result[f.pieceId] = { up: i > 0, down: i < flat.length - 1 }
    })
    return result
  }
  for (const f of flat) {
    if (f.chapterId) {
      result[f.pieceId] = { up: true, down: true }
    } else {
      result[f.pieceId] = { up: f.index > 0, down: f.index < title.structure.length - 1 }
    }
  }
  return result
}

/** 章をタイトル直下の並びの中で上/下に動かせるか */
export function chapterStepAvailability(data: AppData, chapterId: ID): { up: boolean; down: boolean } {
  const ch = data.chapters[chapterId]
  const title = ch ? data.titles[ch.titleId] : undefined
  if (!ch || !title) return { up: false, down: false }
  const i = title.structure.findIndex((n) => n.type === 'chapter' && n.id === chapterId)
  return { up: i > 0, down: i >= 0 && i < title.structure.length - 1 }
}

// ---------- 章の解除 ----------

export interface Renumbered {
  pieceId: ID
  /** 解除前の表記（第n話） */
  before: string
  /** 解除後の表記（第n話） */
  after: string
  subtitle: string
}

/**
 * 章を解除したら話数が変わる話（読む順）。章ごとに第1話から数えている時は、
 * 中の話が章の外の話として数え直されるので話数が変わる。通し番号なら変わらない（空配列）。
 */
export function renumberingOnRelease(data: AppData, chapterId: ID): Renumbered[] {
  const ch = data.chapters[chapterId]
  if (!ch) return []
  let sim: AppData
  try {
    sim = S.removeChapter(data, chapterId)
  } catch {
    return []
  }
  const before = episodeNumbers(data, ch.titleId)
  const after = episodeNumbers(sim, ch.titleId)
  const out: Renumbered[] = []
  for (const f of flatten(sim, ch.titleId)) {
    const p = sim.pieces[f.pieceId]
    if (p.kind !== 'episode' || !before[p.id] || !after[p.id] || before[p.id] === after[p.id]) continue
    out.push({ pieceId: p.id, before: episodeLabel(before[p.id]), after: episodeLabel(after[p.id]), subtitle: p.subtitle.trim() })
  }
  return out
}

/** 「第1話「旅立ち」→第2話、第2話→第3話 ほか2話」のような説明 */
export function formatRenumbering(items: Renumbered[], max = 5): string {
  const shown = items
    .slice(0, max)
    .map((r) => `${r.before}${r.subtitle ? `「${r.subtitle}」` : ''}→${r.after}`)
    .join('、')
  const rest = items.length - Math.min(items.length, max)
  return rest > 0 ? `${shown} ほか${rest}話` : shown
}

// ---------- 一覧の表示用の要約 ----------

export interface PieceSummary {
  versionCount: number
  /** 採用中の稿。採用原稿がなければ null */
  active: { name: string; chars: number } | null
  /** 採用原稿の冒頭（1行） */
  excerpt: string
}

export function excerptOf(text: string, max = 90): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/** メモの抜粋。改行は残し（付箋らしく箇条書きが読めるように）、空行と行頭・行末の空白は詰める */
export function memoExcerpt(text: string, maxLines = 4, maxChars = 140): string {
  const lines = text
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines)
  const joined = lines.join('\n')
  const chars = Array.from(joined)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : joined
}

export function pieceSummary(data: AppData, piece: Piece): PieceSummary {
  const versionCount = piece.versionIds.filter((id) => data.versions[id]).length
  const v = piece.activeVersionId ? data.versions[piece.activeVersionId] : undefined
  if (!v) return { versionCount, active: null, excerpt: '' }
  return { versionCount, active: { name: v.name, chars: countChars(v.body) }, excerpt: excerptOf(v.body) }
}

export interface PieceGroupStats {
  pieces: number
  episodes: number
  specials: number
  /** 採用原稿のない話・特殊ブロックの合計 */
  missingActive: number
  /** 採用原稿のない第n話の数 */
  missingEpisodes: number
  /** 採用原稿のない特殊ブロックの数 */
  missingSpecials: number
  /** 採用原稿の文字数（空白・改行除く） */
  chars: number
  /** 400字詰め原稿用紙換算（各話を新しいページから書き始めた場合） */
  pages: number
}

export function statsOfPieces(data: AppData, pieceIds: ID[]): PieceGroupStats {
  const s: PieceGroupStats = {
    pieces: 0,
    episodes: 0,
    specials: 0,
    missingActive: 0,
    missingEpisodes: 0,
    missingSpecials: 0,
    chars: 0,
    pages: 0,
  }
  for (const id of pieceIds) {
    const p = data.pieces[id]
    if (!p) continue
    s.pieces += 1
    if (p.kind === 'episode') s.episodes += 1
    else s.specials += 1
    const body = activeBody(data, p)
    if (body === null) {
      s.missingActive += 1
      if (p.kind === 'episode') s.missingEpisodes += 1
      else s.missingSpecials += 1
      continue
    }
    s.chars += countChars(body)
    s.pages += textStats(body).manuscriptPages
  }
  return s
}

export function chapterStats(data: AppData, chapterId: ID): PieceGroupStats {
  return statsOfPieces(data, data.chapters[chapterId]?.pieceIds ?? [])
}

export function titleStats(data: AppData, titleId: ID): PieceGroupStats {
  return statsOfPieces(
    data,
    flatten(data, titleId).map((f) => f.pieceId),
  )
}

/** 設定項目ごとのエントリ数 */
export function entryCounts(data: AppData, categoryIds: ID[]): Record<ID, number> {
  const out: Record<ID, number> = {}
  for (const id of categoryIds) out[id] = entriesOf(data, id).length
  return out
}
