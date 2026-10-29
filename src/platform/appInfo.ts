// 「このアプリについて」（アプリの設定）とテスト版の期限の知らせ。
// iPhone のアプリは TestFlight のテスト版で、上げてから 90 日で使えなくなる。ビルドした日時から期限の目安を出し、75 日目から知らせる。
import { APP_VERSION } from '../sync/appModel'
import type { NativePlatform } from './platform'

const DAY = 24 * 60 * 60 * 1000
/** TestFlight のテスト版が使える日数 */
export const TESTFLIGHT_DAYS = 90
/** この日数を過ぎたら、期限が近いことを知らせる */
export const EXPIRY_WARN_DAYS = 75

/** ビルドした日時（vite.config.ts の define。埋め込まれていなければ null） */
export function buildTime(): number | null {
  return typeof __BUILD_TIME__ === 'number' && Number.isFinite(__BUILD_TIME__) ? __BUILD_TIME__ : null
}

/** 「2.4（iPhone アプリ）」 */
export function appVersionLabel(platform: NativePlatform): string {
  return `${APP_VERSION}（${platform === 'ios' ? 'iPhone アプリ' : 'Android アプリ'}）`
}

export interface TestFlightExpiry {
  /** 使えなくなる日時の目安 */
  expiresAt: number
  /** 残りの日数（切り上げ。過ぎていれば 0） */
  daysLeft: number
  /** 知らせる（75 日を過ぎた） */
  warn: boolean
}

export function testFlightExpiry(built: number, now: number): TestFlightExpiry {
  const expiresAt = built + TESTFLIGHT_DAYS * DAY
  return {
    expiresAt,
    daysLeft: Math.max(0, Math.ceil((expiresAt - now) / DAY)),
    warn: now >= built + EXPIRY_WARN_DAYS * DAY,
  }
}

/** 「11月27日」 */
export function formatMonthDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
