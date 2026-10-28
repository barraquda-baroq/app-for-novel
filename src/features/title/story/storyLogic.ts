// 本編タブ・章ページで使う、表示用の純粋な計算（データは変更しない）。
import { joinError } from '../../../domain/acts'
import { entriesOf } from '../../../domain/entityOps'
import { actProgress, formatProgress, titleProgress, type PieceProgress } from '../../../domain/progress'
import { hasRubyMarkup, parseRuby, type RubySegment } from '../../../domain/ruby'
import * as S from '../../../domain/storyOps'
import type { InsertOption } from '../../../domain/storyOps'
import {
  activeVersion,
  actLabel,
  actParts,
  adoptedText,
  canDeletePiece,
  effectiveNumbering,
  episodeLabel,
  episodeNumbers,
  flatten,
  isSplit,
  locatePiece,
  pieceFullLabel,
  pieceLabel,
  scopeKey,
  type Permission,
} from '../../../domain/structure'
import { bodyMetrics } from '../../../domain/text'
import type { AppData, Chapter, ID, Piece, Slot, Version } from '../../../domain/types'

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
// 長編（数百話・数百万字）でも一覧の操作が重くならないよう、本文の文字数・枚数は稿ごとにキャッシュされる
// bodyMetrics を使い、抜粋は本文の先頭だけを見る。

export interface PieceSummary {
  versionCount: number
  /** 採用中の稿。採用原稿がなければ null */
  active: { name: string; chars: number } | null
  /** 採用原稿の冒頭（1行。ルビ・傍点は分けてある）。なければ空配列 */
  excerpt: RubySegment[]
}

const SPACE = /\s/u

/** 本文の冒頭 max 文字（空白・改行の並びは1つの空白に詰める）。本文全体は処理せず、必要な先頭だけを見る */
export function excerptOf(text: string, max = 90): string {
  let out = ''
  let count = 0
  let pendingSpace = false
  for (const ch of text) {
    if (SPACE.test(ch)) {
      // 先頭と末尾の空白は捨て、途中の空白の並びは次の文字の前に1つだけ入れる
      if (count > 0) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      if (count >= max) return `${out}…`
      out += ' '
      count += 1
      pendingSpace = false
    }
    if (count >= max) return `${out}…`
    out += ch
    count += 1
  }
  return out
}

/**
 * ルビ・傍点の記法を読むための表示にした抜粋（excerptOf と同じ詰め方・切り詰め方で、見える文字で数える）。
 * 記法の途中では切らない（ルビは親文字ごと入れるか、入れずに「…」で終える）。
 * 記法は改行をまたがないので、本文全体は分けず、抜粋に要る先頭の行だけを1行ずつ分ける。
 */
export function excerptSegments(text: string, max = 90): RubySegment[] {
  if (!hasRubyMarkup(text)) {
    const plain = excerptOf(text, max)
    return plain ? [{ type: 'text', text: plain }] : []
  }
  const out: RubySegment[] = []
  let count = 0
  let pendingSpace = false
  /** 末尾が同じ種類（地の文・傍点）ならつなげる */
  const append = (type: 'text' | 'bouten', s: string) => {
    const last = out[out.length - 1]
    if (last && last.type === type) last.text += s
    else out.push({ type, text: s })
  }
  /** 次に見える文字を足す前の空白（地の文として足す）。上限に達して足せなければ false */
  const beforeVisible = (): boolean => {
    if (pendingSpace) {
      if (count >= max) return false
      append('text', ' ')
      count += 1
      pendingSpace = false
    }
    return count < max
  }
  const done = () => {
    append('text', '…')
    return out
  }
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    for (const seg of parseRuby(text.slice(start, end))) {
      if (seg.type === 'ruby') {
        if (!beforeVisible()) return done()
        out.push(seg)
        count += Array.from(seg.base).length
        continue
      }
      for (const ch of seg.text) {
        if (SPACE.test(ch)) {
          if (count > 0) pendingSpace = true
          continue
        }
        if (!beforeVisible()) return done()
        append(seg.type, ch)
        count += 1
      }
    }
    // 改行も空白として詰める
    if (count > 0) pendingSpace = true
    start = end + 1
  }
  return out
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

