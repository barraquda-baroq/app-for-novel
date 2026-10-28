// ルビ・傍点の記法（カクヨム式）。
// - ルビ: ｜漢字《かんじ》（半角の | も可）。直前が漢字だけなら ｜ を省ける: 漢字《かんじ》
// - 傍点: 《《強調》》
// - 《 をそのまま書きたい時は ｜《
// 文字数は記号とルビの読みを除いて数える（stripRuby）。

export type RubySegment =
  | { type: 'text'; text: string }
  | { type: 'ruby'; base: string; reading: string }
  | { type: 'bouten'; text: string }

/** ルビを振れる「漢字」（々〆〻ヵヶ と CJK 統合漢字・拡張・互換漢字） */
function isKanji(code: number): boolean {
  return (
    code === 0x3005 ||
    code === 0x3006 ||
    code === 0x303b ||
    code === 0x30f5 ||
    code === 0x30f6 ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x3ffff)
  )
}

/** ルビの親文字・読みの長さの上限（これより長いものは記法として扱わない） */
const MAX_BASE = 50
const MAX_READING = 100

/** start から end までに改行があるか */
function hasNewline(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0a || c === 0x0d) return true
  }
  return false
}

/** buf の末尾に続く漢字の長さ（UTF-16 の長さ） */
function trailingKanji(buf: string): number {
  let i = buf.length
  while (i > 0) {
    let cp = buf.charCodeAt(i - 1)
    let width = 1
    if (cp >= 0xdc00 && cp <= 0xdfff && i > 1) {
      const hi = buf.charCodeAt(i - 2)
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cp = (hi - 0xd800) * 0x400 + (cp - 0xdc00) + 0x10000
        width = 2
      }
    }
    if (!isKanji(cp)) break
    i -= width
  }
  return buf.length - i
}

export function hasRubyMarkup(text: string): boolean {
  return text.indexOf('《') >= 0
}

