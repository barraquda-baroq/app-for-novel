// iPhone アプリの画面キーボード。capacitor.config.ts の Keyboard.resize = None で画面は縮めず、
// キーボードの高さ（変換候補の行・ホームインジケーターの分も含む）を CSS 変数 --kb-native に入れる。
// - 原稿画面・セパレート画面は、この分だけ高さを詰めて記号バー・「ここで区切る」をキーボードのすぐ上に出す
//   （src/features/piece/keyboardInset.ts が visualViewport の値と大きい方を --kb-inset に入れる）
// - ほかの画面は、ダイアログ・メニュー・通知をキーボードの上に収め、下に余白を足して入力欄をキーボードの上までスクロールできるようにする
//   （styles.css。値が 0 の間は何も変わらない）
// ブラウザと Android のアプリでは使わない（ずっと 0。Android は画面そのものがキーボードの上まで縮む）。
import { useEffect } from 'react'
import { Keyboard } from '@capacitor/keyboard'
import { isNativeIos } from './platform'

let height = 0
const listeners = new Set<() => void>()

/** いまの iPhone アプリのキーボードの高さ（px。閉じていれば 0） */
export const nativeKeyboardHeight = (): number => height

/** キーボードの高さを --kb-native に入れて知らせる（E2E テストからも使う） */
export function setNativeKeyboardHeight(h: number): void {
  const next = Number.isFinite(h) ? Math.max(0, Math.round(h)) : 0
  if (next === height) return
  height = next
  const root = document.documentElement
  if (next > 0) root.style.setProperty('--kb-native', `${next}px`)
  else root.style.removeProperty('--kb-native')
  for (const fn of [...listeners]) fn()
}

/** キーボードの高さが変わったら呼ぶ。戻り値で解除する */
export function onNativeKeyboard(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * フォーカスのある入力欄をキーボードの上まで出す（WebView 自身のスクロールは Keyboard プラグインが止めている）。
 * 原稿画面・セパレート画面は自分でカーソルの行まで動かすので、何もしない
 */
export function revealFocused(): void {
  const a = document.activeElement
  if (!(a instanceof HTMLElement) || a === document.body) return
  if (a.closest('.pw-root, .sep-root')) return
  a.scrollIntoView({ block: 'nearest' })
}

let started = false
/** 開いている原稿画面・セパレート画面の数（アクセサリーバーを消している間は 1 以上） */
let editors = 0

/** アクセサリーバー（「完了」の帯）を、原稿画面・セパレート画面の間だけ消す */
function applyAccessoryBar(): void {
  void Keyboard.setAccessoryBarVisible({ isVisible: editors === 0 }).catch(() => undefined)
}

/** iPhone アプリの起動時に一度だけ呼ぶ（src/platform/nativeInit.ts） */
export async function startIosKeyboard(): Promise<void> {
  if (started) return
  started = true
  // プラグインは既定でアクセサリーバーを消すので、ほかの画面では出しておく（最初の画面を描く前に頼む）
  applyAccessoryBar()
  await Keyboard.addListener('keyboardWillShow', (info) => setNativeKeyboardHeight(info.keyboardHeight))
  await Keyboard.addListener('keyboardDidShow', (info) => {
    // 変換候補の行が出入りした時などは高さが変わる
    setNativeKeyboardHeight(info.keyboardHeight)
    revealFocused()
  })
  await Keyboard.addListener('keyboardWillHide', () => setNativeKeyboardHeight(0))
  await Keyboard.addListener('keyboardDidHide', () => setNativeKeyboardHeight(0))
}

/**
 * 原稿画面・セパレート画面の間だけ、iPhone のキーボードの上の「完了」の帯（アクセサリーバー）を消す
 * （記号バーをキーボードのすぐ上に出すため。閉じるのは記号バーの「キーボードを閉じる」）。ほかの画面では出したまま
 */
export function useIosEditorKeyboard(): void {
  useEffect(() => {
    if (!isNativeIos()) return
    editors += 1
    applyAccessoryBar()
    return () => {
      editors = Math.max(0, editors - 1)
      applyAccessoryBar()
    }
  }, [])
}

/** テスト用 */
export function resetNativeKeyboardForTests(): void {
  height = 0
  started = false
  editors = 0
  listeners.clear()
  document.documentElement.style.removeProperty('--kb-native')
}