/** 話の推敲バージョンの数（参照切れは数えない） */
export function versionCountOf(data: AppData, piece: Piece): number {
  let n = 0
  for (const id of piece.versionIds) if (data.versions[id]) n += 1
  return n
}

/** 採用中の稿と稿の数から一覧の要約を作る（文字数は稿ごとのキャッシュを使う） */
export function summarize(version: Version | null, versionCount: number): PieceSummary {
  if (!version) return { versionCount, active: null, excerpt: [] }
  return {
    versionCount,
    active: { name: version.name, chars: bodyMetrics(version).chars },
    excerpt: excerptSegments(version.body),
  }
}

export function pieceSummary(data: AppData, piece: Piece): PieceSummary {
  return summarize(activeVersion(data, piece), versionCountOf(data, piece))
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
  /** 幕に分けた話のうち、採用稿のない幕の数（missingActive にも入る） */
  missingActs: number
  /** 採用原稿の文字数（空白・改行除く） */
  chars: number
  /** 400字詰め原稿用紙換算（各話を新しいページから書き始めた場合） */
  pages: number
}

/** 集計する1話分。text は上位に反映される本文（幕に分けた話は各幕の採用稿をつないだもの） */
export interface StatsEntry {
  piece: Piece
  text: { body: string } | null
  /** 幕に分けた話の幕（採用稿のない幕を数える）。分けていなければ null */
  acts?: readonly { version: Version | null }[] | null
}

/** 話と採用原稿の組から集計する（文字数・枚数は稿ごとのキャッシュを使うので、本文を数え直さない） */
export function statsOf(entries: readonly StatsEntry[]): PieceGroupStats {
  const s: PieceGroupStats = {
    pieces: 0,
    episodes: 0,
    specials: 0,
    missingActive: 0,
    missingEpisodes: 0,
    missingSpecials: 0,
    missingActs: 0,
    chars: 0,
    pages: 0,
  }
  for (const { piece, text, acts } of entries) {
    s.pieces += 1
    if (piece.kind === 'episode') s.episodes += 1
    else s.specials += 1
    if (acts) {
      // 幕に分けた話は、採用稿のない幕を採用原稿のないものとして数える
      const missing = acts.reduce((n, a) => n + (a.version ? 0 : 1), 0)
      s.missingActs += missing
      s.missingActive += missing
    } else if (!text) {
      s.missingActive += 1
      if (piece.kind === 'episode') s.missingEpisodes += 1
      else s.missingSpecials += 1
    }
    if (!text) continue
    const m = bodyMetrics(text)
    s.chars += m.chars
    s.pages += m.manuscriptPages
  }
  return s
}

