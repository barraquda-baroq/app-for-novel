// 通し読みのスクロール位置。目次から話へ移動する・縦書きや文字の大きさを切り替えた後も同じ所を出す。
// 画面の外の話は見積もりの大きさで場所を取っている（content-visibility: auto）ので、
// 移動した直後に周りの話が組み上がって位置がずれたら、落ち着くまで（数フレーム）合わせ直す。

export interface ReadingAnchor {
  /** 読んでいた話の要素の id */
  id: string
  /** その話のどこまで読んでいたか（0〜1、読み進める方向の割合） */
  fraction: number
}

/**
 * 読み始めの線。目次から移動した話の頭が来る位置と同じにする（話の scroll-margin で決まる）。
 * 横書き: 画面の上端から（固定されたヘッダー・ツールバーの下）、縦書き: 本文の枠の右端の内側。
 */
function startLine(doc: HTMLElement, vertical: boolean, piece: HTMLElement): number {
  const margin = getComputedStyle(piece)
  if (vertical) {
    const r = doc.getBoundingClientRect()
    return r.right - parseFloat(getComputedStyle(doc).borderRightWidth || '0') - parseFloat(margin.scrollMarginRight || '0')
  }
  return parseFloat(margin.scrollMarginTop || '0')
}

/** 今読んでいる話と、その中の位置。先頭にいる（まだスクロールしていない）ときは null */
export function readingAnchor(doc: HTMLElement, vertical: boolean): ReadingAnchor | null {
  if (vertical ? doc.scrollLeft > -1 : window.scrollY < 1) return null
  const pieces = doc.querySelectorAll<HTMLElement>('.rt-piece')
  if (pieces.length === 0) return null
  const line = startLine(doc, vertical, pieces[0])
  // 読み始めの線にかかっている（または線より後ろで最初の）話を二分探索で探す
  let lo = 0
  let hi = pieces.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = pieces[mid].getBoundingClientRect()
    const passed = vertical ? r.left >= line : r.bottom <= line
    if (passed) lo = mid + 1
    else {
      found = mid
      hi = mid - 1
    }
  }
  if (found < 0) return null
  const el = pieces[found]
  const r = el.getBoundingClientRect()
  const size = vertical ? r.width : r.height
  const read = vertical ? r.right - line : line - r.top
  return { id: el.id, fraction: size > 0 ? Math.min(1, Math.max(0, read / size)) : 0 }
}

function alignTo(target: HTMLElement, doc: HTMLElement | null, vertical: boolean, fraction: number): void {
  target.scrollIntoView?.({ behavior: 'auto', block: 'start', inline: 'nearest' })
  if (fraction <= 0) return
  const r = target.getBoundingClientRect()
  if (vertical && doc) doc.scrollLeft -= fraction * r.width
  else window.scrollBy?.({ top: fraction * r.height, behavior: 'instant' as ScrollBehavior })
}

function position(target: HTMLElement, vertical: boolean): number {
  const r = target.getBoundingClientRect()
  return vertical ? r.right : r.top
}

/**
 * target を読み始めの位置へすぐに（アニメーションなしで）出し、周りの話が組み上がって位置がずれたら合わせ直す。
 * 利用者がスクロール・操作を始めたら合わせ直すのをやめる。戻り値はやめるための関数。
 */
export function settleScrollTo(target: HTMLElement, doc: HTMLElement | null, vertical: boolean, fraction: number): () => void {
  let stopped = false
  let frame = 0
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    for (const ev of events) window.removeEventListener(ev, stop, true)
  }
  for (const ev of events) window.addEventListener(ev, stop, { capture: true, passive: true })

  alignTo(target, doc, vertical, fraction)
  let last = position(target, vertical)
  let passes = 0
  // 2フレーム待つと、画面に入った話が組み上がっている
  const check = () => {
    if (stopped || !target.isConnected) return stop()
    const now = position(target, vertical)
    if (Math.abs(now - last) < 1 && passes > 0) return stop()
    alignTo(target, doc, vertical, fraction)
    last = position(target, vertical)
    passes += 1
    if (passes >= 4) return stop()
    frame = requestAnimationFrame(() => (frame = requestAnimationFrame(check)))
  }
  frame = requestAnimationFrame(() => (frame = requestAnimationFrame(check)))
  return stop
}
