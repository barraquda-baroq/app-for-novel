// プログラムでカーソルを動かした時（巻き戻し・記号の挿入）に、カーソルのある行が見えるよう本文欄をスクロールする。
// ブラウザは setSelectionRange ではスクロールしないので、同じ書式の見えない要素で行の位置を測る。
// 長い原稿で毎回全文を組むと重い（1万5千字で数百ミリ秒）ので、段落（改行から改行まで）ごとの高さを控えておき、
// 控えていない段落とカーソルのある段落だけを組む（1回の編集で変わるのはふつう1段落）。

/** 行の折り返しと位置に関わる書式（本文欄からそのまま写す） */
const COPIED = [
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

/** pos の文字の行の上端と高さ（本文欄のスクロールの座標。上の余白を含む） */
export function caretLine(el: HTMLTextAreaElement, pos: number): { top: number; height: number } {
  const cs = getComputedStyle(el)
  const key = `${COPIED.map((p) => cs[p]).join('|')}|${el.clientWidth}`
  if (!cache || cache.key !== key || cache.heights.size > MAX_CACHED) cache = { key, heights: new Map() }
  const heights = cache.heights

  const v = el.value
  // カーソルのある段落の始まり（pos が 0 の時に lastIndexOf(…, -1) が先頭の改行を拾わないよう分ける）
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
  const cur = block(v.slice(start, pos), start === 0)
  const marker = document.createElement('span')
  marker.textContent = v.slice(pos, pos + 1).replace('\n', '') || ZWSP
  cur.appendChild(marker)

  document.body.appendChild(mirror)
  // 高さは小数のまま足す（offsetHeight の丸めは長い原稿で積もってずれる）
  for (const m of measuring) heights.set(m.key, m.el.getBoundingClientRect().height)
  const inner = marker.getBoundingClientRect().top - cur.getBoundingClientRect().top
  const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 20
  mirror.remove()

  let above = 0
  before.forEach((text, i) => {
    above += heights.get(paraKey(i, text)) ?? 0
  })
  return { top: Math.round((parseFloat(cs.paddingTop) || 0) + above + inner), height }
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
