// Claude の依頼の処理（ClaudeRequests）: 2.7 の「ゴミ箱へ移す依頼」と 2.8 のアイデアへの追記の依頼、ゴミ箱の画面の「Claude の依頼」の札。
// 依頼はクラウドから届くので、同期を受け持つ画面がクラウドと揃った時だけ、下書きの無い時・分析や記録・Claude が作ったアイデアを
// 直すダイアログを開いていない時だけ処理する。アイデアの編集の画面は、開いている間に別の画面で足された追記を保存の時に残す。
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMemo, useState } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ideaAppendId, trashRequestId } from '../../claude/derivedId'
import { appendedBody, ideaEditedByAuthor, ideaReadMark } from '../../claude/ideaAppend'
import { buildTrashRequests } from '../../claude/trashRequest'
import { createPersistence } from '../../db/persistence'
import { applyClaudeRequests } from '../../domain/claudeRequests'
import { ideaSections } from '../../domain/entityOps'
import { hashJson } from '../../domain/hash'
import type { AppData, BenchAnalysis, Idea, IdeaAppend, MaterialNote, TrashRequest } from '../../domain/types'
import { actions } from '../../store/actions'
import { commit, getData, initStore, resetStoreForTests, useApp, useData } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { resetSyncForTests, useSync } from '../../sync/controller'
import { AppFrame } from '../../ui/Layout'
import { AnalysisDialog } from '../bench/AnalysisDialog'
import { IdeaSectionView } from '../ideas/IdeaSectionView'
import { MaterialNoteDialog } from '../materials/MaterialNoteDialog'
import { TrashPage } from '../trash/TrashPage'
import { ClaudeRequests } from './ClaudeRequests'

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

