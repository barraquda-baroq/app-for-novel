// Claude の「ゴミ箱へ移す依頼」（2.7）の処理（ClaudeTrashRequests）と、ゴミ箱の画面の「Claude の依頼」の札。
// 依頼はクラウドから届くので、同期を受け持つ画面がクラウドと揃った時だけ、下書きの無い時だけ処理する。
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trashRequestId } from '../../claude/derivedId'
import { buildTrashRequests } from '../../claude/trashRequest'
import { createPersistence } from '../../db/persistence'
import type { AppData, BenchAnalysis, TrashRequest } from '../../domain/types'
import { actions } from '../../store/actions'
import { commit, getData, initStore, resetStoreForTests, useApp } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { resetSyncForTests, useSync } from '../../sync/controller'
import { AppFrame } from '../../ui/Layout'
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

/** 作品に Claude の分析が2つあり、コネクタが1つ（「構成」）に依頼を作って、同期で届いた */
function seed(): { workId: string; analysisId: string; requestId: string } {
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
  let data: AppData = getData()
  data = { ...data, benchAnalyses: { ...data.benchAnalyses, 'cn-a1': card('cn-a1', '構成'), 'cn-a2': card('cn-a2', '文体') } }
  const built = buildTrashRequests(
    data,
    { cards: ['cn-a1'] },
    { now: Date.now(), trash: {}, wasDeleted: () => false, dailyLeft: 100 },
  )
  const req = built.records[0].record as TrashRequest
  commit({ ...data, trashRequests: { [req.id]: req } })
  return { workId, analysisId: 'cn-a1', requestId: req.id }
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

describe('ゴミ箱の画面', () => {
  it('Claude の依頼で移したカードに「Claude の依頼」の札。作者が削除したものには出ない。元に戻せる', async () => {
    const s = seed()
    actions.applyClaudeTrashRequests()
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
