// アプリ（iPhone / Android）だけ違う画面: 更新のしかた・期限の知らせ・このアプリについて・バーの色（Capacitor は偽物）
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ platform: 'ios' as 'ios' | 'android' | null }))
vi.mock('./platform', () => ({
  nativePlatform: () => h.platform,
  isNative: () => h.platform !== null,
  isNativeIos: () => h.platform === 'ios',
}))

import { AboutApp } from '../features/appSettings/AboutApp'
import { DataSettings } from '../features/appSettings/DataSettings'
import { useSync } from '../sync/controller'
import { OutdatedBanner, TestFlightExpiryBanner } from '../ui/Layout'
import { appVersionLabel, buildTime, EXPIRY_WARN_DAYS, formatMonthDay, testFlightExpiry } from './appInfo'
import { systemBarsStyle } from './systemBars'
import { nativeUpdateHelp } from './update'

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  h.platform = 'ios'
  useSync.setState({ status: null })
})
afterEach(cleanup)

describe('nativeUpdateHelp', () => {
  it('iPhone は TestFlight、Android は android:install。どちらもアプリを削除しない', () => {
    const ios = nativeUpdateHelp('ios')
    expect(ios.link).toEqual({ href: 'itms-beta://', label: 'TestFlight を開く' })
    expect(ios.lines.join('')).toContain('TestFlight')
    const android = nativeUpdateHelp('android')
    expect(android.link).toBeUndefined()
    expect(android.lines.join('')).toContain('npm run android:install')
    for (const help of [ios, android]) expect(help.lines.join('')).toContain('アプリは削除しないでください')
  })
})

describe('OutdatedBanner', () => {
  const outdated = () =>
    useSync.setState({
      status: { outdated: { model: 4, appVersion: '2.5' }, pending: 2 } as never,
    })

  it('アプリでは「更新のしかた」で手順を出す（読み込み直さない）', async () => {
    outdated()
    render(<OutdatedBanner />)
    expect(screen.queryByTestId('outdated-update')).toBeNull()
    await userEvent.click(screen.getByTestId('outdated-help'))
    expect(screen.getByTestId('native-update-help').textContent).toContain('TestFlight')
    expect(screen.getByTestId('native-update-link').getAttribute('href')).toBe('itms-beta://')
    await userEvent.click(screen.getByTestId('native-update-close'))
    expect(screen.queryByTestId('native-update-help')).toBeNull()
  })

  it('Android は TestFlight のリンクを出さない', async () => {
    h.platform = 'android'
    outdated()
    render(<OutdatedBanner />)
    await userEvent.click(screen.getByTestId('outdated-help'))
    expect(screen.getByTestId('native-update-help').textContent).toContain('android:install')
    expect(screen.queryByTestId('native-update-link')).toBeNull()
  })

  it('ブラウザはこれまでどおり「更新する」', () => {
    h.platform = null
    outdated()
    render(<OutdatedBanner />)
    expect(screen.getByTestId('outdated-update').textContent).toBe('更新する')
    expect(screen.queryByTestId('outdated-help')).toBeNull()
  })
})

describe('テスト版の期限', () => {
  it('90 日後が期限、75 日を過ぎたら知らせる', () => {
    const built = new Date(2026, 9, 29, 12).getTime()
    const e = testFlightExpiry(built, built + 10 * DAY)
    expect(formatMonthDay(e.expiresAt)).toBe('1月27日')
    expect(e.daysLeft).toBe(80)
    expect(e.warn).toBe(false)
    expect(testFlightExpiry(built, built + EXPIRY_WARN_DAYS * DAY).warn).toBe(true)
    expect(testFlightExpiry(built, built + 100 * DAY).daysLeft).toBe(0)
  })

  it('ビルドした日時は埋め込まれている', () => {
    expect(buildTime()).toBeTypeOf('number')
  })

  it('知らせは iPhone のアプリで 75 日を過ぎた時だけ', () => {
    const built = buildTime()!
    const { unmount } = render(<TestFlightExpiryBanner now={built + 10 * DAY} />)
    expect(screen.queryByTestId('testflight-expiry-banner')).toBeNull()
    unmount()
    const late = render(<TestFlightExpiryBanner now={built + 80 * DAY} />)
    expect(screen.getByTestId('testflight-expiry-banner').textContent).toContain('あと10日')
    late.unmount()
    h.platform = 'android'
    render(<TestFlightExpiryBanner now={built + 80 * DAY} />)
    expect(screen.queryByTestId('testflight-expiry-banner')).toBeNull()
  })
})

describe('このアプリについて', () => {
  it('iPhone: 版・ビルドした日・テスト版の期限', () => {
    const built = buildTime()!
    render(<AboutApp platform="ios" now={built + DAY} />)
    expect(screen.getByTestId('about-version').textContent).toBe(appVersionLabel('ios'))
    expect(appVersionLabel('ios')).toMatch(/^\d+\.\d+（iPhone アプリ）$/)
    expect(screen.getByTestId('about-expiry').textContent).toContain('あと89日')
  })

  it('Android: 期限は出さない', () => {
    render(<AboutApp platform="android" />)
    expect(screen.getByTestId('about-version').textContent).toContain('Android アプリ')
    expect(screen.queryByTestId('about-expiry')).toBeNull()
  })
})

describe('データの説明（アプリ）', () => {
  it('「アプリ」と書き、削除でデータが消えることを出す。自動削除の防止は表示だけ', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 1024, quota: 2048 }), persisted: async () => false, persist: async () => true },
    })
    render(<DataSettings />)
    expect(screen.getByTestId('native-data-note').textContent).toContain('アプリを削除すると、端末の中のデータは消えます')
    expect(screen.getByTestId('data-settings').textContent).not.toContain('ブラウザ')
    expect(await screen.findByText(/無効（空き容量が少なくなると、データが削除されることがあります/)).toBeTruthy()
    expect(screen.queryByTestId('request-persist')).toBeNull()
  })

  it('ブラウザはこれまでどおり（頼むボタンあり）', async () => {
    h.platform = null
    render(<DataSettings />)
    expect(screen.queryByTestId('native-data-note')).toBeNull()
    expect(await screen.findByTestId('request-persist')).toBeTruthy()
  })
})

describe('systemBarsStyle', () => {
  it('ホワイトは暗いアイコン（Light）、ダーク・ディープダークは明るいアイコン（Dark）', () => {
    expect(systemBarsStyle('white')).toBe('LIGHT')
    expect(systemBarsStyle('dark')).toBe('DARK')
    expect(systemBarsStyle('deep-dark')).toBe('DARK')
  })
})
