// プログラムでカーソルを動かした時（巻き戻し・記号の挿入）に、カーソルのある行が見えるよう本文欄をスクロールする。
// ブラウザは setSelectionRange ではスクロールしないので、同じ書式の見えない要素で行の位置を測る。
// 長い原稿で毎回全文を組むと重い（1万5千字で数百ミリ秒）ので、段落（改行から改行まで）ごとの高さを控えておき、
// 控えていない段落とカーソルのある段落だけを組む（1回の編集で変わるのはふつう1段落）。
// 欄ごとの検索の印（SearchHitLayer）と、見つけた所までのスクロールでも使う（rangeRects・revealRange）。

/** 行の折り返しと位置に関わる書式（本文欄からそのまま写す。セパレート画面のカーソルの印でも使う） */
export const COPIED = [
  'boxSizing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontFeatureSettings',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'textIndent',
  'tabSize',
  'wordBreak',
  'lineBreak',
] as const

/** 控える段落の数の上限（超えたら控えをやり直す） */
const MAX_CACHED = 20_000

/** 段落の本文 → 組んだ高さ（書式と幅が同じ間だけ使う）。先頭の段落は字下げが付くので別の名前で控える */
let cache: { key: string; heights: Map<string, number> } | null = null

const ZWSP = '​'

/**
 * pos のある段落を見えない要素（本文欄と同じ書式・幅）に組んで測る（caretLine・rangeRects が共有する）。
 * 上の段落の高さは控えから足し、控えていない段落とその段落だけを組む。
 * fill はその段落の中身を入れ、本文欄に置いたまま測る関数を返す（mirror は見えない要素、para はその段落）。
 * 返す offsetTop は、その段落の上端の本文欄のスクロールの座標（上の余白を含む）
 */
function measureInParagraph<T>(
  el: HTMLTextAreaElement,
  pos: number,
  fill: (para: HTMLDivElement, paraStart: number, value: string) => (m: { mirror: HTMLDivElement; para: HTMLDivElement }) => T,
): { value: T; offsetTop: number; style: CSSStyleDeclaration } {
  const cs = getComputedStyle(el)
  const key = `${COPIED.map((p) => cs[p]).join('|')}|${el.clientWidth}`
  if (!cache || cache.key !== key || cache.heights.size > MAX_CACHED) cache = { key, heights: new Map() }
  const heights = cache.heights

  const v = el.value
  // pos のある段落の始まり（pos が 0 の時に lastIndexOf(…, -1) が先頭の改行を拾わないよう分ける）
  const start = pos === 0 ? 0 : v.lastIndexOf('\n', pos - 1) + 1
  const before = start > 0 ? v.slice(0, start - 1).split('\n') : []
  const paraKey = (i: number, text: string) => (i === 0 ? `\u0000${text}` : text)

  const mirror = document.createElement('div')
  const s = mirror.style
  for (const p of COPIED) s[p] = cs[p]
  s.position = 'absolute'
  s.visibility = 'hidden'
  s.top = '0'
  s.left = '-99999px'
  s.boxSizing = 'border-box'
  s.border = '0'
  s.paddingTop = '0'
  s.paddingBottom = '0'
  // スクロールバーを除いた幅（余白を含む）で折り返す
  s.width = `${el.clientWidth}px`
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = 'break-word'

  const block = (text: string, first: boolean) => {
    const d = document.createElement('div')
    // 字下げは本文欄の最初の行だけに付く
    if (!first) d.style.textIndent = '0'
    d.textContent = text
    mirror.appendChild(d)
    return d
  }

  // 控えていない段落だけを組む
  const measuring: { key: string; el: HTMLDivElement }[] = []
  const pending = new Set<string>()
  before.forEach((text, i) => {
    const k = paraKey(i, text)
    if (heights.has(k) || pending.has(k)) return
    pending.add(k)
    measuring.push({ key: k, el: block(text || ZWSP, i === 0) })
  })
  const para = block('', start === 0)
  const read = fill(para, start, v)

  document.body.appendChild(mirror)
  // 高さは小数のまま足す（offsetHeight の丸めは長い原稿で積もってずれる）
  for (const m of measuring) heights.set(m.key, m.el.getBoundingClientRect().height)
  const value = read({ mirror, para })
  mirror.remove()

  let above = 0
  before.forEach((text, i) => {
    above += heights.get(paraKey(i, text)) ?? 0
  })
  return { value, offsetTop: (parseFloat(cs.paddingTop) || 0) + above, style: cs }
}

