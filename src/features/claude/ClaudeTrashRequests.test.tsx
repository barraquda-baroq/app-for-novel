// Claude の「ゴミ箱へ移す依頼」（2.7）の処理（ClaudeTrashRequests）と、ゴミ箱の画面の「Claude の依頼」の札。
// 依頼はクラウドから届くので、同期を受け持つ画面がクラウドと揃った時だけ、下書きの無い時・分析や記録を直すダイアログを
// 開いていない時だけ処理する。
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trashRequestId } from '../../claude/derivedId'
import { buildTrashRequests } from '../../claude/trashRequest'
import { createPersistence } from '../../db/persistence'
import type { AppData, BenchAnalysis, MaterialNote, TrashRequest } from '../../domain/types'
import { actions } from '../../store/actions'
import { commit, getData, initStore, resetStoreForTests, useApp } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { resetSyncForTests, useSync } from '../../sync/controller'
import { AppFrame } from '../../ui/Layout'
import { AnalysisDialog } from '../bench/AnalysisDialog'
import { MaterialNoteDialog } from '../materials/MaterialNoteDialog'
import { TrashPage } from '../trash/TrashPage'
import { ClaudeTrashRequests } from './ClaudeTrashRequests'

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-claude-trash-${++n}`))
  useToasts.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetSyncForTests()
})

const SYNCED = { phase: 'synced' as const, pending: 0, lastSyncedAt: 1, error: null }

/** 作品に Claude の分析が2つある（「構成」cn-a1・「文体」cn-a2） */
function seedCards(): { workId: string } {
  const workId = actions.addBenchWork({ name: '銀河の果て', author: '山田' })
  const card = (id: string, viewpoint: string): BenchAnalysis => ({
    id,
    workId,
    viewpoint,
    body: `${viewpoint}の分析。`,
    runDate: '2026-10-30',
    source: 'claude',
    v: 1,
    createdAt: 100,
    updatedAt: 100,
  })
  const data: AppData = getData()
  commit({ ...data, benchAnalyses: { ...data.benchAnalyses, 'cn-a1': card('cn-a1', '構成'), 'cn-a2': card('cn-a2', '文体') } })
  return { workId }
}

/** コネクタがカードに依頼を作って、同期で届いた */
function requestTrash(cardId: string): string {
  const data = getData()
  const built = buildTrashRequests(
    data,
    { cards: [cardId] },
    { now: Date.now(), trash: {}, wasDeleted: () => false, dailyLeft: 100 },
  )
  const req = built.records[0].record as TrashRequest
  commit({ ...data, trashRequests: { ...data.trashRequests, [req.id]: req } })
  return req.id
}

/** 作品に Claude の分析が2つあり、コネクタが1つ（「構成」）に依頼を作って、同期で届いた */
function seed(): { workId: string; analysisId: string; requestId: string } {
  const { workId } = seedCards()
  return { workId, analysisId: 'cn-a1', requestId: requestTrash('cn-a1') }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ClaudeTrashRequests', () => {
  it('同期を受け持つ画面がクラウドと揃った時に、カードをゴミ箱へ移してトーストで知らせる（それまでは移さない）', async () => {
    const s = seed()
    render(<ClaudeTrashRequests />)
    await wait(1500)
    expect(getData().benchAnalyses[s.analysisId]).toBeDefined()
    useSync.setState({ auth: 'signedIn', leader: true, status: { ...SYNCED, phase: 'downloading' } })
    await wait(1500)
    expect(getData().benchAnalyses[s.analysisId]).toBeDefined()
    useSync.setState({ status: SYNCED })
    await waitFor(() => expect(getData().benchAnalyses[s.analysisId]).toBeUndefined(), { timeout: 4000 })
    expect(getData().benchAnalyses['cn-a2']).toBeDefined()
    expect(getData().trashRequests).toEqual({})
    expect(getData().trashEntries[`te-${trashRequestId('benchAnalyses', s.analysisId)}`]?.by).toBe('claude')
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      'Claude の依頼で、相対比較の分析1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）',
    ])
  }, 12_000)

  it('受け持ちでない画面・新しい版のアプリのデータがある時・下書きのある間は処理しない', async () => {
    const s = seed()
    useSync.setState({ auth: 'signedIn', leader: false, status: SYNCED })
    render(<ClaudeTrashRequests />)
    await wait(1500)
    expect(getData().trashRequests[s.requestId]).toBeDefined()
    useSync.setState({ leader: true, status: { ...SYNCED, outdated: { model: 99, appVersion: '9.0' } } })
    await wait(1500)
    expect(getData().trashRequests[s.requestId]).toBeDefined()
    useApp.setState({ draftsDirty: true })
    useSync.setState({ status: SYNCED })
    await wait(1500)
    expect(getData().benchAnalyses[s.analysisId]).toBeDefined()
    useApp.setState({ draftsDirty: false })
    await waitFor(() => expect(getData().benchAnalyses[s.analysisId]).toBeUndefined(), { timeout: 4000 })
  }, 12_000)

  it('作者が直したカードは移さず、依頼だけ消して知らせる', async () => {
    const s = seed()
    actions.updateBenchAnalysis(s.analysisId, { body: '作者が直した' })
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    render(<ClaudeTrashRequests />)
    await waitFor(() => expect(getData().trashRequests).toEqual({}), { timeout: 4000 })
    expect(getData().benchAnalyses[s.analysisId].body).toBe('作者が直した')
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      'Claude の依頼のうち1件は移しませんでした（作者が直したカード1件）',
    ])
  })
})

/** 作品の画面と同じく、開いた時のカードを持ってダイアログを出し、保存・キャンセルで閉じる */
function EditAnalysis({ id, isNew }: { id: string; isNew?: boolean }) {
  const [analysis] = useState(() => getData().benchAnalyses[id])
  const [open, setOpen] = useState(true)
  return open ? (
    <AnalysisDialog workId={analysis.workId} analysis={isNew ? null : analysis} onClose={() => setOpen(false)} />
  ) : null
}

function EditNote({ id }: { id: string }) {
  const [note] = useState(() => getData().materialNotes[id])
  const [open, setOpen] = useState(true)
  return open ? <MaterialNoteDialog materialId={note.materialId} note={note} onClose={() => setOpen(false)} /> : null
}

const toastMessages = () => useToasts.getState().toasts.map((t) => t.message)

describe('分析・記録を直すダイアログを開いている間', () => {
  it('分析を直している間に届いた依頼は当てず、保存すると作者が直したカードとして断る（下書きの印は立てない）', async () => {
    seedCards()
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    render(
      <>
        <ClaudeTrashRequests />
        <EditAnalysis id="cn-a1" />
      </>,
    )
    const input = screen.getByTestId('bench-analysis-input')
    await user.clear(input)
    await user.type(input, '作者が直した分析')
    const requestId = requestTrash('cn-a1')
    await wait(1500)
    expect(getData().benchAnalyses['cn-a1']).toBeDefined()
    expect(getData().trashRequests[requestId]).toBeDefined()
    // 入力欄の下書き（draftsDirty）とは別の印なので、ヘッダーの保存の表示・別のタブの読み込み直しは変わらない
    expect(useApp.getState().draftsDirty).toBe(false)
    await user.click(screen.getByTestId('bench-analysis-save'))
    await waitFor(() => expect(getData().trashRequests).toEqual({}), { timeout: 4000 })
    expect(getData().benchAnalyses['cn-a1'].body).toBe('作者が直した分析')
    expect(toastMessages()).toEqual(['分析を保存しました', 'Claude の依頼のうち1件は移しませんでした（作者が直したカード1件）'])
  }, 12_000)

  it('資料の記録を直している間も同じ（保存すると作者が直したカードとして断る）', async () => {
    const materialId = actions.addMaterial({ name: '星の図鑑', author: '佐藤' })
    const note: MaterialNote = {
      id: 'ck-m1',
      materialId,
      section: '要約',
      body: '要約の記録。',
      runDate: '2026-10-30',
      source: 'claude',
      v: 1,
      createdAt: 100,
      updatedAt: 100,
    }
    const data = getData()
    commit({ ...data, materialNotes: { ...data.materialNotes, [note.id]: note } })
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    render(
      <>
        <ClaudeTrashRequests />
        <EditNote id="ck-m1" />
      </>,
    )
    const input = screen.getByTestId('material-note-input')
    await user.clear(input)
    await user.type(input, '作者が直した記録')
    const requestId = requestTrash('ck-m1')
    await wait(1500)
    expect(getData().materialNotes['ck-m1']).toBeDefined()
    expect(getData().trashRequests[requestId]).toBeDefined()
    await user.click(screen.getByTestId('material-note-save'))
    await waitFor(() => expect(getData().trashRequests).toEqual({}), { timeout: 4000 })
    expect(getData().materialNotes['ck-m1'].body).toBe('作者が直した記録')
    expect(toastMessages()).toEqual(['記録を保存しました', 'Claude の依頼のうち1件は移しませんでした（作者が直したカード1件）'])
  }, 12_000)

  it('何も変えずに保存して閉じると、作者が直したカードにならないので依頼を当てる', async () => {
    seedCards()
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    render(
      <>
        <ClaudeTrashRequests />
        <EditAnalysis id="cn-a1" />
      </>,
    )
    requestTrash('cn-a1')
    await wait(1500)
    expect(getData().benchAnalyses['cn-a1']).toBeDefined()
    await user.click(screen.getByTestId('bench-analysis-save'))
    await waitFor(() => expect(getData().benchAnalyses['cn-a1']).toBeUndefined(), { timeout: 4000 })
    expect(getData().trashRequests).toEqual({})
    expect(toastMessages()).toEqual([
      '分析を保存しました',
      'Claude の依頼で、相対比較の分析1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）',
    ])
  }, 12_000)

  it('キャンセルで閉じると依頼を当てる。新しく足すダイアログは止めない', async () => {
    seedCards()
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    const view = render(
      <>
        <ClaudeTrashRequests />
        <EditAnalysis id="cn-a1" />
      </>,
    )
    requestTrash('cn-a1')
    await wait(1500)
    expect(getData().benchAnalyses['cn-a1']).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(getData().benchAnalyses['cn-a1']).toBeUndefined(), { timeout: 4000 })
    expect(getData().trashRequests).toEqual({})
    view.unmount()
    // 分析を足すダイアログ（直すカードが無い）を開いていても、ほかのカードの依頼は当てる
    render(
      <>
        <ClaudeTrashRequests />
        <EditAnalysis id="cn-a2" isNew />
      </>,
    )
    expect(screen.getByTestId('bench-analysis-dialog')).toBeDefined()
    requestTrash('cn-a2')
    await waitFor(() => expect(getData().benchAnalyses['cn-a2']).toBeUndefined(), { timeout: 4000 })
  }, 12_000)
})

describe('ゴミ箱の画面', () => {
  it('Claude の依頼で移したカードに「Claude の依頼」の札。作者が削除したものには出ない。元に戻せる', async () => {
    const s = seed()
    actions.applyClaudeRequests()
    actions.deleteBenchAnalysis('cn-a2')
    const router = createMemoryRouter(
      [
        {
          path: '/trash',
          element: (
            <AppFrame>
              <TrashPage />
            </AppFrame>
          ),
        },
      ],
      { initialEntries: ['/trash'] },
    )
    render(<RouterProvider router={router} />)
    const rows = await screen.findAllByTestId('trash-row')
    expect(rows).toHaveLength(2)
    const mine = rows.find((r) => within(r).getByTestId('trash-label').textContent === '構成（2026-10-30）')!
    const other = rows.find((r) => r !== mine)!
    const badge = within(mine).getByTestId('trash-by-claude')
    expect(badge.textContent).toBe('Claude の依頼')
    expect(badge.getAttribute('title')).toBe('Claude に頼んでゴミ箱へ移したカード')
    expect(within(other).queryByTestId('trash-by-claude')).toBeNull()
    within(mine).getByTestId('trash-restore').click()
    await waitFor(() => expect(getData().benchAnalyses[s.analysisId]).toBeDefined())
  })
})