export function statsOfPieces(data: AppData, pieceIds: ID[]): PieceGroupStats {
  const entries: StatsEntry[] = []
  for (const id of pieceIds) {
    const piece = data.pieces[id]
    if (piece) entries.push({ piece, text: adoptedText(data, piece), acts: isSplit(piece) ? actParts(data, piece) : null })
  }
  return statsOf(entries)
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

// ---------- 一覧の各行 ----------

/**
 * 一覧の1行（PieceRow）に渡す値。レコードと文字列・真偽値だけにしてあるので、
 * 行を React.memo で包むと、並べ替えや入力で変わった行だけが描き直される。
 */
export interface PieceRowData {
  piece: Piece
  /** 採用中の稿（なければ null。幕に分けた話では話自身の（分けた時の）採用稿） */
  version: Version | null
  /** 上位に反映される本文（幕に分けた話は各幕の採用稿をつないだもの。本文が変わらない限り同じオブジェクト） */
  text: { body: string } | null
  /** 幕に分けた話の幕の行（読む順）。分けていなければ null */
  acts: ActRowData[] | null
  /** セパレート（幕に分ける）できるか（採用原稿のある、分けていない第n話） */
  canSeparate: boolean
  versionCount: number
  /** 第n話・特殊ブロックの見出し */
  label: string
  /** 「第3話　旅立ち」のような表記 */
  fullLabel: string
  /** 編集モードで1つ上/下へ動かせるか */
  canUp: boolean
  canDown: boolean
  /** 編集モードで削除できるか（できない時の理由は deleteReason） */
  canDelete: boolean
  deleteReason?: string
  /**
   * 進捗: この話の終わりがタイトル全体（採用原稿）の何 % の位置か（0〜100 の整数。全体が0字なら null）。
   * 表示する値だけを持つので、ほかの話の文字数が少し変わっても表示が変わらない行は描き直さない
   */
  progress: number | null
}

/** 幕に分けた話の、幕の1行 */
export interface ActRowData {
  act: Piece
  /** 幕の採用稿（なければ null） */
  version: Version | null
  versionCount: number
  /** 「第2幕」 */
  label: string
  /** 「第3話　旅立ち　第2幕」 */
  fullLabel: string
  /** 幕の終わりがタイトル全体（採用原稿）の何 % の位置か */
  progress: number | null
  /** 最後の幕（次の幕とつなげない） */
  isLast: boolean
  /** 次の幕とつなげない理由（つなげれば null） */
  joinBlocked: string | null
}

/**
 * 各話を削除できるか（canDeletePiece と同じ結果）を、一覧の全行分まとめて求める。
 * 1行ずつ canDeletePiece を呼ぶと話数の2乗かかるので、採番スコープごとの最後の話を1回で求める。
 */
export function deletePermissions(data: AppData, titleId: ID): Record<ID, Permission> {
  const title = data.titles[titleId]
  const out: Record<ID, Permission> = {}
  if (!title) return out
  const flat = flatten(data, titleId)
  const last = new Map<string, ID>()
  for (const f of flat) {
    if (data.pieces[f.pieceId].kind === 'episode') last.set(scopeKey(title, f.chapterId), f.pieceId)
  }
  const ok: Permission = { ok: true }
  // 削除できない理由はスコープごとに同じ
  const denied = new Map<string, Permission>()
  for (const f of flat) {
    const id = f.pieceId
    const key = scopeKey(title, f.chapterId)
    if (data.pieces[id].kind === 'special' || last.get(key) === id) {
      out[id] = ok
      continue
    }
    let perm = denied.get(key)
    if (!perm) {
      perm = canDeletePiece(data, id)
      denied.set(key, perm)
    }
    out[id] = perm
  }
  return out
}

export interface PieceRowOptions {
  /** 編集モードの時だけ渡す（なければ動かせない扱い） */
  steps?: Record<ID, { up: boolean; down: boolean }> | null
  /** 編集モードの時だけ渡す（なければ削除できない扱い） */
  deletable?: Record<ID, Permission> | null
  /**
   * 各話の進捗（titleProgress）。編集モードの切り替えなどで数え直さないよう、呼ぶ側で覚えておいて渡す。
   * 省くとここで数える
   */
  progress?: Map<ID, PieceProgress> | null
}

/** 進捗の位置（0〜1）を一覧に出す % の整数にする（formatProgress と同じ丸め。全体が0字なら null） */
export function progressPercent(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined) return null
  return Math.round(ratio * 100)
}

/** 「34%」（全体が0字なら「—」）。formatProgress と同じ表記 */
export function progressLabel(percent: number | null): string {
  return formatProgress(percent === null ? null : percent / 100)
}

