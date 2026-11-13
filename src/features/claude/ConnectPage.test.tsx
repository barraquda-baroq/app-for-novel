// 連携の画面（#/claude/connect）: 持ち主の確かめ、同期を待つ、コネクタの場所の固定、k は指紋だけを Firestore に書く
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import { createPersistence } from '../../db/persistence'
import { actions } from '../../store/actions'
import { getData, getPersistence, initStore, resetStoreForTests } from '../../store/appStore'
import { AppFrame } from '../../ui/Layout'
import type { ConnectionApproval, ConnectorStatus } from './connectLogic'

const ORIGIN = 'https://conn.example.workers.dev'

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface FakeSync {
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: { uid: string; name: string; email: string } | null
  status: { phase: string; pending: number; outdated?: { model: number } | null } | null
  accountMismatch: null
  busy: boolean
  error: string | null
}

const sync = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<FakeSync>> }))
const doc = vi.hoisted(() => ({
  owner: 'owner-uid' as string | null,
  /** いまの連携の記録（null = 無い） */
  existing: null as ConnectorStatus | null,
  written: [] as unknown[],
  readOwnerUid: vi.fn(),
  readConnectorDoc: vi.fn(),
  addConnection: vi.fn(),
  deleteConnector: vi.fn(),
  removeConnection: vi.fn(),
}))
const leave = vi.hoisted(() => ({ leaveTo: vi.fn() }))
/** 仮のクラウド: 「いますぐ同期」で端末内の送信待ちを受け取る（online が false なら受け取らない） */
const cloud = vi.hoisted(() => ({ online: true, uploads: 0 }))

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
    syncNow: vi.fn(async () => {
      if (!cloud.online) return
      const { getPersistence } = await import('../../store/appStore')
      const p = getPersistence()
      if (!p) return
      const items = await p.readOutbox(100_000)
      cloud.uploads += items.length
      await p.completeUpload(items.map((i) => ({ table: i.table, id: i.id, record: i.local })))
    }),
  }
})
vi.mock('../../sync/appModel', () => ({ DATA_MODEL: 3 }))
vi.mock('./connectorDoc', () => ({
  readOwnerUid: doc.readOwnerUid,
  readConnectorDoc: doc.readConnectorDoc,
  addConnection: doc.addConnection,
  deleteConnector: doc.deleteConnector,
  removeConnection: doc.removeConnection,
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
  doc.existing = null
  cloud.online = true
  cloud.uploads = 0
  doc.written = []
  for (const f of [doc.readOwnerUid, doc.readConnectorDoc, doc.addConnection, doc.deleteConnector, doc.removeConnection])
    f.mockReset()
  doc.readOwnerUid.mockImplementation(async () => doc.owner)
  doc.readConnectorDoc.mockImplementation(async () => doc.existing)
  doc.addConnection.mockImplementation(async (d: ConnectionApproval) => {
    doc.written.push(d)
  })
  doc.deleteConnector.mockImplementation(async () => undefined)
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
    // 書き込みの許可の説明（2.8: アイデアを足す・Claude が足したアイデアに追記する・アイデアもゴミ箱へ移せる）
    expect(form.querySelector('.cn-writes-hint')?.textContent).toBe(
      '（Claude が推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果・相対比較の分析・資料の記録・アイデアを足せ、Claude が足したアイデアに追記できます。頼んだ時だけ、Claude が足した相対比較の分析・資料の記録・アイデアをゴミ箱へ移せます（30日は戻せます）。本文は書き換えません。後から 設定 → Claude 連携 で止められます）',
    )

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
        cid: expect.stringMatching(/^c[0-9a-z]{12}$/),
        name: '接続1',
        replaceCid: null,
      },
    ])
    expect(JSON.stringify(doc.written)).not.toContain(k)
    expect(getData().titles[a].claudeAccess).toBe('read')
    expect(getData().titles[b].claudeAccess).toBe('none')
    // 変えたタイトルの設定は、連携を記録する前にクラウドに届いている
    expect(cloud.uploads).toBeGreaterThan(0)
    expect(await getPersistence()!.outboxCount()).toBe(0)
    expect(screen.getByTestId('connect-done')).toBeTruthy()
  })

  it('記録に失敗しても、選んだ内容（書き込みを許可しない）はそのまま。やり直すと writes: false・同じ接続の id で記録する', async () => {
    const user = userEvent.setup()
    actions.createTitle('見せる作品')
    doc.addConnection.mockImplementationOnce(async (d: ConnectionApproval) => {
      doc.written.push({ failed: d.cid })
      throw Object.assign(new Error('x'), { code: 'unavailable' })
    })
    renderPage()
    const form = await screen.findByTestId('connect-form')
    await user.click(within(form).getByTestId('connect-access-read'))
    await user.click(within(form).getByTestId('connect-writes'))
    expect((within(form).getByTestId('connect-writes') as HTMLInputElement).checked).toBe(false)
    await user.click(within(form).getByTestId('connect-approve'))
    await screen.findByTestId('connect-error')
    expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('connect-access-read').getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByTestId('connect-approve'))
    await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
    expect(doc.written).toHaveLength(2)
    const [failed, ok] = doc.written as [{ failed: string }, ConnectionApproval]
    expect(ok.writes).toBe(false)
    expect(ok.cid).toBe(failed.failed)
  })

  it('新しい版のアプリのデータがあって送れない間は、許可できない（何も書かない）', async () => {
    actions.createTitle('見せる作品')
    sync.store.setState({ status: { phase: 'synced', pending: 0, outdated: { model: 4 } } })
    renderPage()
    const form = await screen.findByTestId('connect-form')
    expect(within(form).getByTestId('connect-outdated')).toBeTruthy()
    expect((within(form).getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
    expect(doc.addConnection).not.toHaveBeenCalled()
  })

  it('持ち主でなければ問い合わせも記録もしない', async () => {
    doc.owner = 'someone-else'
    renderPage()
    await screen.findByTestId('connect-not-owner')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(doc.readConnectorDoc).not.toHaveBeenCalled()
    expect(doc.addConnection).not.toHaveBeenCalled()
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

    // コネクタがアプリより新しい版: 許可はできる（書き込めないことを知らせる）
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uid: 'anon-uid', model: 4 }), { status: 200 }))
    renderPage()
    const form = await screen.findByTestId('connect-form')
    expect(within(form).getByTestId('connect-model-warning').textContent).toContain('（4）')
    await user.click(within(form).getByTestId('connect-cancel'))
    expect(screen.getByTestId('connect-cancelled')).toBeTruthy()
    expect(doc.addConnection).not.toHaveBeenCalled()
    expect(leave.leaveTo).not.toHaveBeenCalled()
  })

  it('コネクタがアプリより古い版なら、許可させない（ほかの接続を切ってしまうため）', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ uid: 'anon-uid', version: '2.8.0', model: 2 }), { status: 200 }),
    )
    renderPage()
    const old = await screen.findByTestId('connect-connector-old')
    expect(old.textContent).toBe(
      'コネクタがまだこのアプリの版になっていません（いまのコネクタは 2.8.0・データの形 2）。このまま許可すると、ほかの接続が切れてしまうため許可できません。コネクタを更新してから（npm run deploy。docs/DEPLOY.md）、claude.ai でもう一度「接続」を押してください。',
    )
    expect(screen.queryByTestId('connect-approve')).toBeNull()
    expect(doc.readConnectorDoc).not.toHaveBeenCalled()
    expect(doc.addConnection).not.toHaveBeenCalled()
  })
})
