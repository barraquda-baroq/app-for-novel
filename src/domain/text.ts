// 文字数カウント。コンテストの規定に合わせやすいよう、空白・改行を除いた文字数を基本にする。
// ルビ・傍点の記法（｜漢字《かんじ》・《《強調》》）は、記号とルビの読みを除いて数える。
// 長編（数百万字）でも重くならないよう、文字コードを1回なめるだけで数える。
import { strippedBody, stripRuby } from './ruby'

export interface TextStats {
  /** 空白・改行を除いた文字数 */
  chars: number
  /** 改行のみ除いた文字数（空白を含む） */
  charsWithSpaces: number
  /** 行数（改行区切り） */
  lines: number
  /** 400字詰め原稿用紙換算の枚数（1行20字・20行、段落ごとに改行して数える簡易計算） */
  manuscriptPages: number
}

/** 正規表現の \s と同じ空白文字（改行を含む） */
function isSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  )
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

export function countChars(source: string): number {
  const text = stripRuby(source)
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // サロゲートペア（𠮷 など）は1文字として数える
    if (isLowSurrogate(c) && i > 0 && isHighSurrogate(text.charCodeAt(i - 1))) continue
    if (!isSpace(c)) n += 1
  }
  return n
}

export function textStats(source: string): TextStats {
  return plainTextStats(stripRuby(source))
}

/** 記号とルビの読みを除いた後の本文（stripRuby の結果）を数える */
function plainTextStats(text: string): TextStats {
  let chars = 0
  let withSpaces = 0
  let lines = text.length === 0 ? 0 : 1
  let rows = 0
  /** 今の段落のコードポイント数 */
  let lineLen = 0
  const endLine = () => {
    rows += Math.max(1, Math.ceil(lineLen / 20))
    lineLen = 0
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0d) {
      // \r\n と単独の \r は改行1つ
      if (text.charCodeAt(i + 1) === 0x0a) continue
      lines += 1
      endLine()
      continue
    }
    if (c === 0x0a) {
      lines += 1
      endLine()
      continue
    }
    if (isLowSurrogate(c) && i > 0 && isHighSurrogate(text.charCodeAt(i - 1))) continue
    lineLen += 1
    withSpaces += 1
    if (!isSpace(c)) chars += 1
  }
  if (text.length > 0) endLine()
  return {
    chars,
    charsWithSpaces: withSpaces,
    lines,
    manuscriptPages: rows === 0 ? 0 : Math.ceil(rows / 20),
  }
}

const countFormat = new Intl.NumberFormat('ja-JP')

export function formatCount(n: number): string {
  return countFormat.format(n)
}

/** 本文の指紋（FNV-1a 32bit）。記録後に本文が変わったかの判定や、同じ本文の重複保存を避けるのに使う */
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export interface BodyMetrics extends TextStats {
  hash: string
}

const metricsCache = new WeakMap<object, BodyMetrics>()

/**
 * 推敲バージョンなど「本文を持つ不変のレコード」の文字数・枚数・指紋。
 * レコードは編集のたびに新しいオブジェクトに置き換わるので、オブジェクト単位でキャッシュできる
 * （長編で一覧や集計を描き直すたびに全文を数え直さないため）。
 */
export function bodyMetrics(record: { body: string }): BodyMetrics {
  let m = metricsCache.get(record)
  if (!m) {
    // 記号と読みを除いた本文はレコードごとに覚えておき、通し読みの見積もり・表示と分け合う（strippedBody）
    m = { ...plainTextStats(strippedBody(record)), hash: textHash(record.body) }
    metricsCache.set(record, m)
  }
  return m
}
