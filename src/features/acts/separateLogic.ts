// セパレート画面（分割点を置く画面）の純粋な計算。
// 本文は区切りごとに読み取り専用の入力欄に並べ、カーソルを置いて Enter か「ここで区切る」で分割点を足す。
// 入力欄の値（value）は改行が LF にそろうので（CRLF・CR は LF 1字になる）、カーソルの位置は元の本文の位置に直して使う。
import { splitPointError } from '../../domain/acts'
import { countChars } from '../../domain/text'
import { firstLine } from '../piece/logic'

/**
 * 原稿画面からセパレート画面を開いた履歴の印（history.state に入れる）。この印があれば、分けた後は履歴を1つ戻る
 * （同じ原稿画面の URL を二重に積まない。Android の「戻る」1回で、原稿画面を開く前の画面へ戻れるように）
 */
export const SEPARATE_FROM_PIECE = 'pwSeparateFromPiece'

/** 入力欄の値（改行は LF）の位置 normalized を、元の本文 raw（CRLF のことがある）の位置にする */
export function rawOffset(raw: string, normalized: number): number {
  let i = 0
  let j = 0
  while (i < raw.length && j < normalized) {
    i += raw.charCodeAt(i) === 0x0d && raw.charCodeAt(i + 1) === 0x0a ? 2 : 1
    j += 1
  }
  return i
}

/** 元の本文 raw の位置を、入力欄の値（改行は LF）の位置にする */
export function normalizedOffset(raw: string, offset: number): number {
  let i = 0
  let j = 0
  while (i < raw.length && i < offset) {
    i += raw.charCodeAt(i) === 0x0d && raw.charCodeAt(i + 1) === 0x0a ? 2 : 1
    j += 1
  }
  return j
}

/** 入力欄に出す値（改行を LF にそろえる。入力欄に入れると同じようにそろう） */
export function displayValue(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
}

/** 区切り（分割点は小さい順。区切れる位置であること） */
export interface Segment {
  /** 元の本文の中の始まりと終わり */
  start: number
  end: number
  text: string
}

export function segmentsOf(body: string, points: readonly number[]): Segment[] {
  const out: Segment[] = []
  let start = 0
  for (const p of points) {
    out.push({ start, end: p, text: body.slice(start, p) })
    start = p
  }
  out.push({ start, end: body.length, text: body.slice(start) })
  return out
}

export interface ActPreview {
  /** 第x幕の x */
  number: number
  /** 最初の空でない行（長ければ切る） */
  firstLine: string
  chars: number
}

/** 分けた後の幕の一覧（firstNumber は最初の区切りの幕の番号。さらに分ける時はその幕の番号） */
export function previewActs(segments: readonly Segment[], firstNumber = 1, maxLine = 40): ActPreview[] {
  return segments.map((s, i) => {
    const line = firstLine(s.text)
    const chars = Array.from(line)
    return {
      number: firstNumber + i,
      firstLine: chars.length > maxLine ? `${chars.slice(0, maxLine).join('')}…` : line,
      chars: countChars(s.text),
    }
  })
}

export type AddPointResult = { ok: true; points: number[] } | { ok: false; message: string }

/**
 * 区切り segmentIndex の入力欄のカーソル位置（入力欄の値での位置）に分割点を足す。
 * 先頭・末尾・既に区切った位置・文字や改行の途中は足さずに理由を返す。
 */
export function addPointAt(body: string, points: readonly number[], segmentIndex: number, caret: number): AddPointResult {
  const segments = segmentsOf(body, points)
  const seg = segments[segmentIndex]
  if (!seg) return { ok: false, message: '区切りたい所にカーソルを置いてください' }
  const offset = seg.start + rawOffset(seg.text, caret)
  const err = splitPointError(body, offset, points)
  if (err) return { ok: false, message: err }
  return { ok: true, points: [...points, offset].sort((a, b) => a - b) }
}
