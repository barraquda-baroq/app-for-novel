// アプリの設定の並び: iPhone / Android のアプリでは「このアプリについて」の後に「書体のライセンス」、その後に「危険な操作」
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform/platform', () => ({ isNative: () => true, nativePlatform: () => 'ios', isNativeIos: () => true }))
// 並びだけを確かめるので、同期・Claude 連携などの中身は空の箱にする
vi.mock('../../ui/Layout', () => ({ AppHeader: () => null }))
vi.mock('./SyncSettings', () => ({ SyncSettings: () => <section data-testid="sync-settings" /> }))
vi.mock('../claude/ClaudeSettings', () => ({ ClaudeSettings: () => <section data-testid="claude-settings" /> }))
vi.mock('./DisplaySettings', () => ({ DisplaySettings: () => <section data-testid="display-settings" /> }))
vi.mock('./DataSettings', () => ({ DataSettings: () => <section data-testid="data-settings" /> }))
vi.mock('./TrashSettings', () => ({ TrashSettings: () => <section data-testid="trash-settings" /> }))
vi.mock('./DangerZone', () => ({ DangerZone: () => <section data-testid="danger-zone" /> }))

const { AppSettingsPage } = await import('./AppSettingsPage')

afterEach(cleanup)

describe('AppSettingsPage（アプリ）', () => {
  it('「このアプリについて」「書体のライセンス」「危険な操作」の順に並ぶ（「ホーム画面に追加」は出さない）', () => {
    render(<AppSettingsPage />)
    const order = [...screen.getByTestId('app-settings').querySelectorAll(':scope > section')].map((e) =>
      e.getAttribute('data-testid'),
    )
    expect(order.slice(-3)).toEqual(['about-app', 'font-license', 'danger-zone'])
    expect(screen.queryByTestId('install-help')).toBeNull()
  })
})
