// 推敲案の場所（抜き出した箇所 excerpt が、話の採用原稿のどこにあるか）。コネクタの追加と手動連携の貼り付けで同じものを使う。
// - 話の採用原稿（幕に分けた話は各幕の採用稿を読む順に）の中を、まず記法込みの本文のまま、無ければルビ・傍点の記法と
//   ルビの読みを除いた本文で探し、見つけた位置を元の本文に戻す（記法の途中では切らない）
// - 同じ箇所が何か所もあって context_before（直前の文字）で絞れなければ ambiguous
// - 本文が後で変わったら、控えた前後の文字を手がかりに探し直す（reanchor。話が幕に分けられた・幕がつながれた後も探す）
// 位置はすべて UTF-16 の位置。前後の文字はサロゲートペアの途中で切らない。
import { hashJson } from '../domain/hash'
import { hasRubyMarkup, stripRuby, stripRubyMap, type StrippedMap } from '../domain/ruby'
import { activeVersion, actsOf, isSplit } from '../domain/structure'
import type { AppData, ID, Piece, ProofAnchor, ProofSuggestion, Version } from '../domain/types'
import { nfc } from './derivedId'

/** 前後に控える文字数 */
export const ANCHOR_CONTEXT = 20

/** 探す本文の1区切り（話・特殊ブロック・幕の採用稿） */
export interface TextSegment {
  /** 話・特殊ブロック・幕 */
  piece: Piece
  /** 幕の時、幕の属する話 */
  parentId: ID | null
  version: Version
}

/**
 * 話の採用原稿の区切り。幕に分けた話は各幕の採用稿（読む順。採用稿の無い幕は飛ばす）、幕・分けていない話はその採用稿。
 * 採用稿が無ければ空
 */
export function adoptedSegments(data: AppData, piece: Piece): TextSegment[] {
  if (isSplit(piece)) {
    const out: TextSegment[] = []
    for (const act of actsOf(data, piece)) {
      const v = activeVersion(data, act)
      if (v) out.push({ piece: act, parentId: piece.id, version: v })
    }
    return out
  }
  const v = activeVersion(data, piece)
  if (!v) return []
  return [{ piece, parentId: piece.kind === 'act' ? (piece.parentId ?? null) : null, version: v }]
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** サロゲートペアの途中で切らないように [start, end) を内側へ寄せて切り出す */
export function safeSlice(text: string, start: number, end: number): string {
  let s = Math.max(0, Math.min(start, text.length))
  let e = Math.max(s, Math.min(end, text.length))
  if (s > 0 && s < text.length && isLow(text.charCodeAt(s)) && isHigh(text.charCodeAt(s - 1))) s += 1
  if (e > s && e < text.length && isLow(text.charCodeAt(e)) && isHigh(text.charCodeAt(e - 1))) e -= 1
  return text.slice(s, Math.max(s, e))
}

/** offset が何段落目か（1から。空白だけの行は数えない） */
export function paragraphAt(body: string, offset: number): number {
  let n = 0
  let lineHasText = false
  const end = Math.min(offset, body.length)
  for (let i = 0; i < end; i++) {
    const c = body.charCodeAt(i)
    if (c === 0x0a || c === 0x0d) {
      if (c === 0x0d && body.charCodeAt(i + 1) === 0x0a) continue
      if (lineHasText) n += 1
      lineHasText = false
    } else if (c !== 0x20 && c !== 0x3000 && c !== 0x09) lineHasText = true
  }
  return n + 1
}

const strippedMaps = new WeakMap<{ body: string }, StrippedMap>()
/** 稿の本文の、記法を除いた本文と元の位置の対応（稿ごとに1回だけ作る。検索でも使う） */
export function strippedMapOf(v: { body: string }): StrippedMap {
  let m = strippedMaps.get(v)
  if (!m) {
    m = stripRubyMap(v.body)
    strippedMaps.set(v, m)
  }
  return m
}

const bodyHashes = new WeakMap<object, string>()
/** 本文の指紋（hashJson。稿・つないだ本文のオブジェクトごとに1回だけ数える） */
export function bodyHashOf(record: { body: string }): string {
  let h = bodyHashes.get(record)
  if (h === undefined) {
    h = hashJson(record.body)
    bodyHashes.set(record, h)
  }
  return h
}

/** 一致した範囲を、ルビ・傍点の記法の途中で切らないように広げる（記法を含む本文の上の範囲） */
function widenToMarkup(v: Version, start: number, end: number): [number, number] {
  if (!hasRubyMarkup(v.body)) return [start, end]
  const m = strippedMapOf(v)
  let s = start
  let e = end
  // 記法の文字は、その記法全体を指す。範囲にかかる記法を探して広げる（start・end は前から順に並んでいる）
  let lo = 0
  let hi = m.end.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (m.end[mid] <= start) lo = mid + 1
    else hi = mid
  }
  for (let k = lo; k < m.start.length && m.start[k] < end; k++) {
    if (m.start[k] < s) s = m.start[k]
    if (m.end[k] > e) e = m.end[k]
  }
  return [s, e]
}

