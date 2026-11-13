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
        defaultName: true,
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

  describe('連携の画面: この接続（2.9。複数の接続）', () => {
    const min = 60_000
    const entry = (cid: string, name: string, agoMin: number) => ({
      cid,
      name,
      pairing: `p-${cid}`,
      pairedAt: Date.now() - agoMin * min,
      approvedOn: 'Mac',
    })
    const status = (connections: ReturnType<typeof entry>[], over: Partial<ConnectorStatus> = {}): ConnectorStatus => ({
      uid: 'anon-uid',
      pairedAt: connections.at(-1)?.pairedAt ?? null,
      approvedOn: 'Mac',
      writes: true,
      connections,
      pairingCid: connections.at(-1)?.cid ?? null,
      ...over,
    })

    it('初めての接続: 0 / 10・既定の名前は「接続1」・前の接続の選択は出ない', async () => {
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-connection-count').textContent).toBe('0 / 10')
      expect(section.textContent).toContain('Novel Studio には、claude.ai のアカウントを10まで同時に接続できます。')
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      expect(within(section).queryByTestId('connect-mode-add')).toBeNull()
      expect(within(section).queryByTestId('connect-connections')).toBeNull()
      // 記録が無ければ書き込みは許可
      expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(true)
      expect(screen.getByTestId('connect-writes').parentElement?.textContent).toContain(
        '推敲案などの書き込みも許可（すべての接続に効きます）',
      )
    })

    it('2.8 の記録（接続1）の横に足す: 既定の名前は「接続2」。前の接続は切れないことを知らせる', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 60 * 24)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-connection-count').textContent).toBe('1 / 10')
      expect(within(section).getByTestId('connect-connection-lead').textContent).toBe(
        'いまの接続は 1件です。新しく足しても、前の接続は切れません（claude.ai のどのアカウントかは、アプリからは分かりません。同じアカウントで接続し直した時も、新しい接続として足されます）。',
      )
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      expect((within(section).getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      // 1日前の許可は「15分以内」ではない
      expect(within(section).queryByTestId('connect-recent')).toBeNull()
      const list = within(section).getAllByTestId('connect-connection-row')
      expect(list.map((r) => within(r).getByTestId('connect-connection-name').textContent)).toEqual(['接続1'])
      expect(within(section).queryByTestId('connect-connection-rename')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    it('入れ替える: 名前は入れ替える接続の名前（書き直すまで）。入れ替える接続を渡す', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600), entry('cabc', '仕事用', 300)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      await user.click(within(section).getByTestId('connect-mode-replace'))
      const name = within(section).getByTestId('connect-name') as HTMLInputElement
      // 15分以内の許可が無ければ、一番前の接続
      expect((within(section).getByTestId('connect-replace-target') as HTMLSelectElement).value).toBe('c0')
      expect(name.value).toBe('接続1')
      await user.selectOptions(within(section).getByTestId('connect-replace-target'), 'cabc')
      expect(name.value).toBe('仕事用')
      // 入れ替える接続と同じ名前はよいが、ほかの接続と同じ名前は断る
      await user.clear(name)
      await user.type(name, '接続１')
      expect(within(section).getByTestId('connect-name-problem').textContent).toBe('同じ名前の接続があります')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      await user.clear(name)
      expect(within(section).getByTestId('connect-name-problem').textContent).toBe('名前を入れてください')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      await user.type(name, '新しい Mac')
      expect(within(section).queryByTestId('connect-name-problem')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '新しい Mac', replaceCid: 'cabc' })])
    })

    it('同じ名前の接続があれば許可できない（字の幅・空白の違いも同じ）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600)])
      renderPage()
      const name = (await screen.findByTestId('connect-name')) as HTMLInputElement
      await user.clear(name)
      await user.type(name, ' 接続１')
      expect(screen.getByTestId('connect-name-problem').textContent).toBe('同じ名前の接続があります')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      expect(name.getAttribute('aria-invalid')).toBe('true')
    })

    it('15分以内に許可した接続があれば入れ替えを勧め、入れ替える先の既定にする', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600), entry('cnew', '接続3', 5)])
      renderPage()
      const recent = await screen.findByTestId('connect-recent')
      expect(recent.textContent).toBe(
        '15分以内に許可した「接続3」があります。claude.ai で接続できずにやり直している時は「接続3と入れ替える」を選ぶと、使わない接続が一覧に残りません。',
      )
      await user.click(screen.getByTestId('connect-mode-replace'))
      expect((screen.getByTestId('connect-replace-target') as HTMLSelectElement).value).toBe('cnew')
      // その接続と入れ替える時は勧めない
      expect(screen.queryByTestId('connect-recent')).toBeNull()
    })

    const tenEntries = () => Array.from({ length: 10 }, (_, i) => entry(`c${i + 1}`, `接続${i + 1}`, 1000 - i))

    it('接続が10ある時: 足すことはできず入れ替えになる（15分以内の許可が無ければ、選ぶまで許可できない）。一覧が開き、1つ解除すると足せる', async () => {
      const user = userEvent.setup()
      const ten = Array.from({ length: 10 }, (_, i) => entry(`c${i + 1}`, `接続${i + 1}`, 1000 - i))
      doc.existing = status(ten)
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      expect(within(section).getByTestId('connect-full').textContent).toBe(
        '接続が10あります（同時に10まで）。入れ替える接続を選ぶか、下の一覧で1つ解除すると許可できます。',
      )
      expect((within(section).getByTestId('connect-mode-add') as HTMLInputElement).disabled).toBe(true)
      expect((within(section).getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(true)
      expect(section.querySelector('details')?.open).toBe(true)
      // 入れ替える先は決めていない（一番前の接続を勝手に選ばない）
      const select = within(section).getByTestId('connect-replace-target') as HTMLSelectElement
      expect(select.value).toBe('')
      expect(select.selectedOptions[0].textContent).toBe('選んでください')
      expect(within(section).getByTestId('connect-mode-replace').getAttribute('aria-label')).toBe(
        '選んだ接続と入れ替える（前の接続は使えなくなります）',
      )
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      // 一覧で1つ解除する（読み直すまで［許可する］は待つ）
      let resolveRead: (s: ConnectorStatus) => void = () => undefined
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.readConnectorDoc.mockImplementation(() => new Promise<ConnectorStatus>((r) => (resolveRead = r)))
      const rows = within(section).getAllByTestId('connect-connection-row')
      await user.click(within(rows[3]).getByTestId('connect-connection-remove'))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('「接続4」の接続を解除しますか？')
      await user.click(within(dialog).getByRole('button', { name: 'この接続を解除' }))
      await waitFor(() => expect(doc.removeConnection).toHaveBeenCalledWith('c4'))
      await screen.findByTestId('connect-connections-loading')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      act(() => resolveRead(status(ten.filter((c) => c.cid !== 'c4'))))
      await waitFor(() => expect(screen.queryByTestId('connect-full')).toBeNull())
      expect(screen.getByTestId('connect-connection-count').textContent).toBe('9 / 10')
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続4')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続4', replaceCid: null })])
    })

    it('接続が10ある時: 入れ替える接続を選ぶと許可できる（名前はその接続の名前）', async () => {
      const user = userEvent.setup()
      doc.existing = status(tenEntries())
      renderPage()
      const select = (await screen.findByTestId('connect-replace-target')) as HTMLSelectElement
      await user.selectOptions(select, 'c7')
      expect(select.value).toBe('c7')
      // 選んだ後は「選んでください」を出さない
      expect([...select.options].map((o) => o.value)).not.toContain('')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続7')
      expect(screen.getByTestId('connect-mode-replace').getAttribute('aria-label')).toBe(
        '「接続7」と入れ替える（前の接続は使えなくなります）',
      )
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続7', replaceCid: 'c7', defaultName: true })])
    })

    it('接続が10ある時: 15分以内に許可した接続があれば、それを入れ替える先にしておき、なぜかを知らせる', async () => {
      const user = userEvent.setup()
      doc.existing = status([...tenEntries().slice(0, 9), entry('c10', '接続10', 3)])
      renderPage()
      const select = (await screen.findByTestId('connect-replace-target')) as HTMLSelectElement
      expect(select.value).toBe('c10')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続10')
      expect(screen.getByTestId('connect-recent').textContent).toContain('15分以内に許可した「接続10」があります。')
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(false)
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続10', replaceCid: 'c10' })])
    })

    it('接続が10ある時: 入れ替える接続を選んでから、その接続を一覧で解除すると、足すに戻る（ほかの接続と入れ替えない）', async () => {
      const user = userEvent.setup()
      doc.existing = status(tenEntries())
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      await user.selectOptions(within(section).getByTestId('connect-replace-target'), 'c4')
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('接続4')
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.existing = status(tenEntries().filter((c) => c.cid !== 'c4'))
      const row = within(section)
        .getAllByTestId('connect-connection-row')
        .find((r) => r.getAttribute('data-cid') === 'c4')!
      await user.click(within(row).getByTestId('connect-connection-remove'))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'この接続を解除' }))
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('9 / 10'))
      expect(doc.removeConnection).toHaveBeenCalledWith('c4')
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(false)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続4')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続4', replaceCid: null })])
    })

    it('10ない時: 入れ替える接続を選んでから、その接続を一覧で解除すると、足すに戻る（一番前の接続と入れ替えない）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600), entry('cb', '仕事用', 300), entry('cc', '個人', 200)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      await user.click(within(section).getByTestId('connect-mode-replace'))
      await user.selectOptions(within(section).getByTestId('connect-replace-target'), 'cb')
      expect((within(section).getByTestId('connect-name') as HTMLInputElement).value).toBe('仕事用')
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.existing = status([entry('c0', '接続1', 600), entry('cc', '個人', 200)])
      await user.click(within(section).getByText(/いまの接続/, { selector: 'summary' }))
      const row = within(section)
        .getAllByTestId('connect-connection-row')
        .find((r) => r.getAttribute('data-cid') === 'cb')!
      await user.click(within(row).getByTestId('connect-connection-remove'))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'この接続を解除' }))
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('2 / 10'))
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    it('記録に失敗して読み直した一覧に、選んだ入れ替える先が無ければ（10ない）、足すに戻る（一番前の接続と入れ替えない）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600), entry('cb', '仕事用', 300), entry('cc', '個人', 200)])
      renderPage()
      await user.click(await screen.findByTestId('connect-mode-replace'))
      await user.selectOptions(screen.getByTestId('connect-replace-target'), 'cb')
      // ほかの端末で cb が解除された
      doc.existing = status([entry('c0', '接続1', 600), entry('cc', '個人', 200)])
      doc.addConnection.mockImplementationOnce(async () => {
        throw Object.assign(new Error('x'), { code: 'unavailable' })
      })
      await user.click(screen.getByTestId('connect-approve'))
      await screen.findByTestId('connect-error')
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('2 / 10'))
      expect((screen.getByTestId('connect-mode-add') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続2')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続2', replaceCid: null })])
    })

    it('記録に失敗して読み直した一覧に、選んだ入れ替える先が無ければ（10のまま）、ほかの接続に移さず選び直すまで許可できない', async () => {
      const user = userEvent.setup()
      const { ConnectionLimitError } = await import('./connectLogic')
      doc.existing = status(tenEntries())
      renderPage()
      await user.selectOptions(await screen.findByTestId('connect-replace-target'), 'c4')
      // ほかの端末で c4 が解除され、別の接続（3分前）が足された
      doc.existing = status([...tenEntries().filter((c) => c.cid !== 'c4'), entry('c11', '接続11', 3)])
      doc.addConnection.mockImplementationOnce(async () => {
        throw new ConnectionLimitError()
      })
      await user.click(screen.getByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toContain('接続が10あります（同時に10まで）')
      await waitFor(() => expect(screen.queryByTestId('connect-connections-loading')).toBeNull())
      expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2)
      const select = screen.getByTestId('connect-replace-target') as HTMLSelectElement
      expect(select.value).toBe('')
      expect((screen.getByTestId('connect-mode-replace') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      await user.selectOptions(select, 'c5')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続5', replaceCid: 'c5' })])
    })

    it('画面で見ている一覧が1つでも、［この接続を解除］はその接続だけを外す（ほかの端末で足された接続は残る）', async () => {
      const user = userEvent.setup()
      doc.existing = status([entry('c0', '接続1', 600)])
      renderPage()
      const section = await screen.findByTestId('connect-connection')
      // その間にほかの端末で「接続2」が足された（サーバーの一覧は2つ）
      doc.removeConnection.mockImplementation(async () => 'removed')
      doc.existing = status([entry('cx', '接続2', 3)])
      await user.click(within(section).getByText(/いまの接続/, { selector: 'summary' }))
      await user.click(within(section).getByTestId('connect-connection-remove'))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('最後の接続です。連携をすべて解除しますか？')
      await user.click(within(dialog).getByRole('button', { name: '連携をすべて解除' }))
      await waitFor(() => expect(doc.removeConnection).toHaveBeenCalledWith('c0'))
      expect(doc.deleteConnector).not.toHaveBeenCalled()
      expect(
        await screen.findByText('「接続1」の接続を解除しました（ほかの端末で足された接続は、そのまま使えます）'),
      ).toBeTruthy()
      await waitFor(() => expect(screen.getByTestId('connect-connection-count').textContent).toBe('1 / 10'))
      expect(screen.getAllByTestId('connect-connection-name').map((e) => e.textContent)).toEqual(['接続2'])
    })

    it('いまの一覧を読めなかった時: 既定の名前「接続1」は、記録に「接続1」があればトランザクションで「接続2」になる', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc } = await import('./connectLogic')
      // 2.8 の記録（c0「接続1」）がある
      const v1 = { uid: 'anon-uid', pairing: 'h-old', pairedAt: 1, approvedOn: 'iPad', writes: true, v: 1 }
      let saved: Record<string, unknown> | null = null
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        doc.written.push(a)
        saved = addedConnectorDoc(v1, a, 'SERVER')
      })
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      renderPage()
      await screen.findByTestId('connect-connections-error')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続1', defaultName: true })])
      const cid = (doc.written[0] as ConnectionApproval).cid
      expect(saved!.connections).toEqual({
        c0: expect.objectContaining({ name: '接続1', pairing: 'h-old' }),
        [cid]: expect.objectContaining({ name: '接続2' }),
      })
    })

    it('作者が入れた名前と同じ名前の接続が、ほかの端末で足されていたら、知らせて一覧を読み直す（何も書かない）', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc, DUPLICATE_NAME_ERROR } = await import('./connectLogic')
      doc.existing = status([entry('c0', '接続1', 600)])
      // サーバーの記録には、もう「仕事用」がある
      const server = {
        uid: 'anon-uid',
        v: 2,
        pairing: 'p-cx',
        pairedAt: 2,
        approvedOn: 'Mac',
        writes: true,
        pairingCid: 'cx',
        connections: {
          c0: { name: '接続1', pairing: 'p-c0', pairedAt: 1, approvedOn: 'Mac' },
          cx: { name: '仕事用', pairing: 'p-cx', pairedAt: 2, approvedOn: 'Mac' },
        },
      }
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        addedConnectorDoc(server, a, 'SERVER')
        doc.written.push(a)
      })
      renderPage()
      const name = (await screen.findByTestId('connect-name')) as HTMLInputElement
      await user.clear(name)
      await user.type(name, '仕事用')
      expect(screen.queryByTestId('connect-name-problem')).toBeNull()
      doc.existing = status([entry('c0', '接続1', 600), entry('cx', '仕事用', 3)])
      await user.click(screen.getByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toBe(DUPLICATE_NAME_ERROR)
      await waitFor(() => expect(screen.getByTestId('connect-name-problem').textContent).toBe('同じ名前の接続があります'))
      expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2)
      expect((screen.getByTestId('connect-approve') as HTMLButtonElement).disabled).toBe(true)
      expect(doc.written).toEqual([])
      expect(leave.leaveTo).not.toHaveBeenCalled()
    })

    it('いまの一覧を読めなかった時: 「書き込みを許可」は分からないと出し、触らなければ送らない（記録の値のまま）', async () => {
      const user = userEvent.setup()
      const { addedConnectorDoc } = await import('./connectLogic')
      // 記録では書き込みを止めている
      const server = { uid: 'anon-uid', pairing: 'h-old', pairedAt: 1, approvedOn: 'iPad', writes: false, v: 1 }
      const saved: Record<string, unknown>[] = []
      doc.addConnection.mockImplementation(async (a: ConnectionApproval) => {
        doc.written.push(a)
        saved.push(addedConnectorDoc(server, a, 'SERVER'))
      })
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      const first = renderPage()
      await screen.findByTestId('connect-connections-error')
      const box = screen.getByTestId('connect-writes') as HTMLInputElement
      expect(box.checked).toBe(false)
      expect(box.indeterminate).toBe(true)
      expect(screen.getByTestId('connect-writes-unknown').textContent).toBe(
        '（いまの設定を読めませんでした。変えなければ、いまの設定のままです）',
      )
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect((doc.written[0] as ConnectionApproval).writes).toBeNull()
      expect(saved[0].writes).toBe(false)
      first.unmount()

      // 触ればその値（すべての接続に効く）
      renderPage()
      await screen.findByTestId('connect-connections-error')
      await user.click(screen.getByTestId('connect-writes'))
      const box2 = screen.getByTestId('connect-writes') as HTMLInputElement
      expect(box2.checked).toBe(true)
      expect(box2.indeterminate).toBe(false)
      expect(screen.queryByTestId('connect-writes-unknown')).toBeNull()
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(2))
      expect((doc.written[1] as ConnectionApproval).writes).toBe(true)
      expect(saved[1].writes).toBe(true)
    })

    it('書き込みの既定は、いまの「書き込みを許可」', async () => {
      doc.existing = status([entry('c0', '接続1', 600)], { writes: false })
      renderPage()
      expect(((await screen.findByTestId('connect-writes')) as HTMLInputElement).checked).toBe(false)
    })

    it('コネクタが用意し直された時は、前の接続は数えずに新しく始める（知らせる）', async () => {
      doc.existing = status([entry('c0', '接続1', 600), entry('cabc', '接続2', 300)], { uid: 'old-anon', writes: false })
      renderPage()
      const notice = await screen.findByTestId('connect-identity-changed')
      expect(notice.textContent).toBe(
        'コネクタが用意し直されたため、前の接続（2件）は使えなくなっています。この許可で連携を新しく始めます。',
      )
      expect(screen.getByTestId('connect-connection-count').textContent).toBe('0 / 10')
      expect((screen.getByTestId('connect-name') as HTMLInputElement).value).toBe('接続1')
      expect((screen.getByTestId('connect-writes') as HTMLInputElement).checked).toBe(true)
      expect(screen.queryByTestId('connect-connections')).toBeNull()
    })

    it('いまの接続の一覧を読めなくても許可はできる', async () => {
      const user = userEvent.setup()
      doc.readConnectorDoc.mockImplementation(async () => Promise.reject(new Error('offline')))
      renderPage()
      expect((await screen.findByTestId('connect-connections-error')).textContent).toBe(
        'いまの接続の一覧を読めませんでした（許可はできます）',
      )
      await user.click(screen.getByTestId('connect-approve'))
      await waitFor(() => expect(leave.leaveTo).toHaveBeenCalledTimes(1))
      expect(doc.written).toEqual([expect.objectContaining({ name: '接続1' })])
    })

    it('接続が10の時の記録の失敗（ほかの端末で足された）を知らせ、一覧を読み直す', async () => {
      const user = userEvent.setup()
      const { ConnectionLimitError } = await import('./connectLogic')
      doc.addConnection.mockImplementationOnce(async () => {
        throw new ConnectionLimitError()
      })
      renderPage()
      await user.click(await screen.findByTestId('connect-approve'))
      expect((await screen.findByTestId('connect-error')).textContent).toContain('接続が10あります（同時に10まで）')
      await waitFor(() => expect(doc.readConnectorDoc).toHaveBeenCalledTimes(2))
      expect(leave.leaveTo).not.toHaveBeenCalled()
    })
  })
})
