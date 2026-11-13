// 2.8: コネクタが作った Claude のアイデア（cy-…）の時刻が Date の範囲の外（1e16 など）でも、同期で届いたホームが落ちない
// （整合性の修復で 0 にする。カードの日時も、日付にできない時刻では dateTime を書かない）
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPersistence } from '../../db/persistence'
import { hashJson } from '../../domain/hash'
import type { Idea } from '../../domain/types'
import { applyRemoteChanges, commit, getData, initStore, resetStoreForTests } from '../../store/appStore'
import { AppFrame } from '../../ui/Layout'
import { HomePage } from './HomePage'
import { resetBenchShelfForTests } from './BenchShelf'
import { resetMaterialShelfForTests } from './MaterialShelf'
import { openBand, resetHomeBandsForTests } from './homeBands'

let n = 0

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

beforeEach(async () => {
  await initStore(createPersistence(`test-db-home-claude-time-${++n}`))
  // ホームの帯は起動した時は閉じている（2.9）。アイデアの帯を開いておく
  openBand('ideas')
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetMaterialShelfForTests()
  resetBenchShelfForTests()
  resetHomeBandsForTests()
})

const BODY = '2026/11/12 14:32\n中身'

function claudeIdea(id: string, at: number): Idea {
  return {
    id,
    titleId: null,
    heading: '',
    body: BODY,
    checked: false,
    checkedAt: null,
    order: -1,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(BODY),
    createdAt: at,
    updatedAt: at,
  }
}

function renderHome() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <AppFrame>
            <HomePage />
          </AppFrame>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

describe('Claude のアイデアの時刻（Date の範囲の外）', () => {
  it.each([1e16, -1e16])('updatedAt %d のアイデアが同期で届いても、ホームはカードを出す（時刻は 0 として読む）', async (at) => {
    await applyRemoteChanges([{ table: 'ideas', id: 'cy-badtime', record: claudeIdea('cy-badtime', at) }])
    expect(getData().ideas['cy-badtime']).toMatchObject({ createdAt: 0, updatedAt: 0 })
    renderHome()
    const card = screen.getByTestId('idea-card')
    expect(within(card).getByTestId('idea-body').textContent).toContain('中身')
    expect(within(card).getByTestId('idea-by-claude')).toBeTruthy()
    expect(screen.queryByText('画面を表示できませんでした')).toBeNull()
  })

  it('修復を通っていない内容でも、カードは落ちない（日付にできない時刻では <time> の dateTime を書かない）', () => {
    const data = getData()
    commit({ ...data, ideas: { ...data.ideas, 'cy-raw': claudeIdea('cy-raw', 1e16) } })
    renderHome()
    const time = within(screen.getByTestId('idea-card')).getByRole('time', { hidden: true })
    expect(time.hasAttribute('datetime')).toBe(false)
  })
})
