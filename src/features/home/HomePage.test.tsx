// ホーム: 4つの領域（タイトル・アイデア・相対比較・資料）と、スマホの上の切り替え（数つき）・リンクの ?view= で開く棚
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import { actions } from '../../store/actions'
import { initStore, resetStoreForTests } from '../../store/appStore'
import { AppFrame } from '../../ui/Layout'
import { HomePage } from './HomePage'
import { resetBenchShelfForTests } from './BenchShelf'
import { resetMaterialShelfForTests } from './MaterialShelf'

let n = 0

beforeAll(() => {
  // jsdom は scrollIntoView を実装していない（切り替え・リンクで領域の先頭へ移る）
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

beforeEach(async () => {
  await initStore(createPersistence(`test-db-home-page-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetMaterialShelfForTests()
  resetBenchShelfForTests()
})

function renderHome(entry = '/') {
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
    { initialEntries: [entry] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('ホーム', () => {
  it('タイトル・アイデア・相対比較・資料の4つの領域。上の切り替えも4つ（この順・数つき）', () => {
    actions.createTitle('星の庭')
    actions.addIdea(null, '', 'アイデア')
    actions.addBenchWork({ name: '銀河の果て' })
    actions.addMaterial({ name: '江戸の町と暮らし' })
    actions.addMaterial({ name: '和食の基本' })
    renderHome()
    // jsdom は画面の幅を持たない（matchMedia が無い）ので、上下に積んだ時の表示
    const jump = screen.getByTestId('home-jump')
    expect(
      within(jump)
        .getAllByRole('button')
        .map((b) => [b.getAttribute('data-area'), b.textContent]),
    ).toEqual([
      ['titles', 'タイトル1'],
      ['ideas', 'アイデア1'],
      ['bench', '相対比較1'],
      ['materials', '資料2'],
    ])
    const panes = Array.from(document.querySelectorAll('.home-pane')).map((p) => p.getAttribute('data-area'))
    expect(panes).toEqual(['titles', 'ideas', 'bench', 'materials'])
    const shelf = screen.getByTestId('material-shelf')
    expect(within(shelf).getByRole('heading', { level: 2 }).textContent).toBe('資料')
    expect(shelf.getAttribute('aria-labelledby')).toBe(within(shelf).getByRole('heading', { level: 2 }).id)
    // 切り替えはその領域を指す
    const materials = within(jump).getByTestId('home-jump-materials')
    expect(materials.getAttribute('aria-controls')).toBe(shelf.id)
  })

  it('?view=materials（資料の画面のパンくずから）: 資料の棚の見出しにフォーカスし、切り替えは「資料」を表示中にする', async () => {
    actions.addMaterial({ name: '江戸の町と暮らし' })
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const router = renderHome('/?view=materials')
    const heading = within(screen.getByTestId('material-shelf')).getByRole('heading', { level: 2 })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(scrolled.mock.contexts.some((el) => el === screen.getByTestId('material-shelf'))).toBe(true)
    await waitFor(() => expect(screen.getByTestId('home-jump-materials').getAttribute('aria-current')).toBe('true'))
    // URL からは消す
    await waitFor(() => expect(router.state.location.search).toBe(''))
    scrolled.mockRestore()
  })

  it('?view=bench でも、下に資料の棚があっても切り替えは「相対比較」を表示中にする', async () => {
    actions.addBenchWork({ name: '銀河の果て' })
    renderHome('/?view=bench')
    const heading = within(screen.getByTestId('bench-shelf')).getByRole('heading', { level: 2 })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    await waitFor(() => expect(screen.getByTestId('home-jump-bench').getAttribute('aria-current')).toBe('true'))
    expect(screen.getByTestId('home-jump-materials').getAttribute('aria-current')).toBeNull()
  })
})

describe('ホームの棚のタグ（資料のタグと相対比較の作品のタグは別）', () => {
  it('相対比較の棚には作品のタグ、資料の棚には資料のタグだけを出す', () => {
    const w = actions.addBenchWork({ name: '銀河の果て' })
    actions.setBenchWorkTags(w, ['SF', '宇宙'])
    actions.addMaterial({ name: '江戸の町と暮らし', tags: ['歴史', 'SF'] })
    renderHome()
    const tags = (prefix: string) =>
      within(screen.getByTestId(`${prefix}-tags`))
        .getAllByTestId(`${prefix}-tag-chip`)
        .map((c) => c.getAttribute('data-tag'))
    expect(tags('bench')).toEqual(['SF', '宇宙'])
    expect(tags('material')).toEqual(['SF', '歴史'])
  })
})
