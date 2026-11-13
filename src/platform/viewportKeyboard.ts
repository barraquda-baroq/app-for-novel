// 画面キーボードに隠れる高さを、どの端末でも CSS 変数 --kb（レイアウトの表示領域の下から）と --kb-top（見えている範囲の上端）にまとめる。
// ダイアログ（スマホでは下からのシート）・メニュー・通知・推敲案のシートは、この2つでキーボードの上の見えている範囲に収める（styles.css）。
// - iPhone のアプリ: 画面は縮まず、キーボードの高さがアプリから届く（--kb-native。src/platform/keyboard.ts）
// - iPhone の Safari・ホーム画面に追加した Web 版（iPhone のほかのブラウザも WebKit）: 画面（レイアウトの表示領域）は縮まず、
//   見えている範囲（visualViewport）だけが縮むので、その差を測る。Safari が入力欄を見せるために見えている範囲を下げた分（offsetTop）は
//   --kb-top に入れ、下からの高さからは除く
// - Android: Chrome は index.html の interactive-widget=resizes-content、アプリは SystemBars（insetsHandling 'css'）が
//   WebView を IME の分だけ縮めるので、差は出ず 0 のまま
// --kb は、アプリから届いた高さと測った高さの大きい方（WebKit もキーボードを扱った時に二重に上げない）。
// 原稿画面・セパレート画面の高さを詰める --kb-inset（src/features/piece/keyboardInset.ts）とは別に測る（あちらは流れのレイアウト、
// こちらは固定の重なり。同じ要素に両方を使わない）
import { nativeKeyboardHeight, onNativeKeyboard } from './keyboard'

/**
 * これより小さい差はキーボードと見なさない。ブラウザのツールバー（ホームインジケーター込みで 90px 前後）や
 * iPad の外付けキーボードのショートカットの帯より大きく、いちばん低いキーボード（横向きで 190px ほど）より小さい
 */
export const KEYBOARD_MIN_COVER = 100
/** 拡大している時（ピンチ）は測らない */
const MAX_SCALE = 1.01

export interface KeyboardCover {
  /** レイアウトの表示領域の下端から、キーボード（と見えていない所）に隠れる高さ（px） */
  bottom: number
  /** レイアウトの表示領域の上端から、見えている範囲の上端まで（Safari が見えている範囲を下げた分。px） */
  top: number
}

const NONE: KeyboardCover = { bottom: 0, top: 0 }

/**
 * layoutHeight（レイアウトの表示領域の高さ）のうち、見えている範囲（visualViewport）の外に隠れている高さ。
 * active（入力欄にフォーカスがあるかダイアログを開いている）でない時・拡大している時・差が KEYBOARD_MIN_COVER 未満の時は 0。
 * 差の判定は見えている範囲の上と下の合計で行う（Safari が大きく下げても数える）
 */
export function measureCover(
  layoutHeight: number,
  vv: { height: number; offsetTop: number; scale: number } | null | undefined,
  active: boolean,
): KeyboardCover {
  if (!vv || !active || vv.scale > MAX_SCALE || layoutHeight - vv.height < KEYBOARD_MIN_COVER) return NONE
  return {
    bottom: Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop)),
    top: Math.max(0, Math.round(vv.offsetTop)),
  }
}

/** キーボードを出す入力欄でない input の種類 */
const NO_KEYBOARD_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'file',
  'color',
  'image',
  'hidden',
])

/** キーボード（iPhone では選択肢の一覧も）を出す要素か */
export function isKeyboardTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !NO_KEYBOARD_INPUTS.has(el.type)
  return el.isContentEditable === true
}

/** 測るのは、入力欄にフォーカスがある時か、ダイアログを開いている時（［作る］を押してキーボードが閉じていく間もシートを追わせる）だけ */
function isActive(): boolean {
  return isKeyboardTarget(document.activeElement) || document.querySelector('.modal-backdrop') !== null
}

/** レイアウトの表示領域の高さ */
function layoutViewportHeight(): number {
  // iOS ではキーボードを出しても innerHeight が変わらない版と見えている高さになる版があるので、大きい方（keyboardInset.ts と同じ）
  return Math.max(window.innerHeight, document.documentElement.clientHeight)
}

