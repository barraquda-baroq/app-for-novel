// 設定 → Claude 連携: コネクタの URL、連携の状態、書き込みの許可の切り替え、連携の解除
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import { copyText } from '../../ui/browser'
import { AppFrame } from '../../ui/Layout'
import type { ConnectorState } from './connectorDoc'

interface FakeSync {
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: { uid: string; name: string; email: string } | null
  accountMismatch: null
}

const sync = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<FakeSync>> }))
const conn = vi.hoisted(() => ({
  emit: null as null | ((s: ConnectorState) => void),
  watchConnector: vi.fn(),
  setConnectorWrites: vi.fn(async () => undefined),
  deleteConnector: vi.fn(async () => undefined),
}))
const origin = vi.hoisted(() => ({ value: 'https://conn.example.workers.dev' }))

vi.mock('../../sync/controller', async () => {
  const { create: make } = await import('zustand')
  sync.store = make<FakeSync>(() => ({ auth: 'signedOut', user: null, accountMismatch: null }))
  return { useSync: sync.store }
})
vi.mock('./connectorDoc', () => ({
  watchConnector: conn.watchConnector,
  setConnectorWrites: conn.setConnectorWrites,
  deleteConnector: conn.deleteConnector,
}))
vi.mock('./connectLogic', async (importOriginal) => {
  const original = await importOriginal<typeof import('./connectLogic')>()
  return {
    ...original,
    get CONNECTOR_ORIGIN() {
      return origin.value
    },
  }
})
vi.mock('../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ui/browser')>()
  return { ...original, copyText: vi.fn(async () => true) }
})

const { ClaudeSettings } = await import('./ClaudeSettings')

function renderSettings() {
  return render(
    <MemoryRouter>
      <AppFrame>
        <ClaudeSettings />
      </AppFrame>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  origin.value = 'https://conn.example.workers.dev'
  conn.watchConnector.mockReset()
  conn.watchConnector.mockImplementation((fn: (s: ConnectorState) => void) => {
    conn.emit = fn
    return () => {
      conn.emit = null
    }
  })
  conn.setConnectorWrites.mockClear()
  conn.deleteConnector.mockClear()
  sync.store.setState({ auth: 'signedOut', user: null })
})

afterEach(() => {
  cleanup()
  vi.mocked(copyText).mockClear()
})

describe('設定 → Claude 連携', () => {
  it('コネクタの URL をコピーできる。未設定なら「コネクタ未設定」', async () => {
    const user = userEvent.setup()
    const first = renderSettings()
    expect(screen.getByTestId('claude-connector-url').textContent).toBe('https://conn.example.workers.dev/mcp')
    await user.click(screen.getByTestId('claude-copy-url'))
    expect(vi.mocked(copyText).mock.calls[0][0]).toBe('https://conn.example.workers.dev/mcp')
    // ログインしていなければ、連携の状態は読まない
    expect(screen.getByTestId('claude-pairing-signin')).toBeTruthy()
    expect(conn.watchConnector).not.toHaveBeenCalled()
    first.unmount()

    origin.value = ''
    renderSettings()
    expect(screen.getByTestId('claude-connector-unset').textContent).toContain('コネクタ未設定')
    expect(screen.queryByTestId('claude-copy-url')).toBeNull()
  })

  it('連携の状態を出し、書き込みの許可を切り替え、確かめてから解除する', async () => {
    const user = userEvent.setup()
    sync.store.setState({ auth: 'signedIn', user: { uid: 'owner', name: '', email: 'o@example.com' } })
    renderSettings()
    await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
    act(() => conn.emit?.({ state: 'none' }))
    expect(screen.getByTestId('claude-pairing-none')).toBeTruthy()

    act(() =>
      conn.emit?.({
        state: 'paired',
        status: { uid: 'anon', pairedAt: new Date(2026, 9, 28, 9, 5).getTime(), approvedOn: 'Mac', writes: true },
      }),
    )
    const info = screen.getByTestId('claude-pairing-info')
    expect(info.textContent).toContain('2026/10/28 09:05')
    expect(info.textContent).toContain('Mac')
    expect(within(info).getByTestId('claude-writes-state').textContent).toBe('許可')

    await user.click(screen.getByTestId('claude-writes-toggle'))
    expect(conn.setConnectorWrites).toHaveBeenCalledWith(false)

    await user.click(screen.getByTestId('claude-unpair'))
    const dialog = await screen.findByRole('dialog')
    expect(conn.deleteConnector).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '連携を解除' }))
    await waitFor(() => expect(conn.deleteConnector).toHaveBeenCalledTimes(1))
  })
})
