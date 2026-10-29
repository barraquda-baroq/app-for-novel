// 原稿画面の「推敲案 n」と一覧: 本文（保存していない編集も含めて）の中で箇所を選ぶ・チェックする・別の幕へ移る
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewPaste } from '../../claude/paste'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { cancelAllDialogs } from '../../ui/dialogs'
import { AppFrame } from '../../ui/Layout'
import { PieceWorkspace } from './PieceWorkspace'

let n = 0

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <AppFrame>
            <Outlet />
            <LocationProbe />
          </AppFrame>
        ),
        children: [{ path: '/t/:titleId/p/:pieceId', element: <PieceWorkspace /> }],
      },
    ],
    { initialEntries: [path] },
  )
  return { router, ...render(<RouterProvider router={router} />) }
}

function seed(bodies: string[]): { titleId: ID; pieceIds: ID[] } {
  const titleId = actions.createTitle('推敲の作品')
  const pieceIds = bodies.map((body) => {
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    return id
  })
  return { titleId, pieceIds }
}

function suggest(titleId: ID, items: unknown[]) {
  const text =
    '```novel-studio-v1\n' + JSON.stringify({ tool: 'novel_add_proofreading', input: { title_id: 'x', items } }) + '\n```'
  const p = previewPaste(getData(), text, { titleId, now: Date.now() })
  if (!p.ok) throw new Error(p.error)
  actions.addClaudeRecords(p.records)
}

const editor = () => screen.getByTestId('active-editor') as HTMLTextAreaElement

beforeEach(async () => {
  await initStore(createPersistence(`test-db-proof-panel-${++n}`))
})

afterEach(() => {
  cancelAllDialogs()
  cleanup()
  resetStoreForTests()
})

describe('原稿画面の推敲案', () => {
  it('?ps= で開くと一覧を開いて箇所を選び、URL から外す。チェックすると「推敲案 n」が減る', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seed(['一行目。\n\n窓から見れる景色。食べれる。'])
    suggest(titleId, [
      { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' },
      { piece: '#1', excerpt: '食べれる', category: 'ra_nuki', reason: 'ら抜き' },
    ])
    const id = Object.values(getData().proofSuggestions).find((s) => s.excerpt === '見れる')!.id
    renderAt(`/t/${titleId}/p/${pieceIds[0]}?ps=${id}`)
    const panel = await screen.findByTestId('proof-panel')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/p/${pieceIds[0]}`))
    await waitFor(() => expect(editor().value.slice(editor().selectionStart, editor().selectionEnd)).toBe('見れる'))
    expect(screen.getByTestId('proof-chip-count').textContent).toBe('2')
    const item = within(panel)
      .getAllByTestId('proof-item')
      .find((e) => e.textContent?.includes('見れる'))!
    expect(item.className).toContain('is-selected')
    expect(within(item).getByTestId('proof-location').textContent).toBe('¶2')

    // チェックしても一覧には斜線で残る（外し直せる）
    await user.click(within(item).getByTestId('proof-check'))
    expect(screen.getByTestId('proof-chip-count').textContent).toBe('1')
    expect(within(panel).getAllByTestId('proof-item')).toHaveLength(2)
    expect(getData().proofSuggestions[id].done).toBe(true)
    await user.click(within(panel).getByTestId('proof-panel-close'))
    expect(screen.queryByTestId('proof-panel')).toBeNull()
  })

  it('保存していない本文の編集も含めて探し直す。見つからなければ「本文が変わりました」', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seed(['窓から見れる景色。'])
    suggest(titleId, [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }])
    renderAt(`/t/${titleId}/p/${pieceIds[0]}`)
    await user.click(await screen.findByTestId('proof-chip'))
    const panel = screen.getByTestId('proof-panel')
    // 前に文を足す（保存しない）
    fireEvent.change(editor(), { target: { value: '書き足した文。窓から見れる景色。' } })
    await user.click(within(panel).getByTestId('proof-jump'))
    expect(editor().selectionStart).toBe('書き足した文。窓から'.length)
    expect(editor().value.slice(editor().selectionStart, editor().selectionEnd)).toBe('見れる')

    fireEvent.change(editor(), { target: { value: '窓から見られる景色。' } })
    await waitFor(() => expect(within(panel).getByTestId('proof-location').textContent).toContain('本文が変わりました'))
    await user.click(within(panel).getByTestId('proof-jump'))
    await waitFor(() => expect(document.body.textContent).toContain('本文が変わりました（直した可能性）'))
  })

  it('幕に分けた後は、その幕を開いて選ぶ。推敲案が無ければ「推敲案 n」を出さない', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seed(['前半の文。後半で見れる景色。', '何もない話。'])
    suggest(titleId, [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }])
    const acts = actions.separatePiece(pieceIds[0], [5])
    // 推敲案は分ける前の話を指している
    const s = Object.values(getData().proofSuggestions)[0]
    expect(s.pieceId).toBe(pieceIds[0])
    const { router } = renderAt(`/t/${titleId}/p/${acts[0]}`)
    // 第1幕には無い（話の推敲案は、その話の幕の画面には出さない）
    await screen.findByTestId('active-editor')
    expect(screen.queryByTestId('proof-chip')).toBeNull()
    await router.navigate(`/t/${titleId}/p/${pieceIds[1]}`)
    await screen.findByTestId('active-editor')
    expect(screen.queryByTestId('proof-chip')).toBeNull()
    await router.navigate(`/t/${titleId}/p/${acts[0]}?ps=${s.id}`)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/p/${acts[1]}`))
    await waitFor(() => expect(editor().value.slice(editor().selectionStart, editor().selectionEnd)).toBe('見れる'))
    void user
  })
})
