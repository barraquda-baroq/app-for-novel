// 原稿画面の欄ごとの検索（採用原稿・推敲バージョン）の、DOM を使わない部分。
// - ルビ・傍点の記号（｜漢字《かんじ》・《《強調》》）は飛ばして親文字で探し、読みは探さない（src/domain/ruby.ts の stripRubyPositions）
// - 全角と半角だけが違う文字（Ａと A、１と 1、全角空白と半角空白、半角カナ）と、英字の大文字・小文字は同じとみなす。
//   ひらがなとカタカナは区別し、…と ...、①と 1 のような文字は別の文字のまま（NFKC を本文全体にはかけない）
// - 見つけた所は、元の本文（記法込み）の位置 [start, end) で返す
import { stripRuby, stripRubyPositions } from '../../domain/ruby'
import { formatCount } from '../../domain/text'
import { IS_MAC } from '../../ui/keys'

/** 全角と半角をそろえる表（1文字 → 1文字）。起動の時に1回だけ作る */
const WIDTH_FOLD: Map<number, string> = (() => {
  const m = new Map<number, string>()
  const ranges: [number, number][] = [
    [0xff01, 0xff5e], // 全角の英数字・記号
    [0xff61, 0xff9f], // 半角の句読点・カナ・濁点・半濁点
    [0xffe0, 0xffe6], // ￠￡￢￣￤￥￦
    [0xffe8, 0xffee], // ￨￩￪￫￬￭￮
    [0x3000, 0x3000], // 全角空白
  ]
  for (const [a, b] of ranges) {
    for (let c = a; c <= b; c++) {
      const to = String.fromCharCode(c).normalize('NFKC')
      // 2文字以上になるもの（￣ など）は変えない
      if (to.length === 1 && to.charCodeAt(0) !== c) m.set(c, to)
    }
  }
  return m
})()

const DAKUTEN = 0x3099
const HANDAKUTEN = 0x309a

/** 全角と半角・大文字と小文字をそろえた文字列と、その各文字が元の文字列のどこから来たか [from[k], to[k]) */
export interface Folded {
  text: string
  from: Int32Array
  to: Int32Array
}

/**
 * 全角と半角だけが違う文字と、英字の大文字・小文字をそろえる。
 * 濁点・半濁点（半角の ﾞﾟ をそろえた結果と、分解した形の か+゛）は、前の文字と合わせて1文字になる時だけ合わせる（ｶﾞ → ガ）
 */
export function foldText(s: string): Folded {
  const n = s.length
  let out = ''
  const from = new Int32Array(n)
  const to = new Int32Array(n)
  let k = 0
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    let ch = WIDTH_FOLD.get(c) ?? s[i]
    const cc = ch.charCodeAt(0)
    if ((cc === DAKUTEN || cc === HANDAKUTEN) && k > 0) {
      const composed = (out[out.length - 1] + ch).normalize('NFC')
      if (composed.length === 1) {
        out = out.slice(0, -1) + composed
        to[k - 1] = i + 1
        continue
      }
    }
    if (cc >= 0x41 && cc <= 0x5a) ch = String.fromCharCode(cc + 0x20)
    out += ch
    from[k] = i
    to[k] = i + 1
    k++
  }
  return { text: out, from: from.slice(0, k), to: to.slice(0, k) }
}

/** 検索の語をそろえる（語に記法を書いても親文字で探す） */
export function foldQuery(q: string): string {
  return foldText(stripRuby(q)).text
}

/** 本文1つ分の検索の対応表。folded の k 文字目は元の本文の [rawStart[k], rawEnd[k]) */
export interface SearchIndex {
  folded: string
  rawStart: Int32Array
  rawEnd: Int32Array
}

