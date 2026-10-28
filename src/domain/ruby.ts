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

/** 記号とルビの読みを除いた本文（文字数を数える・検索する時に使う） */
export function stripRuby(text: string): string {
  if (!hasRubyMarkup(text)) return text
  let out = ''
  for (const s of parseRuby(text)) out += s.type === 'ruby' ? s.base : s.text
  return out
}
