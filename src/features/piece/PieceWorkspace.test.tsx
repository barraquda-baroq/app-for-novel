// 原稿画面のコンポーネントテスト（jsdom）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { usePrefs } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { PieceWorkspace } from './PieceWorkspace'

// 差分の計算が「いつ」行われるかを数える（描画の中で計算していないことを確かめる）
const diffCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../domain/diff', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../domain/diff')>()
  return {
    ...mod,
    diffTexts: (base: string, target: string) => {
      diffCalls.count += 1
      return mod.diffTexts(base, target)
    },
  }
})

let n = 0

function seed(): { titleId: ID; pieceId: ID; v1: ID; v2: ID } {
  const titleId = actions.createTitle('差分の作品')
  const pieceId = actions.addEpisode(titleId)
  const v1 = getData().pieces[pieceId].versionIds[0]
  actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。' })
  const v2 = actions.addVersion(pieceId, { body: '春は曙。\nようやく白くなっていく山際。' })
  return { titleId, pieceId, v1, v2 }
}

/** 現在地の表示と、ブラウザの「戻る／進む」の代わり */
function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>
        ブラウザで戻る
      </button>
      <button type="button" onClick={() => navigate(1)}>
        ブラウザで進む
      </button>
    </>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppFrame>
        <Routes>
          <Route path="/t/:titleId/p/:pieceId" element={<PieceWorkspace />} />
        </Routes>
        <LocationProbe />
      </AppFrame>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  diffCalls.count = 0
  await initStore(createPersistence(`test-db-piece-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  usePrefs.getState().setPrefs({ showDiff: false })
})

describe('差分表示', () => {
  it('採用原稿が自動保存されても描画の中では差分を計算せず、少し待ってからまとめて計算し直す', async () => {
    const { titleId, pieceId, v1, v2 } = seed()
    usePrefs.getState().setPrefs({ showDiff: true })
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)

    const view = await screen.findByTestId('diff-view')
    await waitFor(() => expect(view.querySelector('.diff-add')).not.toBeNull())
    const initial = diffCalls.count
    expect(initial).toBe(1)

    // 採用原稿の自動保存（入力中に何度も起きる）
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲。' }))
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲の細く。' }))
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲の細くたなびきたる。' }))
    // 描画では計算しない（前回の差分を「計算中」として出しておく）
    expect(diffCalls.count).toBe(initial)
    expect(screen.getByTestId('diff-stale').textContent).toBe('差分を計算中…')

    // 落ち着いたら1回だけ計算し直す
    await waitFor(() => expect(screen.getByTestId('diff-stale').textContent).toBe(''))
    expect(diffCalls.count).toBe(initial + 1)
    expect(view.textContent).toContain('紫だちたる雲の細くたなびきたる。')
    expect(within(view).getByText(/紫だちたる雲の細くたなびきたる/).tagName).toBe('DEL')
  })

  it('別のバージョンに切り替えた時は、前のバージョンの差分を出さない', async () => {
    const { titleId, pieceId, v2 } = seed()
    const v3 = actions.addVersion(pieceId, { body: 'まったく別の書き出し。' })
    usePrefs.getState().setPrefs({ showDiff: true })
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const view = await screen.findByTestId('diff-view')
    await waitFor(() => expect(view.querySelector('.diff-add')).not.toBeNull())

    fireEvent.change(screen.getByTestId('version-select'), { target: { value: v3 } })
    expect(view.textContent).toBe('差分を計算中…')
    await waitFor(() => expect(view.querySelector('.diff-add')?.textContent).toContain('まったく別の書き出し'))
  })
})

describe('推敲バージョンの削除', () => {
  it('応募の記録に使われている稿は、確認文でそのことを知らせる', async () => {
    const { titleId, pieceId, v1 } = seed()
    const submissionId = actions.addSubmission(titleId, '星降る文学賞')
    actions.recordSubmissionSnapshot(submissionId)
    // 採用中の第1稿を選んで削除しようとする
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v1}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('delete-version'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('この稿は「星降る文学賞」の応募時の原稿として記録されています。')
    expect(dialog.textContent).toContain('削除しても応募時の原稿は残ります。')
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  })
})

describe('比較を開く・閉じる', () => {
  it('一覧から開いた比較は履歴に積み（戻るで一覧へ）、バージョンの切り替えは積まない', async () => {
    const { titleId, pieceId, v1, v2 } = seed()
    const list = `/t/${titleId}/p/${pieceId}`
    renderAt(list)
    const user = userEvent.setup()
    const location = () => screen.getByTestId('location').textContent
    const rows = await screen.findAllByTestId('version-row')
    await user.click(within(rows[0]).getByRole('button', { name: /を開いて比較する/ }))
    expect(location()).toBe(`${list}?v=${v2}`)
    await user.selectOptions(screen.getByTestId('version-select'), v1)
    expect(location()).toBe(`${list}?v=${v1}`)

    // ブラウザ・Android の「戻る」で一覧に戻る（切り替える前のバージョンには戻らない）
    await user.click(screen.getByRole('button', { name: 'ブラウザで戻る' }))
    expect(location()).toBe(list)
    expect(screen.getByTestId('versions-heading')).toBeTruthy()

    // 「進む」で比較に戻り、「一覧」ボタンは積んだ履歴を戻る
    await user.click(screen.getByRole('button', { name: 'ブラウザで進む' }))
    expect(location()).toBe(`${list}?v=${v1}`)
    await user.click(screen.getByTestId('back-to-list'))
    expect(location()).toBe(list)
    await user.click(screen.getByRole('button', { name: 'ブラウザで進む' }))
    expect(location()).toBe(`${list}?v=${v1}`)
  })

  it('URL で直接開いた比較の「一覧」は、履歴を戻らずに一覧を表示する', async () => {
    const { titleId, pieceId, v2 } = seed()
    const list = `/t/${titleId}/p/${pieceId}`
    renderAt(`${list}?v=${v2}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('back-to-list'))
    expect(screen.getByTestId('location').textContent).toBe(list)
    expect(screen.getByTestId('versions-heading')).toBeTruthy()
  })
})
