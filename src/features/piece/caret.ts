// プログラムでカーソルを動かした時（巻き戻し・記号の挿入）に、カーソルのある行が見えるよう本文欄をスクロールする。
// ブラウザは setSelectionRange ではスクロールしないので、同じ書式の見えない要素で行の位置を測る。

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

/** pos の文字の行の上端と高さ（本文欄のスクロールの座標。上の余白を含む） */
export function caretLine(el: HTMLTextAreaElement, pos: number): { top: number; height: number } {
  const cs = getComputedStyle(el)
  const mirror = document.createElement('div')
  const s = mirror.style
  for (const p of COPIED) s[p] = cs[p]
  s.position = 'absolute'
  s.visibility = 'hidden'
  s.top = '0'
  s.left = '-99999px'
  s.boxSizing = 'border-box'
  s.border = '0'
  // スクロールバーを除いた幅（余白を含む）で折り返す
  s.width = `${el.clientWidth}px`
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = 'break-word'
  mirror.textContent = el.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(pos, pos + 1).replace('\n', '') || '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 20
  mirror.remove()
  return { top, height }
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