/** text の p の直前が ctx か */
const precededBy = (text: string, p: number, ctx: string) => p >= ctx.length && text.startsWith(ctx, p - ctx.length)

/** 見つかった1か所 */
interface Hit {
  segment: number
  /** 元の本文の上の範囲 */
  start: number
  end: number
}

/** needle が text の中に現れる位置（重なりも数える） */
function positions(text: string, needle: string, limit = 1000): number[] {
  const out: number[] = []
  if (!needle) return out
  let i = text.indexOf(needle)
  while (i >= 0 && out.length < limit) {
    // サロゲートペアの後ろ半分から始まる一致は使わない
    if (!(i > 0 && isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1)))) out.push(i)
    i = text.indexOf(needle, i + 1)
  }
  return out
}

/** 区切りの中で excerpt を探す（mode: raw = 記法込みのまま、strip = 記法を除いて） */
function findAll(segments: readonly TextSegment[], excerpt: string, mode: 'raw' | 'strip', before?: string): Hit[] {
  const hits: Hit[] = []
  const needle = mode === 'raw' ? excerpt : stripRuby(excerpt)
  const ctx = before ? (mode === 'raw' ? before : stripRuby(before)) : ''
  if (!needle) return hits
  segments.forEach((seg, si) => {
    const v = seg.version
    if (mode === 'raw') {
      for (const p of positions(v.body, needle)) {
        if (ctx && !precededBy(v.body, p, ctx)) continue
        const [s, e] = widenToMarkup(v, p, p + needle.length)
        hits.push({ segment: si, start: s, end: e })
      }
      return
    }
    if (!hasRubyMarkup(v.body) && !hasRubyMarkup(excerpt)) return
    const m = strippedMapOf(v)
    for (const p of positions(m.text, needle)) {
      if (ctx && !precededBy(m.text, p, ctx)) continue
      const last = p + needle.length - 1
      hits.push({ segment: si, start: m.start[p], end: m.end[last] })
    }
  })
  return hits
}

export type LocateResult =
  | {
      status: 'found'
      segment: TextSegment
      anchor: ProofAnchor
      /** 同じ抜き出しが本文に何度もある時の何番目か（0から。id の材料） */
      occurrence: number
      /** raw = 記法込みのまま見つかった、strip = 記法を除いて見つかった */
      matchedBy: 'raw' | 'strip'
    }
  | { status: 'not_found' }
  | {
      status: 'ambiguous'
      /** 見つかった数 */
      count: number
      /** 見つかった所（最大5つ。前後の文字で区別できるように） */
      candidates: { pieceId: ID; paragraph: number; before: string; after: string }[]
    }

function anchorOf(seg: TextSegment, start: number, end: number): ProofAnchor {
  const body = seg.version.body
  return {
    offset: start,
    length: end - start,
    paragraph: paragraphAt(body, start),
    before: safeSlice(body, start - ANCHOR_CONTEXT, start),
    after: safeSlice(body, end, end + ANCHOR_CONTEXT),
    bodyHash: bodyHashOf(seg.version),
  }
}

/**
 * 話（幕に分けた話なら各幕）の採用原稿の中で excerpt を探す。contextBefore（直前の文字）があれば、それに続く所だけにする
 * （それで1つも無ければ、直前の文字を使わずに探す）。
 * 見つかった所が1つなら found（幕に分けた話なら、その幕）、複数なら ambiguous、無ければ not_found
 */
export function locateExcerpt(data: AppData, piece: Piece, excerpt: string, contextBefore?: string): LocateResult {
  return locateIn(adoptedSegments(data, piece), excerpt, contextBefore)
}

