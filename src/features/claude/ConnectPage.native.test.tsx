// アプリ（iPhone / Android）で連携の画面が開いた時: 許可はせず、同じ印のままブラウザで開いてもらう
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ readOwnerUid: vi.fn(), fetchIdentity: vi.fn() }))

vi.mock('../../platform/platform', () => ({ isNative: () => true, nativePlatform: () => 'ios', isNativeIos: () => true }))
vi.mock('../../sync/controller', async () => {
  const { create } = await import('zustand')
  return {
    useSync: create(() => ({
      auth: 'signedIn',
      user: { uid: 'owner-uid', name: '持ち主', email: 'owner@example.com' },
      status: { phase: 'synced', pending: 0 },
      accountMismatch: null,
      busy: false,
      error: null,
    })),
    signIn: vi.fn(),
    signOut: vi.fn(),
    syncNow: vi.fn(),
  }
})
vi.mock('./connectorDoc', () => ({ readOwnerUid: h.readOwnerUid, writeConnector: vi.fn() }))
vi.mock('./connectLogic', async (importOriginal) => {
  const original = await importOriginal<typeof import('./connectLogic')>()
  return { ...original, CONNECTOR_ORIGIN: 'https://conn.example.workers.dev', fetchIdentity: h.fetchIdentity }
})

const { ConnectPage, webConnectUrl } = await import('./ConnectPage')

afterEach(cleanup)

const renderPage = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/claude/connect${search}`]}>
      <Routes>
        <Route path="/claude/connect" element={<ConnectPage />} />
      </Routes>
    </MemoryRouter>,
  )

describe('ConnectPage（アプリ）', () => {
  it('「ブラウザで開く」は Web 版の同じ画面（同じ ?s=）。アプリの中では確かめに行かない', async () => {
    renderPage('?s=abc%2B1')
    const link = await screen.findByTestId('connect-open-browser')
    expect(link.getAttribute('href')).toBe('https://novel-studio-3352e.web.app/#/claude/connect?s=abc%2B1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByTestId('connect-signin')).toBeNull()
    expect(h.readOwnerUid).not.toHaveBeenCalled()
    expect(h.fetchIdentity).not.toHaveBeenCalled()
  })

  it('印が無ければ、claude.ai からやり直してもらう', () => {
    renderPage('')
    expect(screen.getByTestId('connect-native').textContent).toContain('やり直してください')
    expect(screen.queryByTestId('connect-open-browser')).toBeNull()
  })

  it('webConnectUrl は印を URL の値として書く', () => {
    expect(webConnectUrl('a b&c')).toBe('https://novel-studio-3352e.web.app/#/claude/connect?s=a%20b%26c')
  })
})
