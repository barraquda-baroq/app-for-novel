// 長編でもタイトル画面が重くならないこと: 本編に関係ない変更では一覧・集計を作り直さず、
// 並べ替えでは動いた行だけを描き直す（行の要約 summarize が呼ばれた回数 = 描き直した行の数）。
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../../db/persistence'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { TitlePage } from '../TitlePage'
import * as logic from './storyLogic'

vi.mock('./storyLogic', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./storyLogic')>()
  return {
    ...mod,
    summarize: vi.fn(mod.summarize),
    titleStats: vi.fn(mod.titleStats),
    pieceRows: vi.fn(mod.pieceRows),
  }
})

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-story-tab-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
})

function seed(episodes: number, chapters = false): { titleId: ID; ids: ID[] } {
  const titleId = actions.createTitle('大長編')
  const ids: ID[] = []
  for (let i = 0; i < episodes; i++) {
    const id = actions.addEpisode(titleId)
    actions.updatePiece(id, { subtitle: `題${i + 1}` })
    actions.updateVersion(getData().pieces[id].versionIds[0], { body: `第${i + 1}話の本文。`.repeat(50) })
    ids.push(id)
  }
  if (chapters) actions.setChaptersEnabled(titleId, true)
  return { titleId, ids }
}

function renderTitle(titleId: ID) {
  render(
    <MemoryRouter initialEntries={[`/t/${titleId}`]}>
      <Routes>
        <Route path="/t/:titleId" element={<TitlePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function clearCounts() {
  vi.mocked(logic.summarize).mockClear()
  vi.mocked(logic.titleStats).mockClear()
  vi.mocked(logic.pieceRows).mockClear()
}

function subtitles(): string[] {
  return screen.getAllByTestId('piece-subtitle').map((el) => el.textContent ?? '')
}

describe('タイトル画面の描き直し', () => {
  it('あらすじ・タイトル名の変更では、本編の行も集計も作り直さない', () => {
    const { titleId } = seed(12)
    renderTitle(titleId)
    expect(screen.getAllByTestId('piece-row')).toHaveLength(12)
    clearCounts()

    act(() => actions.updateTitle(titleId, { synopsis: '新しいあらすじ' }))
    act(() => actions.updateTitle(titleId, { name: '改題' }))
    expect(screen.getByTestId<HTMLInputElement>('title-name').value).toBe('改題')
    expect(logic.summarize).not.toHaveBeenCalled()
    expect(logic.titleStats).not.toHaveBeenCalled()
    expect(logic.pieceRows).not.toHaveBeenCalled()
  })

  it('↑↓では動いた行だけを描き直す（章あり・章なし）', () => {
    for (const chapters of [false, true]) {
      const { titleId, ids } = seed(12, chapters)
      renderTitle(titleId)
      clearCounts()
      act(() => actions.movePieceStep(ids[5], -1))
      expect(subtitles().slice(3, 7)).toEqual(['題4', '題6', '題5', '題7'])
      // 話数が入れ替わった2行だけ
      expect(logic.summarize).toHaveBeenCalledTimes(2)
      // 集計は1回だけ（タイトル見出し）
      expect(logic.titleStats).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('編集モードの切り替え・章の折りたたみでは、行の要約（採用中の稿・抜粋）を作り直さない', async () => {
    const user = userEvent.setup()
    const { titleId } = seed(8, true)
    actions.addChapter(titleId, '第二部')
    renderTitle(titleId)
    clearCounts()
    await user.click(screen.getByTestId('edit-toggle'))
    expect(screen.getAllByTestId('piece-up')).toHaveLength(8)
    await user.click(screen.getAllByTestId('chapter-collapse')[0])
    expect(screen.getAllByTestId('chapter-collapse')[0].getAttribute('aria-expanded')).toBe('false')
    expect(logic.summarize).not.toHaveBeenCalled()
    expect(logic.titleStats).not.toHaveBeenCalled()
  })
})
