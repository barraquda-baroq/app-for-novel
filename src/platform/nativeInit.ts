// アプリ（iPhone / Android）の起動時の準備。src/main.tsx から呼ぶ（ブラウザでは何もしない）。
// - 裏に回る（pause）: 書きかけも含めてすぐ保存し、同期は待たずに送る。表に戻る（resume）: 長く裏にあったら同期を購読し直す
//   （WebView の visibilitychange が届かないことがあるので、アプリの知らせでも同じことをする。二重に届いても害はない）
// - Android の「戻る」: メニュー・ダイアログが開いていれば閉じる（Esc と同じ）、戻れる画面があれば戻る、
//   いちばん最初の画面なら保存してからアプリを裏に回す（閉じない）
// - iPhone: キーボードの高さを受け取る（src/platform/keyboard.ts）
// - 起動の画面（スプラッシュ）は最初の描画の後に消す
import { App } from '@capacitor/app'
import { SplashScreen } from '@capacitor/splash-screen'
import { saveBeforeLeave } from '../store/lifecycle'
import { noteAppHidden, noteAppVisible } from '../sync/controller'
import { startIosKeyboard } from './keyboard'
import { nativePlatform } from './platform'

/**
 * いちばん上のメニュー・ダイアログに Esc を送って閉じる（それぞれの Esc の扱いをそのまま使う）。
 * 開いているものが無ければ false
 */
export function closeTopLayer(doc: Document = document): boolean {
  const menus = doc.querySelectorAll<HTMLElement>('[role="menu"]')
  const modals = doc.querySelectorAll<HTMLElement>('.modal-backdrop .modal')
  // メニューはダイアログの上に開く
  const target = menus[menus.length - 1] ?? modals[modals.length - 1]
  if (!target) return false
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
}

export interface BackButtonDeps {
  back: () => void
  minimize: () => Promise<void>
  save: () => Promise<unknown>
}

/** Android の「戻る」 */
export async function handleBackButton(canGoBack: boolean, deps: BackButtonDeps): Promise<void> {
  if (closeTopLayer()) return
  if (canGoBack) {
    // 保存していない編集がある時は、ふだんの移動と同じように確かめる（useBlocker）
    deps.back()
    return
  }
  await deps.save().catch(() => undefined)
  await deps.minimize().catch(() => undefined)
}

let splashHidden = false

/** 起動の画面を消す（一度だけ） */
export function hideSplash(): void {
  if (splashHidden || !nativePlatform()) return
  splashHidden = true
  void SplashScreen.hide().catch(() => undefined)
}

let started = false

export function initNative(): void {
  const platform = nativePlatform()
  if (!platform || started) return
  started = true
  void App.addListener('pause', () => {
    void saveBeforeLeave()
    noteAppHidden()
  })
  void App.addListener('resume', () => noteAppVisible())
  void App.addListener('backButton', ({ canGoBack }) => {
    void handleBackButton(canGoBack, {
      back: () => history.back(),
      minimize: () => App.minimizeApp(),
      save: () => saveBeforeLeave(),
    })
  })
  if (platform === 'ios') void startIosKeyboard()
  // 描画できなかった時も、起動の画面のまま止まらないようにする
  setTimeout(hideSplash, 5000)
}