describe('ClaudeRequests（ゴミ箱へ移す依頼）', () => {
  it('同期を受け持つ画面がクラウドと揃った時に、カードをゴミ箱へ移してトーストで知らせる（それまでは移さない）', async () => {
    const s = seed()
    render(<ClaudeRequests />)
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
    render(<ClaudeRequests />)
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
    render(<ClaudeRequests />)
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
        <ClaudeRequests />
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
        <ClaudeRequests />
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
        <ClaudeRequests />
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
        <ClaudeRequests />
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
        <ClaudeRequests />
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

// ---------- 2.8: アイデアへの追記の依頼 ----------

/** Claude が作ったホームのアイデアの本文（1行目は作った日付と時刻と名前） */
const IDEA_BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
const IDEA_LABEL = '2026/11/12 14:32　第3章の動機'
/** 追記の依頼を作った時刻（2026/11/13 10:00 日本時間） */
const APPEND_AT = Date.UTC(2026, 10, 13, 1, 0, 0)
const APPEND_HEADER = '2026/11/13のセッションで以下の内容へ変更'

/** コネクタが作った Claude のアイデアが同期で届いた（ホームの済みでないものの先頭） */
function seedClaudeIdea(id = 'cy-home0001', body = IDEA_BODY): Idea {
  const idea: Idea = {
    id,
    titleId: null,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order: -1,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: 100,
    updatedAt: 100,
  }
  const data = getData()
  commit({ ...data, ideas: { ...data.ideas, [id]: idea } })
  return idea
}

/** コネクタがアイデアへの追記の依頼を作って、同期で届いた（Claude が読んだのは今の本文） */
function requestAppend(ideaId: string, text: string, at = APPEND_AT): string {
  const data = getData()
  const mark = ideaReadMark(data.ideas[ideaId].body)
  const req: IdeaAppend = {
    id: ideaAppendId(ideaId, mark, text),
    ideaId,
    text,
    readMark: mark,
    source: 'claude',
    v: 1,
    createdAt: at,
    updatedAt: at,
  }
  commit({ ...data, ideaAppends: { ...data.ideaAppends, [req.id]: req } })
  return req.id
}

/** ホームのアイデアの仕切り（ホームのアイデア領域と同じ部品。データが変わると描き直す） */
function HomeIdeas() {
  const data = useData()
  const section = useMemo(() => ideaSections(data).find((s) => s.titleId === null)!, [data])
  return <IdeaSectionView section={section} heading="ホームのアイデア" />
}

function renderIdeas(withProcessor = true) {
  return render(
    <MemoryRouter>
      <AppFrame>
        {withProcessor ? <ClaudeRequests /> : null}
        <HomeIdeas />
      </AppFrame>
    </MemoryRouter>,
  )
}

const ideaCard = (id: string) => document.querySelector<HTMLElement>(`[data-testid="idea-card"][data-idea-id="${id}"]`)!

describe('ClaudeRequests（アイデアへの追記の依頼）', () => {
  it('同期を受け持つ画面がクラウドと揃った時に、カードの終わりに追記してトーストで知らせる（並び・済みは変えない）', async () => {
    const idea = seedClaudeIdea()
    requestAppend(idea.id, '【変更】\n・兄ではなく姉を探す')
    render(<ClaudeRequests />)
    await wait(1500)
    expect(getData().ideas[idea.id].body).toBe(IDEA_BODY)
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    await waitFor(() => expect(getData().ideaAppends).toEqual({}), { timeout: 4000 })
    const after = getData().ideas[idea.id]
    expect(after.body).toBe(`${IDEA_BODY}\n\n${APPEND_HEADER}\n【変更】\n・兄ではなく姉を探す`)
    expect(after).toMatchObject({ order: -1, checked: false, checkedAt: null, titleId: null, heading: '' })
    expect(after.appendIds).toHaveLength(1)
    // Claude の追記は「作者が直した」に数えない
    expect(ideaEditedByAuthor(after)).toBe(false)
    expect(toastMessages()).toEqual([`Claude の依頼で、アイデア「${IDEA_LABEL}」の終わりに追記しました`])
  }, 12_000)

  it('受け持ちでない画面・新しい版のアプリのデータがある時・下書きのある間は追記しない', async () => {
    const idea = seedClaudeIdea()
    const requestId = requestAppend(idea.id, '追記')
    useSync.setState({ auth: 'signedIn', leader: false, status: SYNCED })
    render(<ClaudeRequests />)
    await wait(1500)
    expect(getData().ideaAppends[requestId]).toBeDefined()
    useSync.setState({ leader: true, status: { ...SYNCED, outdated: { model: 99, appVersion: '9.0' } } })
    await wait(1500)
    expect(getData().ideaAppends[requestId]).toBeDefined()
    useApp.setState({ draftsDirty: true })
    useSync.setState({ status: SYNCED })
    await wait(1500)
    expect(getData().ideas[idea.id].body).toBe(IDEA_BODY)
    useApp.setState({ draftsDirty: false })
    await waitFor(() => expect(getData().ideaAppends).toEqual({}), { timeout: 4000 })
    expect(getData().ideas[idea.id].body).toBe(appendedBody(IDEA_BODY, { createdAt: APPEND_AT, text: '追記' }))
  }, 12_000)

  it('Claude のアイデアをゴミ箱へ移す依頼のトーストは「アイデア」と言う', async () => {
    const idea = seedClaudeIdea()
    requestTrash(idea.id)
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    render(<ClaudeRequests />)
    await waitFor(() => expect(getData().ideas[idea.id]).toBeUndefined(), { timeout: 4000 })
    expect(getData().trashRequests).toEqual({})
    expect(toastMessages()).toEqual(['Claude の依頼で、アイデア1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）'])
  })
})

describe('Claude のアイデアを直す編集の画面を開いている間', () => {
  it('依頼を当てず、直して保存すると作者の内容の後ろに追記が足され、ゴミ箱へ移す依頼は作者が直したカードとして断る', async () => {
    const idea = seedClaudeIdea()
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    renderIdeas()
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    expect(screen.queryByTestId('idea-editor-claude-append')).toBeNull()
    expect(screen.queryByTestId('idea-editor-claude-trash')).toBeNull()
    await user.type(screen.getByTestId('idea-body-input'), '\n・作者が足した行')
    const appendId = requestAppend(idea.id, '【変更】\n・姉を探す')
    requestTrash(idea.id)
    await wait(1500)
    // 開いている間は当てない（届いた依頼を知らせる）。入力欄の下書き（draftsDirty）とは別の印
    expect(getData().ideas[idea.id].body).toBe(IDEA_BODY)
    expect(getData().ideaAppends[appendId]).toBeDefined()
    expect(screen.getByTestId('idea-editor-claude-append').textContent).toBe(
      'Claude からこのアイデアへの追記の依頼が届いています。保存かキャンセルで閉じると、カードの終わりに足されます。',
    )
    expect(screen.getByTestId('idea-editor-claude-trash').textContent).toBe(
      'Claude からこのアイデアをゴミ箱へ移す依頼が届いています。この画面で直して保存すると移しません（何も変えずに閉じると移します。ほかの端末・タブでアプリを開いていると、そちらで先に移ることがあります。その時は編集の画面が閉じ、書きかけは下書きに残ります。ゴミ箱から戻せます）。',
    )
    expect(useApp.getState().draftsDirty).toBe(false)
    await user.click(screen.getByTestId('idea-save'))
    await waitFor(() => expect(getData().trashRequests).toEqual({}), { timeout: 4000 })
    expect(getData().ideaAppends).toEqual({})
    const after = getData().ideas[idea.id]
    expect(after.body).toBe(`${IDEA_BODY}\n・作者が足した行\n\n${APPEND_HEADER}\n【変更】\n・姉を探す`)
    expect(ideaEditedByAuthor(after)).toBe(true)
    expect(toastMessages()).toEqual([
      `Claude の依頼で、アイデア「${IDEA_LABEL}」の終わりに追記しました。Claude の依頼のうち1件は移しませんでした（作者が直したカード1件）`,
    ])
  }, 12_000)

  it('何も変えずに保存・キャンセルで閉じると、追記してからゴミ箱へ移す（直していないので移せる）', async () => {
    const a = seedClaudeIdea('cy-home0001')
    const b = seedClaudeIdea('cy-home0002', '2026/11/12 15:00\n別の案')
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    renderIdeas()
    // 何も変えずに保存: 書かない（「作者が直した」にしない）
    await user.click(within(ideaCard(a.id)).getByTestId('idea-edit'))
    requestAppend(a.id, '追記A')
    requestTrash(a.id)
    await wait(1500)
    expect(getData().ideas[a.id]).toMatchObject({ body: IDEA_BODY, updatedAt: 100 })
    await user.click(screen.getByTestId('idea-save'))
    await waitFor(() => expect(getData().ideas[a.id]).toBeUndefined(), { timeout: 4000 })
    const trashed = Object.values(getData().trashRecords).find((r) => r.table === 'ideas')!.record as Idea
    expect(trashed.body).toBe(appendedBody(IDEA_BODY, { createdAt: APPEND_AT, text: '追記A' }))
    expect(toastMessages()).toEqual([
      `Claude の依頼で、アイデア「${IDEA_LABEL}」の終わりに追記しました。Claude の依頼で、アイデア1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）`,
    ])
    // キャンセルで閉じても同じ
    await user.click(within(ideaCard(b.id)).getByTestId('idea-edit'))
    requestAppend(b.id, '追記B')
    requestTrash(b.id)
    await wait(1500)
    expect(getData().ideas[b.id]).toBeDefined()
    await user.click(screen.getByTestId('idea-cancel'))
    await waitFor(() => expect(getData().ideas[b.id]).toBeUndefined(), { timeout: 4000 })
    expect(getData().ideaAppends).toEqual({})
    expect(getData().trashRequests).toEqual({})
  }, 15_000)

  it('追加のダイアログと、作者が書いたアイデアの編集の画面では止めない', async () => {
    const idea = seedClaudeIdea()
    const mine = actions.addIdea(null, '', '作者の案')
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    renderIdeas()
    await user.click(within(ideaCard(mine)).getByTestId('idea-edit'))
    expect(screen.getByTestId('idea-editor')).toBeDefined()
    requestAppend(idea.id, '追記1')
    await waitFor(() => expect(getData().ideaAppends).toEqual({}), { timeout: 4000 })
    expect(screen.queryByTestId('idea-editor-claude-append')).toBeNull()
    await user.click(screen.getByTestId('idea-cancel'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    await user.click(screen.getByTestId('idea-add'))
    expect(screen.getByTestId('idea-editor')).toBeDefined()
    requestAppend(idea.id, '追記2')
    await waitFor(() => expect(getData().ideaAppends).toEqual({}), { timeout: 4000 })
    expect(getData().ideas[idea.id].body).toBe(
      appendedBody(appendedBody(IDEA_BODY, { createdAt: APPEND_AT, text: '追記1' }), { createdAt: APPEND_AT, text: '追記2' }),
    )
  }, 12_000)

  it('受け持ちでない画面で開いている間にほかの画面が追記を足すと、保存した内容の後ろに残してトーストで知らせる', async () => {
    const idea = seedClaudeIdea()
    const user = userEvent.setup()
    renderIdeas(false)
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    await user.type(screen.getByTestId('idea-body-input'), '\n・作者が足した行')
    // 同期を受け持つ別のタブが追記を当て、その結果がこの画面のストアに届いた
    requestAppend(idea.id, '追記')
    act(() => commit(applyClaudeRequests(getData(), Date.now()).data))
    expect(getData().ideas[idea.id].body).toBe(appendedBody(IDEA_BODY, { createdAt: APPEND_AT, text: '追記' }))
    // 入力欄はそのまま（追記が届いても書きかけの内容を変えない）
    expect((screen.getByTestId('idea-body-input') as HTMLTextAreaElement).value).toBe(`${IDEA_BODY}\n・作者が足した行`)
    await user.click(screen.getByTestId('idea-save'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    expect(getData().ideas[idea.id].body).toBe(`${IDEA_BODY}\n・作者が足した行\n\n${APPEND_HEADER}\n追記`)
    expect(toastMessages()).toEqual(['編集している間に届いた Claude の追記を、保存した内容の後ろに残しました'])
  })

  it('開いている間にほかの画面が追記を足しても、何も変えずに閉じれば書かない（直していないカードのまま）', async () => {
    const idea = seedClaudeIdea()
    const user = userEvent.setup()
    renderIdeas(false)
    // キャンセル: 編集を始めた時の内容のままなので、確かめずに閉じる
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    requestAppend(idea.id, '追記')
    act(() => commit(applyClaudeRequests(getData(), 5000).data))
    await user.click(screen.getByTestId('idea-cancel'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    // 何も変えずに保存: 追記の後の内容と同じなので書かない
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    requestAppend(idea.id, '追記2')
    act(() => commit(applyClaudeRequests(getData(), 6000).data))
    await user.click(screen.getByTestId('idea-save'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    const after = getData().ideas[idea.id]
    expect(after.updatedAt).toBe(6000)
    expect(after.appendIds).toHaveLength(2)
    expect(ideaEditedByAuthor(after)).toBe(false)
    expect(toastMessages()).toEqual([])
  })
})