/** 進捗の説明（読み上げ・マウスを乗せた時の説明）。what は「この話」「この幕」 */
export function progressDescription(percent: number | null, hasActive: boolean, what = 'この話'): string {
  if (percent === null) return 'タイトル全体の採用原稿がまだ0字のため、位置は出せません'
  const base = `${what}の終わりは、タイトル全体（採用原稿）の ${percent}% の位置です`
  return hasActive ? base : `${base}（採用原稿がないので0字として数えています）`
}

/** 前回作った幕の行（幕が変わっていなければ同じ配列を渡し、行を描き直さない） */
const actRowsCache = new WeakMap<Piece, ActRowData[]>()

/** 幕に分けた話の幕の行（読む順） */
export function actRows(
  data: AppData,
  piece: Piece,
  episodeProgress: PieceProgress | undefined,
  numbers?: Record<ID, number>,
): ActRowData[] {
  const parts = actParts(data, piece)
  const progress = actProgress(data, piece, episodeProgress)
  const head = pieceFullLabel(data, piece, numbers)
  const rows = parts.map(
    (x, i): ActRowData => ({
      act: x.act,
      version: x.version,
      versionCount: versionCountOf(data, x.act),
      label: actLabel(x.number),
      fullLabel: `${head}　${actLabel(x.number)}`,
      progress: progressPercent(progress.get(x.act.id)?.end),
      isLast: i === parts.length - 1,
      joinBlocked: i === parts.length - 1 ? null : joinError(data, x.act.id),
    }),
  )
  const prev = actRowsCache.get(piece)
  if (prev && prev.length === rows.length && prev.every((r, i) => shallowEqual(r, rows[i]))) return prev
  actRowsCache.set(piece, rows)
  return rows
}

/** タイトルの全行（読む順の pieceId → 行の値） */
export function pieceRows(data: AppData, titleId: ID, opts: PieceRowOptions = {}): Record<ID, PieceRowData> {
  const numbers = episodeNumbers(data, titleId)
  const progress = opts.progress ?? titleProgress(data, titleId)
  const out: Record<ID, PieceRowData> = {}
  for (const f of flatten(data, titleId)) {
    const piece = data.pieces[f.pieceId]
    const step = opts.steps?.[piece.id]
    const del = opts.deletable?.[piece.id]
    const version = activeVersion(data, piece)
    const split = isSplit(piece)
    out[piece.id] = {
      piece,
      version,
      text: adoptedText(data, piece),
      acts: split ? actRows(data, piece, progress.get(piece.id), numbers) : null,
      canSeparate: piece.kind === 'episode' && !split && version !== null && version.pieceId === piece.id,
      versionCount: versionCountOf(data, piece),
      label: pieceLabel(data, piece, numbers),
      fullLabel: pieceFullLabel(data, piece, numbers),
      canUp: step?.up ?? false,
      canDown: step?.down ?? false,
      canDelete: del?.ok ?? false,
      deleteReason: del && !del.ok ? del.reason : undefined,
      progress: progressPercent(progress.get(piece.id)?.end),
    }
  }
  return out
}

/** ids の順に行を取り出す（見つからない話は飛ばす） */
export function rowsFor(rows: Record<ID, PieceRowData>, ids: readonly ID[]): PieceRowData[] {
  const out: PieceRowData[] = []
  for (const id of ids) if (rows[id]) out.push(rows[id])
  return out
}

/** 浅い比較（React.memo の比較用） */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as (keyof T)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]))
}

/** 行の並びが同じ内容か（要素ごとに浅く比較する） */
export function sameRows(a: readonly PieceRowData[], b: readonly PieceRowData[]): boolean {
  return a === b || (a.length === b.length && a.every((r, i) => shallowEqual(r, b[i])))
}

/** 設定項目ごとのエントリ数 */
export function entryCounts(data: AppData, categoryIds: ID[]): Record<ID, number> {
  const out: Record<ID, number> = {}
  for (const id of categoryIds) out[id] = entriesOf(data, id).length
  return out
}
