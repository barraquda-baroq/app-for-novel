// 設定 → Claude 連携: コネクタの URL、連携の状態、書き込みの許可の切り替え、連携の解除
// 2.9: 接続の一覧（名前・許可した日時・許可した端末）・名前を変える・1つ解除する（最後の1つはすべて解除と同じ）・すべて解除
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import { copyText } from '../../ui/browser'
import { AppFrame } from '../../ui/Layout'
import type { ConnectionInfo } from '../../claude/pairing'
import type { ConnectorStatus } from './connectLogic'
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
  removeConnection: vi.fn(async (_cid: string) => 'removed' as const),
  renameConnection: vi.fn(async (_cid: string, _name: string) => undefined),
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
  removeConnection: conn.removeConnection,
  renameConnection: conn.renameConnection,
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
  conn.removeConnection.mockClear()
  conn.renameConnection.mockClear()
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

  it('連携の状態を出し、書き込みの許可を切り替え、確かめてからすべて解除する（2.8 の記録は「接続1」1つ）', async () => {
    const user = userEvent.setup()
    sync.store.setState({ auth: 'signedIn', user: { uid: 'owner', name: '', email: 'o@example.com' } })
    renderSettings()
    await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
    act(() => conn.emit?.({ state: 'none' }))
    expect(screen.getByTestId('claude-pairing-none')).toBeTruthy()

    act(() =>
      conn.emit?.({
        state: 'paired',
        status: {
          uid: 'anon',
          pairedAt: new Date(2026, 9, 28, 9, 5).getTime(),
          approvedOn: 'Mac',
          writes: true,
          connections: [
            { cid: 'c0', name: '接続1', pairing: 'p', pairedAt: new Date(2026, 9, 28, 9, 5).getTime(), approvedOn: 'Mac' },
          ],
          pairingCid: 'c0',
        },
      }),
    )
    const info = screen.getByTestId('claude-pairing-info')
    expect(info.textContent).toContain('2026/10/28 09:05')
    expect(info.textContent).toContain('Mac')
    expect(within(info).getByTestId('claude-writes-state').textContent).toBe('許可')
    expect(within(info).getByTestId('claude-connection-count').textContent).toBe(
      '接続 1 / 10（claude.ai のアカウントごと。同時に10まで）',
    )
    const rows = within(info).getAllByTestId('claude-connection')
    expect(rows.map((r) => within(r).getByTestId('claude-connection-name').textContent)).toEqual(['接続1'])
    expect(rows[0].textContent).toContain('許可した日時 2026/10/28 09:05')
    expect(rows[0].textContent).toContain('許可した端末 Mac')
    expect(info.textContent).toContain('書き込みを許可（すべての接続に効きます）')
    expect(within(info).getByTestId('claude-connection-hint').textContent).toBe(
      'どの名前が claude.ai のどのアカウントかは、アプリからは分かりません。そのアカウントの Claude に「Novel Studio の状態（novel_status）を見て」と頼むと、最後の行に「この接続: 接続2」と出ます。',
    )

    await user.click(screen.getByTestId('claude-writes-toggle'))
    expect(conn.setConnectorWrites).toHaveBeenCalledWith(false)

    expect(screen.getByTestId('claude-unpair').textContent).toBe('連携をすべて解除')
    await user.click(screen.getByTestId('claude-unpair'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Claude との連携をすべて解除しますか？')
    expect(dialog.textContent).toContain('すべての接続（1件）が、その場で何も読めず、書き込めなくなります。')
    expect(conn.deleteConnector).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    await waitFor(() => expect(conn.deleteConnector).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Claude との連携をすべて解除しました')).toBeTruthy()
  })

  const at = (d: number) => new Date(2026, 10, d, 14, 32).getTime()
  const entry = (cid: string, name: string, d: number, approvedOn = 'Mac の Chrome'): ConnectionInfo => ({
    cid,
    name,
    pairing: `p-${cid}`,
    pairedAt: at(d),
    approvedOn,
  })
  const paired = (connections: ConnectionInfo[]): ConnectorStatus => ({
    uid: 'anon',
    pairedAt: connections.at(-1)?.pairedAt ?? null,
    approvedOn: 'Mac',
    writes: true,
    connections,
    pairingCid: connections.at(-1)?.cid ?? null,
  })
  async function showList(connections: ConnectionInfo[]) {
    sync.store.setState({ auth: 'signedIn', user: { uid: 'owner', name: '', email: 'o@example.com' } })
    renderSettings()
    await waitFor(() => expect(conn.watchConnector).toHaveBeenCalledTimes(1))
    act(() => conn.emit?.({ state: 'paired', status: paired(connections) }))
    return screen.getAllByTestId('claude-connection')
  }

  it('接続の一覧: 名前・許可した日時・許可した端末。名前を変える（同じ名前は断る）', async () => {
    const user = userEvent.setup()
    const rows = await showList([entry('c0', '接続1', 10), entry('cabc', '接続2', 11, 'iPhone')])
    expect(screen.getByTestId('claude-connection-count').textContent).toContain('接続 2 / 10')
    expect(rows.map((r) => r.getAttribute('data-cid'))).toEqual(['c0', 'cabc'])
    expect(rows[1].textContent).toContain('許可した日時 2026/11/11 14:32 ・ 許可した端末 iPhone')

    await user.click(within(rows[1]).getByTestId('claude-connection-rename'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('接続の名前を変える')
    expect(dialog.textContent).toContain('名前（20字まで。どの claude.ai のアカウントか分かる名前に）')
    const input = within(dialog).getByTestId('prompt-input') as HTMLInputElement
    expect(input.value).toBe('接続2')
    expect(input.maxLength).toBe(20)
    await user.clear(input)
    await user.type(input, '接続１')
    expect(within(dialog).getByTestId('prompt-problem').textContent).toBe('同じ名前の接続があります')
    expect((within(dialog).getByTestId('prompt-ok') as HTMLButtonElement).disabled).toBe(true)
    await user.clear(input)
    await user.type(input, ' 仕事用 ')
    await user.click(within(dialog).getByTestId('prompt-ok'))
    await waitFor(() => expect(conn.renameConnection).toHaveBeenCalledWith('cabc', '仕事用'))
    expect(await screen.findByText('接続の名前を「仕事用」にしました')).toBeTruthy()
  })

  it('1つ解除する: 確かめてから、その接続だけを一覧から外す。最後の1つは「連携をすべて解除」と同じ', async () => {
    const user = userEvent.setup()
    const rows = await showList([entry('c0', '接続1', 10), entry('cabc', '接続2', 11)])
    await user.click(within(rows[1]).getByTestId('claude-connection-remove'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「接続2」の接続を解除しますか？')
    expect(dialog.textContent).toContain(
      'この接続の Claude は、次に使った時から（遅くとも1分ほどで）読めず、書き込めなくなります。ほかの接続はそのまま使えます。その claude.ai のアカウントでまた使う時は、claude.ai でコネクタを接続し直してください（新しい接続として足されます）。',
    )
    await user.click(within(dialog).getByRole('button', { name: 'この接続を解除' }))
    await waitFor(() => expect(conn.removeConnection).toHaveBeenCalledWith('cabc'))
    expect(conn.deleteConnector).not.toHaveBeenCalled()
    expect(await screen.findByText('「接続2」の接続を解除しました')).toBeTruthy()

    // 最後の1つ
    act(() => conn.emit?.({ state: 'paired', status: paired([entry('c0', '接続1', 10)]) }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByTestId('claude-connection-remove'))
    dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('最後の接続です。連携をすべて解除しますか？')
    expect(dialog.textContent).toContain('すべての接続（1件）')
    await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
    await waitFor(() => expect(conn.deleteConnector).toHaveBeenCalledTimes(1))
    expect(conn.removeConnection).toHaveBeenCalledTimes(1)
  })

  it('連携をすべて解除: すべての接続の数を出して確かめる。やめれば何もしない', async () => {
    const user = userEvent.setup()
    await showList([entry('c0', '接続1', 10), entry('cabc', '接続2', 11), entry('cdef', '仕事用', 12)])
    await user.click(screen.getByTestId('claude-unpair'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(
      'すべての接続（3件）が、その場で何も読めず、書き込めなくなります。Claude で使うには、claude.ai でコネクタを接続し直して、もう一度許可してください（claude.ai 側のコネクタも削除しておくと確実です）。',
    )
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(conn.deleteConnector).not.toHaveBeenCalled()
  })
})
