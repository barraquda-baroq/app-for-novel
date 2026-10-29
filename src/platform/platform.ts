// どこで動いているか: iPhone / Android のアプリ（Capacitor）か、ブラウザ（Web 版。Windows はこちら）か。
// アプリだけ違うことをする所は、ここで見分ける（docs/SPEC-2.md の 2.4）。ブラウザでは Capacitor の仕組みは何もしない。
import { Capacitor } from '@capacitor/core'

export type NativePlatform = 'ios' | 'android'

/** アプリで動いていればその種類、ブラウザなら null */
export function nativePlatform(): NativePlatform | null {
  const p = Capacitor.getPlatform()
  return p === 'ios' || p === 'android' ? p : null
}

/** iPhone / Android のアプリで動いている */
export const isNative = (): boolean => nativePlatform() !== null

/** iPhone のアプリで動いている */
export const isNativeIos = (): boolean => nativePlatform() === 'ios'