/** pos の文字の行の上端と高さ（本文欄のスクロールの座標。上の余白を含む） */
export function caretLine(el: HTMLTextAreaElement, pos: number): { top: number; height: number } {
  const { value, offsetTop, style } = measureInParagraph(el, pos, (para, start, v) => {
    para.textContent = v.slice(start, pos)
    const marker = document.createElement('span')
    marker.textContent = v.slice(pos, pos + 1).replace('\n', '') || ZWSP
    para.appendChild(marker)
    return () => ({
      inner: marker.getBoundingClientRect().top - para.getBoundingClientRect().top,
      height: marker.offsetHeight,
    })
  })
  const height = value.height || parseFloat(style.lineHeight) || 20
  return { top: Math.round(offsetTop + value.inner), height }
}

/** 本文欄の中の矩形（本文欄のスクロールの座標。左右・上の余白を含む） */
export interface FieldRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * [start, end) の文字が本文欄で占める矩形（行ごと。検索の印 SearchHitLayer で使う）。
 * 範囲は1つの段落の中にあること（段落をまたぐ時は、その段落の終わりまで）。
 * 一致の後ろの文字も組むのは、行頭禁則などで折り返しの位置が変わるのを本文欄と同じにするため
 */
export function rangeRects(el: HTMLTextAreaElement, start: number, end: number): FieldRect[] {
  const { value, offsetTop } = measureInParagraph(el, start, (para, ps, v) => {
    const nl = v.indexOf('\n', start)
    const pe = nl < 0 ? v.length : nl
    const e = Math.max(start, Math.min(end, pe))
    para.textContent = v.slice(ps, start)
    const span = document.createElement('span')
    span.textContent = v.slice(start, e) || ZWSP
    para.appendChild(span)
    para.appendChild(document.createTextNode(v.slice(e, pe)))
    return ({ mirror, para: p }) => {
      const m = mirror.getBoundingClientRect()
      const top = p.getBoundingClientRect().top
      return [...span.getClientRects()]
        .filter((r) => r.width > 0)
        .map((r) => ({ x: r.left - m.left, y: r.top - top, width: r.width, height: r.height }))
    }
  })
  return value.map((r) => ({ ...r, y: r.y + offsetTop }))
}

/**
 * [start, end) の行が見えていなければ、上から3分の1ほどの所までスクロールする（見えていれば動かさない。
 * 推敲案の一覧から本文の箇所を選んだ時と同じ置き方）
 */
export function revealRange(el: HTMLTextAreaElement, start: number, end: number): void {
  if (el.scrollHeight <= el.clientHeight) return
  const first = caretLine(el, start)
  const last = end - 1 > start ? caretLine(el, end - 1) : first
  const viewTop = el.scrollTop
  const viewBottom = viewTop + el.clientHeight
  if (first.top >= viewTop && last.top + last.height <= viewBottom) return
  el.scrollTop = Math.max(0, first.top - el.clientHeight / 3)
}

/** カーソル（選択範囲の終わり）の行が見えていなければ、見える位置までスクロールする */
export function revealCaret(el: HTMLTextAreaElement | HTMLInputElement): void {
  if (!(el instanceof HTMLTextAreaElement) || el.scrollHeight <= el.clientHeight) return
  const { top, height } = caretLine(el, el.selectionEnd)
  const viewTop = el.scrollTop
  const viewBottom = viewTop + el.clientHeight
  if (top < viewTop) el.scrollTop = Math.max(0, top - height)
  else if (top + height > viewBottom) el.scrollTop = top + height * 2 - el.clientHeight
}
