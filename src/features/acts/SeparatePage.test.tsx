// セパレート画面: カーソルを置いて Enter・「ここで区切る」で分割点を足し、外し、幕に分ける
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { SeparatePage } from './SeparatePage'

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-separate-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
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
    </MemoryRouter>,
  )
}

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
  it('Enter と「ここで区切る」で分割点を置き、外し、幕に分ける（CRLF の本文も元の位置で区切る）', () => {
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
    expect(screen.getByTestId('piece-screen')).toBeTruthy()
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
