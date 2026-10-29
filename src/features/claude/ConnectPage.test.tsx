// 連携の画面（#/claude/connect）: 持ち主の確かめ、同期を待つ、コネクタの場所の固定、k は指紋だけを Firestore に書く
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import { createPersistence } from '../../db/persistence'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { AppFrame } from '../../ui/Layout'
import type { ConnectorWrite } from './connectLogic'

const ORIGIN = 'https://conn.example.workers.dev'

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface FakeSync {
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: { uid: string; name: string; email: string } | null
  status: { phase: string; pending: number } | null
  accountMismatch: null
  busy: boolean
  error: string | null
}

const sync = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<FakeSync>> }))
const doc = vi.hoisted(() => ({
  owner: 'owner-uid' as string | null,
  written: [] as unknown[],
  readOwnerUid: vi.fn(),
  writeConnector: vi.fn(),
}))
const leave = vi.hoisted(() => ({ leaveTo: vi.fn() }))

vi.mock('../../sync/controller', async () => {
  const { create: make } = await import('zustand')
  sync.store = make<FakeSync>(() => ({
    auth: 'signedIn',
    user: { uid: 'owner-uid', name: '持ち主', email: 'owner@example.com' },
    status: { phase: 'synced', pending: 0 },
    accountMismatch: null,
    busy: false,
    error: null,
  }))
  return {
    useSync: sync.store,
    signIn: vi.fn(),
    signOut: vi.fn(),
    syncNow: vi.fn(async () => undefined),
  }
})
vi.mock('../../sync/appModel', () => ({ DATA_MODEL: 3 }))
vi.mock('./connectorDoc', () => ({
  readOwnerUid: doc.readOwnerUid,
  writeConnector: doc.writeConnector,
}))
vi.mock('./leave', () => leave)
vi.mock('./connectLogic', async (importOriginal) => {
  const original = await importOriginal<typeof import('./connectLogic')>()
  return { ...original, CONNECTOR_ORIGIN: 'https://conn.example.workers.dev' }
})

const { ConnectPage } = await import('./ConnectPage')

let n = 0
const fetchMock = vi.fn()

function renderPage(state = 'state-123') {
  return render(
    <MemoryRouter initialEntries={[`/claude/connect?s=${encodeURIComponent(state)}&uid=attacker&origin=https://evil.example`]}>
      <AppFrame>
        <Routes>
          <Route path="/claude/connect" element={<ConnectPage />} />
        </Routes>
      </AppFrame>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  await initStore(createPersistence(`test-db-connect-${++n}`))
  doc.owner = 'owner-uid'
  doc.written = []
  doc.readOwnerUid.mockClear()
  doc.writeConnector.mockClear()
  doc.readOwnerUid.mockImplementation(async () => doc.owner)
  doc.writeConnector.mockImplementation(async (d: ConnectorWrite) => {
    doc.written.push(d)
  })
  leave.leaveTo.mockReset()
  fetchMock.mockReset()
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ uid: 'anon-uid', version: '1.0', model: 3 }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  sync.store.setState({
    auth: 'signedIn',
    user: { uid: 'owner-uid', name: '持ち主', email: 'owner@example.com' },
    status: { phase: 'synced', pending: 0 },
  })
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  vi.unstubAllGlobals()
})

describe('連携の画面', () => {
  it('持ち主なら、ビルドの時に決めたコネクタに問い合わせ、許可すると指紋だけを書いてコネクタへ移る', async () => {
    const user = userEvent.setup()
    const a = actions.createTitle('見せる作品')
    const b = actions.createTitle('秘密の作品')
    actions.setTitleClaudeAccess(b, 'none')
    renderPage()
    expect(screen.getByTestId('connect-host').textContent).toContain('conn.example.workers.dev')
    const form = await screen.findByTestId('connect-form')
    // URL の uid・origin は使わない
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/connect/identity`)
    const rows = within(form).getAllByTestId('connect-title')
    expect(rows.map((r) => r.textContent?.slice(0, 5))).toEqual(['見せる作品', '秘密の作品'])
    expect(within(rows[0]).getByTestId('connect-access-write').getAttribute('aria-pressed')).toBe('true')
    expect(within(rows[1]).getByTestId('connect-access-none').getAttribute('aria-pressed')).toBe('true')
    expect(form.textContent).toContain('心当たりのない依頼')

    // 見せるタイトルを変え、書き込みは許可しない
    await user.click(within(rows[0]).getByTestId('connect-access-read'))
    await user.click(within(form).getByTestId('connect-writes'))
    await user.click(within(form).getByTestId('connect-approve'))

    await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
    const url = new URL(leave.leaveTo.mock.calls[0][0] as string)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/pair/callback')
    expect(url.searchParams.get('state')).toBe('state-123')
    const k = url.searchParams.get('k')!
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(doc.written).toEqual([
      {
        uid: 'anon-uid',
        pairing: await sha(`state-123.${k}`),
        approvedOn: 'ブラウザ',
        writes: false,
        v: 1,
      },
    ])
    expect(JSON.stringify(doc.written)).not.toContain(k)
    expect(getData().titles[a].claudeAccess).toBe('read')
    expect(getData().titles[b].claudeAccess).toBe('none')
    expect(screen.getByTestId('connect-done')).toBeTruthy()
  })

  it('持ち主でなければ問い合わせも記録もしない', async () => {
    doc.owner = 'someone-else'
    renderPage()
    await screen.findByTestId('connect-not-owner')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(doc.writeConnector).not.toHaveBeenCalled()
  })

  it('同期が揃うまで待ち、揃ってから問い合わせる', async () => {
    sync.store.setState({ status: { phase: 'downloading', pending: 0 } })
    renderPage()
    await screen.findByTestId('connect-sync-wait')
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => sync.store.setState({ status: { phase: 'synced', pending: 0 } }))
    await screen.findByTestId('connect-form')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ログインしていなければログインを促す。印が無ければ先へ進まない', async () => {
    sync.store.setState({ auth: 'signedOut', user: null })
    const { unmount } = renderPage()
    expect(screen.getByTestId('connect-signin')).toBeTruthy()
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
    unmount()
    sync.store.setState({ auth: 'signedIn', user: { uid: 'owner-uid', name: '', email: '' } })
    renderPage('a b')
    expect(screen.getByTestId('connect-no-state')).toBeTruthy()
    expect(doc.readOwnerUid).not.toHaveBeenCalled()
  })

  it('コネクタのアカウントが持ち主と同じ・答えが無い時は先へ進まない。［やめる］では何も書かない', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uid: 'owner-uid', model: 3 }), { status: 200 }))
    const first = renderPage()
    await screen.findByTestId('connect-identity-error')
    first.unmount()

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uid: 'anon-uid', model: 2 }), { status: 200 }))
    renderPage()
    const form = await screen.findByTestId('connect-form')
    expect(within(form).getByTestId('connect-model-warning').textContent).toContain('（2）')
    await user.click(within(form).getByTestId('connect-cancel'))
    expect(screen.getByTestId('connect-cancelled')).toBeTruthy()
    expect(doc.writeConnector).not.toHaveBeenCalled()
    expect(leave.leaveTo).not.toHaveBeenCalled()
  })
})
