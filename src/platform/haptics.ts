// 長押しでメニューを開いた時の軽い振動。iPhone の WKWebView には navigator.vibrate が無いので、アプリでは Haptics を使う。
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { isNative } from './platform'

export function lightTap(): void {
  try {
    if (isNative()) {
      void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
      return
    }
    navigator.vibrate?.(10)
  } catch {
    /* 振動できなくてもよい */
  }
}
