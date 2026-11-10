// Claude のアイデアを直す編集の画面を開いている間に、ゴミ箱へ移す依頼が届いた時（2.8）。止めるのはその画面（タブ）だけなので、
// ほかの端末・タブが先に移すことがある。知らせはそれを約束しない言い方で、移った時は編集の画面が閉じ、書きかけは下書きに残る
// （ゴミ箱から戻して開き直すと、下書きを復元できる）
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMemo } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTrashRequests } from '../../claude/trashRequest'
import { createPersistence } from '../../db/persistence'
import { applyClaudeRequests } from '../../domain/claudeRequests'
import { ideaSections } from '../../domain/entityOps'
import { hashJson } from '../../domain/hash'
import type { Idea, TrashRequest } from '../../domain/types'
import { actions } from '../../store/actions'
import { commit, getData, initStore, resetStoreForTests, useData } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { resetSyncForTests, useSync } from '../../sync/controller'
import { AppFrame } from '../../ui/Layout'
import { ClaudeRequests } from '../claude/ClaudeRequests'
import { IdeaSectionView } from './IdeaSectionView'

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-idea-editor-claude-trash-${++n}`))
  useToasts.setState({ toasts: [] })
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetSyncForTests()
  localStorage.clear()
})

const SYNCED = { phase: 'synced' as const, pending: 0, lastSyncedAt: 1, error: null }
const IDEA_BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
const TRASH_NOTICE =
  'Claude からこのアイデアをゴミ箱へ移す依頼が届いています。この画面で直して保存すると移しません（何も変えずに閉じると移します。ほかの端末・タブでアプリを開いていると、そちらで先に移ることがあります。その時は編集の画面が閉じ、書きかけは下書きに残ります。ゴミ箱から戻せます）。'

/** コネクタが作った Claude のアイデアが同期で届いた */
function seedClaudeIdea(id = 'cy-home0001'): Idea {
  const idea: Idea = {
    id,
    titleId: null,
    heading: '',
    body: IDEA_BODY,
    checked: false,
    checkedAt: null,
    order: -1,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(IDEA_BODY),
    createdAt: 100,
    updatedAt: 100,
  }
  const data = getData()
  commit({ ...data, ideas: { ...data.ideas, [id]: idea } })
  return idea
}

/** コネクタがアイデアにゴミ箱へ移す依頼を作って、同期で届いた */
function requestTrash(ideaId: string): string {
  const data = getData()
  const built = buildTrashRequests(
    data,
    { cards: [ideaId] },
    { now: Date.now(), trash: {}, wasDeleted: () => false, dailyLeft: 100 },
  )
  const req = built.records[0].record as TrashRequest
  commit({ ...data, trashRequests: { ...data.trashRequests, [req.id]: req } })
  return req.id
}

function HomeIdeas() {
  const data = useData()
  const section = useMemo(() => ideaSections(data).find((s) => s.titleId === null)!, [data])
  return <IdeaSectionView section={section} heading="ホームのアイデア" />
}

const ideaCard = (id: string) => document.querySelector<HTMLElement>(`[data-testid="idea-card"][data-idea-id="${id}"]`)!
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)))

describe('Claude のアイデアの編集の画面とゴミ箱へ移す依頼', () => {
  it('この画面では止めるが、ほかの端末が移すと編集の画面が閉じ、書きかけは下書きに残る（ゴミ箱から戻して開き直すと復元できる）', async () => {
    const idea = seedClaudeIdea()
    useSync.setState({ auth: 'signedIn', leader: true, status: SYNCED })
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AppFrame>
          <ClaudeRequests />
          <HomeIdeas />
        </AppFrame>
      </MemoryRouter>,
    )
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    await user.type(screen.getByTestId('idea-body-input'), '\n・作者が足した行')
    requestTrash(idea.id)
    await wait(1500)
    // この画面（同期を受け持つ画面）は、開いている間は移さない。知らせは、ほかの端末・タブで先に移ることがあると言う
    expect(getData().ideas[idea.id]).toBeDefined()
    expect(screen.getByTestId('idea-editor-claude-trash').textContent).toBe(TRASH_NOTICE)
    // ほかの端末が依頼を処理し、その結果が同期で届いた
    act(() => commit(applyClaudeRequests(getData(), Date.now()).data))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    expect(getData().ideas[idea.id]).toBeUndefined()
    const entry = Object.values(getData().trashEntries).find((e) => e.kind === 'idea')!
    expect(entry).toMatchObject({ by: 'claude' })
    // ゴミ箱から戻して開き直すと、書きかけを下書きとして復元できる
    act(() => actions.restoreTrashEntry(entry.id))
    await waitFor(() => expect(ideaCard(idea.id)).not.toBeNull())
    await user.click(within(ideaCard(idea.id)).getByTestId('idea-edit'))
    expect(screen.getByTestId('idea-draft-restored')).toBeDefined()
    expect((screen.getByTestId('idea-body-input') as HTMLTextAreaElement).value).toBe(`${IDEA_BODY}\n・作者が足した行`)
  }, 12_000)
})