/** locateExcerpt の区切りを渡す形（コネクタが手元の写しで使う） */
export function locateIn(segments: readonly TextSegment[], excerpt: string, contextBefore?: string): LocateResult {
  const tries = [excerpt]
  if (nfc(excerpt) !== excerpt) tries.push(nfc(excerpt))
  const ctx = contextBefore ? [contextBefore, nfc(contextBefore)] : []
  for (const mode of ['raw', 'strip'] as const) {
    for (const ex of tries) {
      const all = findAll(segments, ex, mode)
      if (!all.length) continue
      let hits = all
      if (ctx.length) {
        const narrowed = findAll(segments, ex, mode, ex === excerpt ? ctx[0] : ctx[1])
        if (narrowed.length) hits = narrowed
      }
      if (hits.length > 1) {
        return {
          status: 'ambiguous',
          count: hits.length,
          candidates: hits.slice(0, 5).map((h) => {
            const seg = segments[h.segment]
            const a = anchorOf(seg, h.start, h.end)
            return { pieceId: seg.piece.id, paragraph: a.paragraph, before: a.before, after: a.after }
          }),
        }
      }
      const hit = hits[0]
      const occurrence = all.findIndex((h) => h.segment === hit.segment && h.start === hit.start)
      const segment = segments[hit.segment]
      return { status: 'found', segment, anchor: anchorOf(segment, hit.start, hit.end), occurrence, matchedBy: mode }
    }
  }
  return { status: 'not_found' }
}

export type ReanchorResult =
  | {
      /** exact = 控えた時のままの本文、moved = 本文が変わったが探し直して見つかった */
      status: 'exact' | 'moved'
      /** 見つかった話・特殊ブロック・幕と、その採用稿 */
      pieceId: ID
      versionId: ID
      offset: number
      length: number
      paragraph: number
    }
  | {
      /** 本文が変わって見つからない（「本文が変わりました（直した可能性）」） */
      status: 'lost'
    }

/** 前後の文字がどれだけ控えと合うか（多いほど同じ所） */
function contextScore(body: string, start: number, end: number, before: string, after: string): number {
  let score = 0
  for (let k = 1; k <= before.length && start - k >= 0; k++) {
    if (body.charCodeAt(start - k) !== before.charCodeAt(before.length - k)) break
    score += 1
  }
  for (let k = 0; k < after.length && end + k < body.length; k++) {
    if (body.charCodeAt(end + k) !== after.charCodeAt(k)) break
    score += 1
  }
  return score
}

/**
 * 推敲案の場所を、いまの本文で探し直す。控えた稿がまだ採用されていて本文の指紋も同じなら exact。
 * 変わっていれば、推敲案の話（幕に分けられていれば各幕）、話が無くなっていれば属していた話（幕をつないだ・解除した後）の
 * 採用原稿で excerpt を探し、控えた前後の文字が最も合う所（同じなら控えた位置に近い所）を moved で返す。無ければ lost
 */
export function reanchor(data: AppData, s: Pick<ProofSuggestion, 'pieceId' | 'parentId' | 'versionId' | 'anchor' | 'excerpt'>): ReanchorResult {
  const piece = data.pieces[s.pieceId]
  const parent = s.parentId ? data.pieces[s.parentId] : undefined
  const host = piece ?? parent
  if (!host) return { status: 'lost' }
  const segments = adoptedSegments(data, host)
  const a = s.anchor
  if (a && s.versionId) {
    const same = segments.find((g) => g.version.id === s.versionId)
    if (same && bodyHashOf(same.version) === a.bodyHash && a.offset + a.length <= same.version.body.length) {
      return {
        status: 'exact',
        pieceId: same.piece.id,
        versionId: same.version.id,
        offset: a.offset,
        length: a.length,
        paragraph: a.paragraph,
      }
    }
  }
  let hits: Hit[] = []
  for (const mode of ['raw', 'strip'] as const) {
    hits = findAll(segments, s.excerpt, mode)
    if (hits.length) break
  }
  if (!hits.length) return { status: 'lost' }
  let best = hits[0]
  let bestScore = -1
  let bestDist = Number.POSITIVE_INFINITY
  for (const h of hits) {
    const seg = segments[h.segment]
    const score = a ? contextScore(seg.version.body, h.start, h.end, a.before, a.after) : 0
    const dist = a && seg.version.id === s.versionId ? Math.abs(h.start - a.offset) : Number.MAX_SAFE_INTEGER
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = h
      bestScore = score
      bestDist = dist
    }
  }
  const seg = segments[best.segment]
  return {
    status: 'moved',
    pieceId: seg.piece.id,
    versionId: seg.version.id,
    offset: best.start,
    length: best.end - best.start,
    paragraph: paragraphAt(seg.version.body, best.start),
  }
}
