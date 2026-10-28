// セパレート画面: カーソルを置いて Enter・「ここで区切る」で分割点を足し、外し、幕に分ける
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { cancelAllDialogs, DialogHost } from '../../ui/dialogs'
import { writeCrashDraft } from '../piece/crashDraft'
import { versionField } from '../piece/session'
import { SEPARATE_FROM_PIECE } from './separateLogic'
import { SeparatePage } from './SeparatePage'

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-separate-${++n}`))
})

afterEach(() => {
  cancelAllDialogs()
  cleanup()
  resetStoreForTests()
  useToasts.setState({ toasts: [] })
  useSync.setState({ everSignedIn: false })
  localStorage.clear()
})

const BODY = '一幕目。\r\n二幕目。\r\n三幕目。'

function seed(): { titleId: ID; pieceId: ID } {
  const titleId = actions.createTitle('作品')
  const pieceId = actions.addEpisode(titleId)
  actions.updatePiece(pieceId, { subtitle: '題' })
  actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: BODY })
  return { titleId, pieceId }
}

function renderPage(titleId: ID, pieceId: ID) {
  render(
    <MemoryRouter initialEntries={[`/t/${titleId}/p/${pieceId}/separate`]}>
      <Routes>
        <Route path="/t/:titleId/p/:pieceId/separate" element={<SeparatePage />} />
        <Route path="/t/:titleId/p/:pieceId" element={<p data-testid="piece-screen">原稿画面</p>} />
      </Routes>
      <DialogHost />
    </MemoryRouter>,
  )
}

const toastTexts = () => useToasts.getState().toasts.map((t) => t.message)

/** 入力欄 i の position（入力欄の値での位置）にカーソルを置いて Enter */
function enterAt(i: number, position: number) {
  const area = screen.getAllByTestId<HTMLTextAreaElement>('separate-text')[i]
  act(() => {
    area.focus()
    area.setSelectionRange(position, position)
  })
  fireEvent.keyDown(area, { key: 'Enter' })
}

describe('セパレート画面', () => {
  it('Enter と「ここで区切る」で分割点を置き、外し、幕に分ける（CRLF の本文も元の位置で区切る）', async () => {
    const { titleId, pieceId } = seed()
    renderPage(titleId, pieceId)
    expect(screen.getByTestId('separate-heading').textContent).toBe('第1話　題')
    const area = screen.getByTestId<HTMLTextAreaElement>('separate-text')
    // 入力欄の値は改行が LF にそろう。読み取り専用でキーボードを出さない
    expect(area.value).toBe('一幕目。\n二幕目。\n三幕目。')
    expect(area.readOnly).toBe(true)
    expect(area.getAttribute('inputmode')).toBe('none')
    expect(screen.getByTestId<HTMLButtonElement>('separate-apply').disabled).toBe(true)

    enterAt(0, 0)
    expect(screen.getByTestId('separate-message').textContent).toBe('先頭では区切れません')
    // 「二幕目」の前（入力欄の値で 5 文字目）
    enterAt(0, 5)
    expect(screen.getAllByTestId('split-divider').map((d) => d.textContent)).toEqual(['ここから第2幕'])
    // 2つ目の区切りの「三幕目」の前で「ここで区切る」
    const second = screen.getAllByTestId<HTMLTextAreaElement>('separate-text')[1]
    act(() => {
      second.focus()
      second.setSelectionRange(5, 5)
    })
    fireEvent.click(screen.getByTestId('separate-decide'))
    expect(screen.getAllByTestId('split-divider')).toHaveLength(2)
    expect(screen.getAllByTestId('separate-preview-item').map((li) => li.textContent)).toEqual([
      '第1幕一幕目。4字',
      '第2幕二幕目。4字',
      '第3幕三幕目。4字',
    ])
    // 区切りの先頭で Backspace を押すと、その区切りを外す
    const third = screen.getAllByTestId<HTMLTextAreaElement>('separate-text')[2]
    act(() => {
      third.focus()
      third.setSelectionRange(0, 0)
    })
    fireEvent.keyDown(third, { key: 'Backspace' })
    expect(screen.getAllByTestId('split-divider')).toHaveLength(1)
    fireEvent.click(screen.getAllByTestId('remove-split')[0])
    expect(screen.queryAllByTestId('split-divider')).toHaveLength(0)

    enterAt(0, 5)
    enterAt(1, 5)
    fireEvent.click(screen.getByTestId('separate-apply'))
    expect(await screen.findByTestId('piece-screen')).toBeTruthy()
    // 知らせは見出しをかぎかっこでくくる（題と助詞がつながって読めないように）
    expect(toastTexts()).toContain('「第1話　題」を3幕に分けました')
    const d = getData()
    const acts = d.pieces[pieceId].actIds!
    expect(acts.map((id) => d.versions[d.pieces[id].activeVersionId!].body)).toEqual(['一幕目。\r\n', '二幕目。\r\n', '三幕目。'])
  })

  it('採用原稿のない話は分けられない', () => {
    const { titleId, pieceId } = seed()
    actions.setActiveVersion(pieceId, null)
    renderPage(titleId, pieceId)
    expect(screen.getByTestId('separate-unavailable').textContent).toContain('採用原稿がないため分けられません')
  })
})

describe('セパレート画面（カーソル・控え・履歴）', () => {
  it('カーソルを動かすと、どこで区切れるかを知らせる（読み上げにも出る）', () => {
    const { titleId, pieceId } = seed()
    renderPage(titleId, pieceId)
    const area = screen.getByTestId<HTMLTextAreaElement>('separate-text')
    act(() => {
      area.focus()
      area.setSelectionRange(5, 5)
    })
    fireEvent.select(area)
    expect(screen.getByTestId('separate-message').textContent).toBe('第1幕の「一幕目。↵｜二幕目。↵三」で区切れます')
    expect(screen.getByTestId('separate-message').getAttribute('role')).toBe('status')
  })

  it('保存されていない編集の控えがあれば知らせ、分ける前に続けるか聞く（キャンセルなら分けない）', async () => {
    const { titleId, pieceId } = seed()
    const v1 = getData().pieces[pieceId].versionIds[0]
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: BODY, value: `${BODY}追記` } }, 'closed-tab')
    renderPage(titleId, pieceId)
    expect((await screen.findByTestId('separate-draft-notice')).textContent).toContain('前回保存されなかった編集の控えがあります')
    enterAt(0, 5)
    fireEvent.click(screen.getByTestId('separate-apply'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存されていない編集があります')
    expect(dialog.textContent).toContain('第1稿の本文')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getData().pieces[pieceId].actIds ?? []).toEqual([])
    // このまま続ける: 保存した本文で分ける（控えは残る）
    fireEvent.click(screen.getByTestId('separate-apply'))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'このまま続ける' }))
    expect(await screen.findByTestId('piece-screen')).toBeTruthy()
    expect(getData().pieces[pieceId].actIds).toHaveLength(2)
    expect(localStorage.getItem(`novel-studio:edit:${pieceId}`)).not.toBeNull()
  })

  it('同期している端末で初めて分ける時は、ほかの端末のアプリを先に新しくするよう一度だけ伝える', async () => {
    const { titleId, pieceId } = seed()
    useSync.setState({ everSignedIn: true })
    renderPage(titleId, pieceId)
    enterAt(0, 5)
    fireEvent.click(screen.getByTestId('separate-apply'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('ほかの端末のアプリを先に新しくしてください')
    fireEvent.click(within(dialog).getByRole('button', { name: '分ける' }))
    expect(await screen.findByTestId('piece-screen')).toBeTruthy()
    expect(localStorage.getItem('novel-studio:acts-other-devices-notice')).toBe('1')
  })

  it('原稿画面から開いた時は、分けた後に履歴を1つ戻る（同じ画面を二重に積まない）', async () => {
    const { titleId, pieceId } = seed()
    const router = createMemoryRouter(
      [
        { path: '/t/:titleId', element: <p data-testid="title-screen">一覧</p> },
        { path: '/t/:titleId/p/:pieceId', element: <p data-testid="piece-screen">原稿画面</p> },
        {
          path: '/t/:titleId/p/:pieceId/separate',
          element: (
            <>
              <SeparatePage />
              <DialogHost />
            </>
          ),
        },
      ],
      {
        initialEntries: [
          `/t/${titleId}`,
          `/t/${titleId}/p/${pieceId}`,
          { pathname: `/t/${titleId}/p/${pieceId}/separate`, state: { [SEPARATE_FROM_PIECE]: true } },
        ],
        initialIndex: 2,
      },
    )
    render(<RouterProvider router={router} />)
    enterAt(0, 5)
    fireEvent.click(screen.getByTestId('separate-apply'))
    expect(await screen.findByTestId('piece-screen')).toBeTruthy()
    // もう1つ戻ると一覧（原稿画面は1つしか積まれていない）
    await act(async () => {
      await router.navigate(-1)
    })
    expect(screen.getByTestId('title-screen')).toBeTruthy()
  })
})