/** 本文をルビ・傍点と地の文に分ける */
export function parseRuby(text: string): RubySegment[] {
  const out: RubySegment[] = []
  if (!hasRubyMarkup(text)) return text ? [{ type: 'text', text }] : []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf })
    buf = ''
  }
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === '《' && text[i + 1] === '《') {
      const close = text.indexOf('》》', i + 2)
      if (close > i + 2 && !hasNewline(text, i, close)) {
        flush()
        out.push({ type: 'bouten', text: text.slice(i + 2, close) })
        i = close + 2
        continue
      }
    }
    if (ch === '｜' || ch === '|') {
      if (text[i + 1] === '《') {
        // ｜《 は《そのもの
        buf += '《'
        i += 2
        continue
      }
      const open = text.indexOf('《', i + 1)
      const close = open < 0 ? -1 : text.indexOf('》', open + 1)
      if (
        open > i + 1 &&
        close > open + 1 &&
        open - i - 1 <= MAX_BASE &&
        close - open - 1 <= MAX_READING &&
        text[open + 1] !== '《' &&
        !hasNewline(text, i, close)
      ) {
        flush()
        out.push({ type: 'ruby', base: text.slice(i + 1, open), reading: text.slice(open + 1, close) })
        i = close + 1
        continue
      }
    }
    if (ch === '《') {
      const close = text.indexOf('》', i + 1)
      const run = trailingKanji(buf)
      if (run > 0 && close > i + 1 && close - i - 1 <= MAX_READING && !hasNewline(text, i, close)) {
        const base = buf.slice(buf.length - run)
        buf = buf.slice(0, buf.length - run)
        flush()
        out.push({ type: 'ruby', base, reading: text.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}

/**
 * 記号とルビの読みを除いた本文（文字数を数える・検索する時に使う）。
 * 1回だけ当てること（｜《 は《になるので、2回当てると結果が変わることがある）。
 */
export function stripRuby(text: string): string {
  if (!hasRubyMarkup(text)) return text
  let out = ''
  for (const s of parseRuby(text)) out += s.type === 'ruby' ? s.base : s.text
  return out
}

const strippedCache = new WeakMap<object, string>()

/**
 * 本文を持つ不変のレコード（推敲バージョン・本文の控え）の、記号とルビの読みを除いた本文。レコードごとに1回だけ作る
 * （文字数・段落の形の見積もり・通し読みの遠くの話の表示で、同じ本文を何度も分け直さないため）。
 */
export function strippedBody(record: { body: string }): string {
  let s = strippedCache.get(record)
  if (s === undefined) {
    s = stripRuby(record.body)
    strippedCache.set(record, s)
  }
  return s
}

/** 記号とルビの読みを除いた本文と、その各文字が元の本文のどこから来たか（stripRubyMap） */
export interface StrippedMap {
  /** stripRuby(text) と同じ文字列 */
  text: string
  /**
   * text の i 文字目（UTF-16）が元の本文で占める範囲 [start[i], end[i])。ルビの親文字・傍点の文字は、その記法全体
   * （｜漢字《かんじ》・《《強調》》）を指す（一致した範囲を元の本文に戻した時に、記法の途中で切らないように）
   */
  start: Int32Array
  end: Int32Array
}

/**
 * stripRuby と同じ規則で記号とルビの読みを除き、元の本文の位置との対応を返す（推敲案の場所を探す・検索で使う）。
 * parseRuby と同じ規則で読む（parseRuby を変えたら、ここも同じに変える。src/claude/anchor.test.ts で同じ結果になるかを確かめている）
 */
export function stripRubyMap(text: string): StrippedMap {
  const n = text.length
  if (!hasRubyMarkup(text)) {
    const start = new Int32Array(n)
    const end = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      start[i] = i
      end[i] = i + 1
    }
    return { text, start, end }
  }
  let out = ''
  const starts: number[] = []
  const ends: number[] = []
  // まだ確定していない地の文（ルビの親文字として後ろの漢字を取られることがある）と、その元の位置
  let buf = ''
  let bufStart: number[] = []
  let bufEnd: number[] = []
  const flush = () => {
    out += buf
    for (let k = 0; k < bufStart.length; k++) {
      starts.push(bufStart[k])
      ends.push(bufEnd[k])
    }
    buf = ''
    bufStart = []
    bufEnd = []
  }
  /** 記法 [s, e) の中の文字 chars を、記法全体を指す文字として足す */
  const pushUnit = (chars: string, s: number, e: number) => {
    out += chars
    for (let k = 0; k < chars.length; k++) {
      starts.push(s)
      ends.push(e)
    }
  }
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === '《' && text[i + 1] === '《') {
      const close = text.indexOf('》》', i + 2)
      if (close > i + 2 && !hasNewline(text, i, close)) {
        flush()
        pushUnit(text.slice(i + 2, close), i, close + 2)
        i = close + 2
        continue
      }
    }
    if (ch === '｜' || ch === '|') {
      if (text[i + 1] === '《') {
        buf += '《'
        bufStart.push(i)
        bufEnd.push(i + 2)
        i += 2
        continue
      }
      const open = text.indexOf('《', i + 1)
      const close = open < 0 ? -1 : text.indexOf('》', open + 1)
      if (
        open > i + 1 &&
        close > open + 1 &&
        open - i - 1 <= MAX_BASE &&
        close - open - 1 <= MAX_READING &&
        text[open + 1] !== '《' &&
        !hasNewline(text, i, close)
      ) {
        flush()
        pushUnit(text.slice(i + 1, open), i, close + 1)
        i = close + 1
        continue
      }
    }
    if (ch === '《') {
      const close = text.indexOf('》', i + 1)
      const run = trailingKanji(buf)
      if (run > 0 && close > i + 1 && close - i - 1 <= MAX_READING && !hasNewline(text, i, close)) {
        const base = buf.slice(buf.length - run)
        const baseStart = bufStart[bufStart.length - run]
        buf = buf.slice(0, buf.length - run)
        bufStart = bufStart.slice(0, bufStart.length - run)
        bufEnd = bufEnd.slice(0, bufEnd.length - run)
        flush()
        pushUnit(base, baseStart, close + 1)
        i = close + 1
        continue
      }
    }
    buf += ch
    bufStart.push(i)
    bufEnd.push(i + 1)
    i += 1
  }
  flush()
  return { text: out, start: Int32Array.from(starts), end: Int32Array.from(ends) }
}
