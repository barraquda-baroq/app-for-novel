// 原稿画面の「段落」（段落の番号 ¶ へ移る）の、DOM を使わない部分。動きは useParagraphJump.ts、見た目は ParagraphJump.tsx。
// - 段落の数え方はコネクタと同じ（src/claude/anchor.ts の paragraphAt・paragraphSpans）。稿の本文ごとに1から、空行・空白だけの行は数えない
// - 一覧の行は「¶28　書き出しの20字ほど…」（ルビ・傍点は記法と読みを除いて親文字で、行の頭の字下げの空白は除く）
// - 番号の欄は「28」「¶28」「２８」（全角の数字も）を受け付ける
// - 差分の表示（削除された文字も含めてつないだ文字）では、稿の本文の位置を表示の位置に写して印を付ける
import { paragraphSpans, type ParagraphSpan } from '../../claude/anchor'
import type { DiffSegment } from '../../domain/diff'
import { stripRuby } from '../../domain/ruby'
import { formatCount } from '../../domain/text'

/** 一覧の行に出す書き出しの文字数 */
export const PARAGRAPH_LABEL_CHARS = 20

/** 一覧の1行 */
export interface ParagraphItem extends ParagraphSpan {
  /** 段落の番号（1から） */
  n: number
  /** 書き出し（記法を除いた20字ほど。長ければ「…」で終わる） */
  label: string
}

const LEADING_BLANK = /^[ 　\t]+/

/**
 * 段落の書き出し（ルビ・傍点の記法と読みを除き、行の頭の空白も除いた max 字。長ければ後ろに「…」）。
 * 字はコードポイントで数える（サロゲートペアの途中で切らない）
 */
export function paragraphLabel(body: string, span: ParagraphSpan, max = PARAGRAPH_LABEL_CHARS): string {
  const text = stripRuby(body.slice(span.start, span.end)).replace(LEADING_BLANK, '')
  // 長い段落でも、頭の max + 1 字だけを見る
  const chars: string[] = []
  for (const ch of text) {
    chars.push(ch)
    if (chars.length > max) break
  }
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/** 本文の段落の一覧（番号・範囲・書き出し）。一覧を開いている間だけ作る */
export function paragraphItems(body: string): ParagraphItem[] {
  return paragraphSpans(body).map((s, i) => ({ ...s, n: i + 1, label: paragraphLabel(body, s) }))
}

/**
 * 一覧で印を付ける段落（カーソルの位置の paragraphAt か、最後に移った段落の番号）を一覧の範囲に収める。
 * 空行の中のカーソルは次の段落（paragraphAt のまま）、最後の段落より後ろなら最後の段落。分からない・段落が1つも無ければ null
 */
export function clampParagraph(n: number | null, total: number): number | null {
  if (n === null || total <= 0) return null
  return Math.min(total, Math.max(1, n))
}

/**
 * 番号の欄の文字を番号にする（「28」「¶28」「２８」「¶ ２８」。前後の空白は無視）。数でなければ null。
 * 全角の数字は NFKC で半角にそろえる
 */
export function parseParagraphNumber(raw: string): number | null {
  const s = raw.normalize('NFKC').trim().replace(/^¶\s*/, '')
  if (!/^\d{1,7}$/.test(s)) return null
  return Number(s)
}

export type ParagraphTarget =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  /** 範囲の外（0・本文の段落の数より大きい） */
  | { kind: 'out'; n: number; total: number }
  | { kind: 'ok'; n: number }

/** 番号の欄の文字が、どの段落を指すか */
export function paragraphTarget(raw: string, total: number): ParagraphTarget {
  if (!raw.trim()) return { kind: 'empty' }
  const n = parseParagraphNumber(raw)
  if (n === null) return { kind: 'invalid' }
  if (n < 1 || n > total) return { kind: 'out', n, total }
  return { kind: 'ok', n }
}

/** 番号の欄の下に出す言葉（指せる番号・空の時は空） */
export function paragraphTargetMessage(t: ParagraphTarget): string {
  switch (t.kind) {
    case 'invalid':
      return '番号を数字で入れてください（例: 28）'
    case 'out':
      return t.total === 0
        ? 'この稿には段落がありません'
        : `¶${formatCount(t.n)} はありません（この稿は全${formatCount(t.total)}段落です）`
    default:
      return ''
  }
}

/**
 * 稿の本文の位置 off を、差分の表示（区切りの文字をつないだもの）の位置にする。削除された文字（del）は稿の本文に無い。
 * 削除された文字の前後どちらにも置ける時は、latest なら後ろ、そうでなければ前
 */
function toDisplay(segments: readonly DiffSegment[], off: number, latest: boolean): number {
  let b = 0
  let d = 0
  for (const s of segments) {
    const len = s.text.length
    if (!latest && b === off) return d
    if (s.kind !== 'del') {
      if (off < b + len) return d + (off - b)
      b += len
    }
    d += len
  }
  return d
}

/**
 * 稿の本文の段落 [start, end) を、差分の表示の範囲にする。段落の頭・終わりにくっついた削除された文字
 * （同じ行の中のもの。改行の手前まで）も段落に含める
 */
export function displayRangeOf(segments: readonly DiffSegment[], start: number, end: number): { start: number; end: number } {
  const text = segments.map((s) => s.text).join('')
  const del = new Uint8Array(text.length)
  let d = 0
  for (const s of segments) {
    if (s.kind === 'del') del.fill(1, d, d + s.text.length)
    d += s.text.length
  }
  const isBreak = (i: number) => text.charCodeAt(i) === 0x0a || text.charCodeAt(i) === 0x0d
  let s = toDisplay(segments, start, true)
  let e = Math.max(s, toDisplay(segments, end, false))
  while (s > 0 && del[s - 1] && !isBreak(s - 1)) s--
  while (e < text.length && del[e] && !isBreak(e)) e++
  return { start: s, end: e }
}

/** 差分の表示の位置 pos の前にある、稿の本文の文字の数（表示の位置 → 稿の本文の位置） */
export function bodyOffsetOfDisplay(segments: readonly DiffSegment[], pos: number): number {
  let b = 0
  let d = 0
  for (const s of segments) {
    const len = s.text.length
    if (pos <= d + len) return s.kind === 'del' ? b : b + (pos - d)
    if (s.kind !== 'del') b += len
    d += len
  }
  return b
}