/** 記法を除いてから全角と半角をそろえ、元の本文の位置との対応を作る */
export function buildSearchIndex(raw: string): SearchIndex {
  const p = stripRubyPositions(raw)
  const f = foldText(p.text)
  const len = f.text.length
  const rawStart = new Int32Array(len)
  const rawEnd = new Int32Array(len)
  for (let k = 0; k < len; k++) {
    rawStart[k] = p.at[f.from[k]]
    rawEnd[k] = p.at[f.to[k] - 1] + 1
  }
  return { folded: f.text, rawStart, rawEnd }
}

/** 見つけた所（元の本文の位置） */
export interface Hit {
  start: number
  end: number
}

/** 数える一致の上限（これより多い時は「9999+件」） */
export const MAX_HITS = 9999

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * needle（foldQuery でそろえた語）を前から重ねずに探す（「あああ」の中の「ああ」は1件）。
 * サロゲートペアの途中から始まる一致は数えない。limit を超える時は capped
 */
export function findHits(index: SearchIndex, needle: string, limit = MAX_HITS): { hits: Hit[]; capped: boolean } {
  const hits: Hit[] = []
  if (!needle) return { hits, capped: false }
  const { folded, rawStart, rawEnd } = index
  const L = needle.length
  let i = 0
  while (i <= folded.length - L) {
    const p = folded.indexOf(needle, i)
    if (p < 0) break
    if (isLowSurrogate(folded.charCodeAt(p))) {
      i = p + 1
      continue
    }
    if (hits.length >= limit) return { hits, capped: true }
    hits.push({ start: rawStart[p], end: rawEnd[p + L - 1] })
    i = p + L
  }
  return { hits, capped: false }
}

/** start が offset 以降の最初の一致の番号（無ければ先頭に戻って 0。一致が無ければ null） */
export function firstFrom(hits: readonly Hit[], offset: number): number | null {
  if (hits.length === 0) return null
  let lo = 0
  let hi = hits.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (hits[mid].start < offset) lo = mid + 1
    else hi = mid
  }
  return lo < hits.length ? lo : 0
}

/** start が offset より前の最後の一致の番号（無ければ末尾に戻る。一致が無ければ null） */
export function lastBefore(hits: readonly Hit[], offset: number): number | null {
  if (hits.length === 0) return null
  const first = firstFrom(hits, offset)!
  // offset 以降の最初の一致の1つ前（先頭なら末尾へ）。offset より前に一致が無く、先頭に戻った時も末尾
  if (first === 0) return hits.length - 1
  return first - 1
}

/** 検索窓の件数の欄（「3／12」「12件」「見つかりません」） */
export function hitStatus(s: {
  query: string
  total: number
  current: number | null
  capped: boolean
  pending: boolean
}): string {
  if (!s.query) return ''
  if (s.pending) return '差分を計算中…'
  if (s.total === 0) return '見つかりません'
  const total = `${formatCount(s.total)}${s.capped ? '+' : ''}`
  return s.current === null ? `${total}件` : `${formatCount(s.current + 1)}／${total}`
}

/** 検索の語にする選んだ文字の長さの上限 */
const MAX_SELECTION_QUERY = 100

/** 欄で選んだ文字を検索の語にする（1字以上100字以下で、改行を含まない時だけ。記法は除く） */
export function queryFromSelection(raw: string, start: number, end: number): string | null {
  const s = Math.min(start, end)
  const e = Math.max(start, end)
  if (e - s < 1 || e - s > MAX_SELECTION_QUERY) return null
  const picked = raw.slice(s, e)
  if (/[\r\n]/.test(picked)) return null
  const q = stripRuby(picked)
  return q ? q : null
}

/**
 * 欄の検索を開くキーか（Mac は ⌘F、ほかは Ctrl+F。Alt・Shift 付きは除く）。
 * Mac の Ctrl+F（テキスト欄で1字進む）は奪わない
 */
export function isFindShortcut(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  mac = IS_MAC,
): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return false
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** 検索を開くキーの表記 */
export const FIND_KEY_LABEL = IS_MAC ? '⌘F' : 'Ctrl+F'