function coverOf(layoutHeight: number): KeyboardCover {
  const measured = measureCover(layoutHeight, window.visualViewport, isActive())
  return { bottom: Math.max(nativeKeyboardHeight(), measured.bottom), top: measured.top }
}

/** 今の値（アプリから届いた高さと測った高さの大きい方） */
export function keyboardCover(): KeyboardCover {
  return coverOf(layoutViewportHeight())
}

let started = false
let frame = 0
let last: KeyboardCover = NONE
/** 前に測った時の、キーボードの上の見えている範囲の高さ（レイアウトの高さ − 下 − 上） */
let lastVisible = 0
let revealFrame = 0

function setVar(name: string, px: number): void {
  const root = document.documentElement
  if (px > 0) root.style.setProperty(name, `${px}px`)
  else root.style.removeProperty(name)
}

/** シートが縮んだ・動いた後に、ダイアログの中でフォーカスしている入力欄を見える所まで出す（.modal-body をスクロールする） */
function revealInDialog(): void {
  cancelAnimationFrame(revealFrame)
  revealFrame = requestAnimationFrame(() => {
    const a = document.activeElement
    if (a instanceof HTMLElement && a !== document.body && a.closest('.modal')) a.scrollIntoView?.({ block: 'nearest' })
  })
}

/**
 * すぐに測って CSS 変数に入れる（アプリのキーボードは出始めた時にすぐ。次の描画を待たない）。
 * キーボードの上の見えている範囲が縮んだ時（キーボードが高くなった・横向きにした・画面を分けた。横向きにするとキーボードは低くなるが、
 * 画面はそれ以上に低くなる）と、上端が動いた時に、ダイアログの中でフォーカスしている欄を見せる。広がった時（キーボードが閉じていく）は動かさない
 */
export function applyKeyboardNow(): void {
  cancelAnimationFrame(frame)
  const height = layoutViewportHeight()
  const next = coverOf(height)
  const visible = height - next.bottom - next.top
  const reveal = visible < lastVisible || next.bottom > last.bottom || next.top !== last.top
  lastVisible = visible
  if (next.bottom !== last.bottom || next.top !== last.top) {
    last = next
    setVar('--kb', next.bottom)
    setVar('--kb-top', next.top)
  }
  if (reveal) revealInDialog()
}

/**
 * 次の描画の前に測り直す（ダイアログを開いた・閉じた時など）。始める前（単体テスト）は何もしない。
 * フォーカスの移り変わり（前の欄から外れて次の欄に入る）を1回にまとめるので、間で一瞬 0 にならない
 */
export function refreshKeyboard(): void {
  if (!started) return
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(applyKeyboardNow)
}

/** 起動時に一度だけ呼ぶ（src/main.tsx。どの端末でも）。戻り値で止める（テスト用） */
export function startViewportKeyboard(): () => void {
  if (started) return () => {}
  started = true
  const vv = window.visualViewport
  const opts = { passive: true } as const
  vv?.addEventListener('resize', refreshKeyboard, opts)
  vv?.addEventListener('scroll', refreshKeyboard, opts)
  window.addEventListener('resize', refreshKeyboard, opts)
  document.addEventListener('focusin', refreshKeyboard, true)
  document.addEventListener('focusout', refreshKeyboard, true)
  const offNative = onNativeKeyboard(applyKeyboardNow)
  applyKeyboardNow()
  return () => {
    vv?.removeEventListener('resize', refreshKeyboard)
    vv?.removeEventListener('scroll', refreshKeyboard)
    window.removeEventListener('resize', refreshKeyboard)
    document.removeEventListener('focusin', refreshKeyboard, true)
    document.removeEventListener('focusout', refreshKeyboard, true)
    offNative()
    resetViewportKeyboardForTests()
  }
}

/** テスト用 */
export function resetViewportKeyboardForTests(): void {
  cancelAnimationFrame(frame)
  cancelAnimationFrame(revealFrame)
  started = false
  last = NONE
  lastVisible = 0
  setVar('--kb', 0)
  setVar('--kb-top', 0)
}
