// アプリのステータスバー・ナビゲーションバー（Android のジェスチャーバー）の文字・アイコンの色を外観に合わせる。
// ブラウザは <meta name="theme-color">（src/ui/Layout.tsx の PrefsEffect）。アプリでは SystemBars（@capacitor/core に入っている）を使う。
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import type { Appearance } from '../store/uiStore'
import { isNative } from './platform'

/**
 * 外観に合うバーの形。Light = 明るい背景に暗いアイコン、Dark = 暗い背景に明るいアイコン（@capacitor/core の型定義の説明のとおり）
 */
export function systemBarsStyle(appearance: Appearance): SystemBarsStyle {
  return appearance === 'white' ? SystemBarsStyle.Light : SystemBarsStyle.Dark
}

/** アプリのとき、上下のバーを外観に合わせる（bar を指定しないので両方） */
export function applySystemBars(appearance: Appearance): void {
  if (!isNative()) return
  void SystemBars.setStyle({ style: systemBarsStyle(appearance) }).catch(() => undefined)
}
