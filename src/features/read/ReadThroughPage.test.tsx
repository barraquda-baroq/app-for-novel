// 通し読み画面のコンポーネントテスト（jsdom）: 縦書きのページ表示（字数×行数の選択・全nページ（目安）・目次のページ番号・
// ページ・見出し・ルビ）と、1話だけの通し読み（話の画面の「この話を通し読み」・?piece=）
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { DEFAULT_PREFS, usePrefs, useToasts } from '../../store/uiStore'
import { copyText } from '../../ui/browser'
import { cancelAllDialogs } from '../../ui/dialogs'
import { AppFrame } from '../../ui/Layout'
import { PieceWorkspace } from '../piece/PieceWorkspace'
import { ReadThroughPage } from './ReadThroughPage'

vi.mock('../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ui/browser')>()
  return { ...original, copyText: vi.fn(async () => true) }
})

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-read-${++n}`))
})

afterEach(() => {
  cancelAllDialogs()
  cleanup()
  resetStoreForTests()
  usePrefs.getState().setPrefs({ verticalReading: DEFAULT_PREFS.verticalReading, editorFontSize: DEFAULT_PREFS.editorFontSize })
  useToasts.setState({ toasts: [] })
  vi.mocked(copyText).mockClear()
  localStorage.clear()
})

/** 1段落 400字・1000字・短い話（字数×行数ごとのページ数を数えやすいように、句読点のない字だけ） */
function seedBook(): { titleId: ID; pieces: ID[] } {
  const titleId = actions.createTitle('頁の本')
  const pieces = ['あ'.repeat(400), 'い'.repeat(1000), '三話の本文。'].map((body) => {
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    return id
  })
  actions.updatePiece(pieces[1], { subtitle: '長い話' })
  return { titleId, pieces }
}

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
        children: [
          { path: '/t/:titleId/read', element: <ReadThroughPage /> },
          { path: '/t/:titleId/p/:pieceId', element: <PieceWorkspace /> },
          { path: '/t/:titleId', element: <p data-testid="title-page">タイトル</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return { router, ...render(<RouterProvider router={router} />) }
}

const tocPages = () => screen.queryAllByTestId('toc-page').map((el) => el.textContent)
const pageNumbers = () => screen.queryAllByTestId('page-number').map((el) => el.textContent)

describe('縦書きのページ表示', () => {
  it('横書きでは字数×行数・ページ数・目次のページ番号を出さず、縦書きにすると 40字×32行のページに組んで出す', async () => {
    const user = userEvent.setup()
    const { titleId } = seedBook()
    renderAt(`/t/${titleId}/read`)
    expect(screen.getAllByTestId('read-piece')).toHaveLength(3)
    expect(screen.queryByTestId('page-setup-button')).toBeNull()
    expect(screen.queryByTestId('read-pages')).toBeNull()
    expect(tocPages()).toEqual([])
    expect(screen.queryAllByTestId('read-page-sheet')).toHaveLength(0)

    await user.click(screen.getByTestId('vertical-toggle'))
    expect(screen.getByTestId('page-setup-value').textContent).toBe('40字×32行')
    expect(screen.getByTestId('read-pages').textContent).toBe('・全3ページ（目安）')
    expect(tocPages()).toEqual(['p.1', 'p.2', 'p.3'])
    expect(pageNumbers()).toEqual(['1', '2', '3'])
    // 話ごとに新しいページから。見出し（第n話　題）と空行の後に本文。1行 40字
    const episodes = screen.getAllByTestId('read-piece')
    expect(episodes).toHaveLength(3)
    const first = within(episodes[1]).getAllByTestId('read-page-sheet')[0]
    expect(within(first).getByTestId('page-heading').textContent).toBe('第2話　長い話')
    const lines = first.querySelectorAll('.pg-line')
    expect(lines[1].classList.contains('is-blank')).toBe(true)
    expect(lines[2].textContent).toBe('い'.repeat(40))
    expect(first.querySelectorAll('.pg-line.is-text')).toHaveLength(25)
    expect(screen.getByTestId('read-body').classList.contains('is-paged')).toBe(true)
    // 「編集」は話の原稿へ
    expect(within(episodes[1]).getByTestId('read-edit').getAttribute('href')).toContain(`/p/`)
  })

  it('選ぶ欄で字数×行数を変えると、タイトルに残り（同期する）、ページ数・目次のページ番号が変わる', async () => {
    const user = userEvent.setup()
    const { titleId } = seedBook()
    usePrefs.getState().setPrefs({ verticalReading: true })
    renderAt(`/t/${titleId}/read`)
    await user.click(screen.getByTestId('page-setup-button'))
    const menu = screen.getByTestId('page-setup-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.querySelector('.pm-label')?.textContent),
    ).toEqual(['20字×20行', '40字×30行', '40字×32行', '40字×40行', '42字×34行', '自由に入力'])
    await user.click(screen.getByTestId('page-setup-20x20'))
    expect(getData().titles[titleId].pageSetup).toEqual({ chars: 20, lines: 20 })
    expect(screen.getByTestId('page-setup-value').textContent).toBe('20字×20行')
    // 400字 = 20行 + 見出しと空行 → 2ページ、1000字 = 50行 + 2 → 3ページ
    expect(screen.getByTestId('read-pages').textContent).toBe('・全6ページ（目安）')
    expect(tocPages()).toEqual(['p.1', 'p.3', 'p.6'])
    expect(pageNumbers()).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(screen.getAllByTestId('read-page-sheet')[0].querySelectorAll('.pg-line')).toHaveLength(20)
  })

  it('自由に入力: 範囲の外・数でなければ知らせ、全角の数字も読む', async () => {
    const user = userEvent.setup()
    const { titleId } = seedBook()
    usePrefs.getState().setPrefs({ verticalReading: true })
    renderAt(`/t/${titleId}/read`)
    await user.click(screen.getByTestId('page-setup-button'))
    await user.click(screen.getByTestId('page-setup-custom'))
    const dialog = screen.getByRole('dialog')
    const chars = within(dialog).getByTestId('page-setup-chars')
    const lines = within(dialog).getByTestId('page-setup-lines')
    expect((chars as HTMLInputElement).value).toBe('40')
    expect((lines as HTMLInputElement).value).toBe('32')
    await user.clear(chars)
    await user.type(chars, '9')
    await user.click(within(dialog).getByTestId('page-setup-apply'))
    expect(within(dialog).getByTestId('page-setup-error').textContent).toBe('1行の字数は 10〜60 の数で入れてください')
    expect(chars.getAttribute('aria-invalid')).toBe('true')
    await user.clear(chars)
    await user.type(chars, '３０')
    await user.clear(lines)
    await user.type(lines, 'あ')
    await user.click(within(dialog).getByTestId('page-setup-apply'))
    expect(within(dialog).getByTestId('page-setup-error').textContent).toBe('1ページの行数は 5〜60 の数で入れてください')
    await user.clear(lines)
    await user.type(lines, '10')
    await user.click(within(dialog).getByTestId('page-setup-apply'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(getData().titles[titleId].pageSetup).toEqual({ chars: 30, lines: 10 })
    expect(screen.getByTestId('page-setup-value').textContent).toBe('30字×10行')
    expect(screen.getByTestId('read-pages').textContent).toBe('・全7ページ（目安）')
    // 選べる値でない時は「自由に入力」に印と今の値
    await user.click(screen.getByTestId('page-setup-button'))
    const custom = screen.getByTestId('page-setup-custom')
    expect(custom.textContent).toContain('今は 30字×10行')
    expect(custom.querySelector('svg')).not.toBeNull()
  })

  it('幕の見出しは幕の id を持ち、目次の幕にもページ番号。ルビは読みを添え、採用原稿のない話は1行で知らせる', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('幕の本')
    const ep = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[ep].versionIds[0], { body: '一幕目の本文。\n二幕目の本文。' })
    const actIds = actions.separatePiece(ep, ['一幕目の本文。\n'.length])
    const missing = actions.addEpisode(titleId)
    actions.setActiveVersion(missing, null)
    const ruby = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[ruby].versionIds[0], { body: '｜魔法《まほう》と《《星》》。' })
    usePrefs.getState().setPrefs({ verticalReading: true })
    renderAt(`/t/${titleId}/read`)

    const acts = screen.getAllByTestId('read-act-label')
    expect(acts.map((el) => el.textContent)).toEqual(['第1幕', '第2幕'])
    expect(acts.map((el) => el.id)).toEqual(actIds.map((id) => `rt-act-${id}`))
    expect(tocPages()).toEqual(['p.1', 'p.1', 'p.1', 'p.2', 'p.3'])
    const episodes = screen.getAllByTestId('read-piece')
    expect(within(episodes[1]).getByTestId('no-active').textContent).toBe('採用原稿がありません。')
    const rt = episodes[2].querySelector('.pg-ruby .pg-rt')
    expect(rt?.textContent).toBe('まほう')
    expect(episodes[2].querySelector('em.rb-bouten')?.textContent).toBe('星')
    expect(episodes[2].querySelector('.pg-line.is-text')?.textContent).toBe('魔法まほうと星。')

    // 目次から幕へ移動すると、幕の見出しにフォーカス
    await user.click(screen.getAllByTestId('toc-act-link')[1])
    expect(document.activeElement).toBe(acts[1])
  })
})

describe('1話だけの通し読み', () => {
  it('話の画面の「この話を通し読み」からその話だけを開き、ページ数・ページ番号はその話の分。範囲を全体にすると全部', async () => {
    const user = userEvent.setup()
    const { titleId, pieces } = seedBook()
    actions.setTitlePageSetup(titleId, { chars: 20, lines: 20 })
    renderAt(`/t/${titleId}/p/${pieces[1]}`)
    expect(screen.getByTestId('read-title-link').getAttribute('href')).toBe(`/t/${titleId}/read`)
    await user.click(screen.getByTestId('read-episode-link'))
    expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/read?piece=${pieces[1]}`)

    expect(screen.getAllByTestId('read-piece')).toHaveLength(1)
    expect(screen.getByTestId('read-piece').textContent).toContain('長い話')
    expect(screen.queryByText('三話の本文。')).toBeNull()
    expect(document.title).toBe('通し読み: 第2話　長い話（頁の本） — Novel Studio')
    const crumbs = document.querySelector('.breadcrumbs')!
    expect(crumbs.textContent).toContain('第2話　長い話')
    const scope = screen.getByTestId('read-scope') as HTMLSelectElement
    expect(scope.value).toBe(':piece')
    expect(scope.selectedOptions[0].textContent).toBe('第2話　長い話')

    // 全文コピーはその話だけ
    await user.click(screen.getByTestId('copy-all'))
    expect(vi.mocked(copyText).mock.calls[0][0]).toBe(`第2話　長い話\n\n${'い'.repeat(1000)}\n`)

    await user.click(screen.getByTestId('vertical-toggle'))
    expect(screen.getByTestId('read-pages').textContent).toBe('・全3ページ（目安）')
    expect(pageNumbers()).toEqual(['1', '2', '3'])
    expect(tocPages()).toEqual(['p.1'])

    await user.selectOptions(scope, '')
    expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/read`)
    expect(screen.getAllByTestId('read-piece')).toHaveLength(3)
    expect(screen.getByTestId('read-pages').textContent).toBe('・全6ページ（目安）')
  })

  it('幕を指すと属する話、ほかのタイトルの話・ない話ならタイトル全体', () => {
    const { titleId, pieces } = seedBook()
    actions.updateVersion(getData().pieces[pieces[0]].versionIds[0], { body: '前半。\n後半。' })
    const [act1] = actions.separatePiece(pieces[0], ['前半。\n'.length])
    const other = actions.createTitle('別の本')
    const otherPiece = actions.addEpisode(other)
    renderAt(`/t/${titleId}/read?piece=${act1}`)
    expect(screen.getAllByTestId('read-piece')).toHaveLength(1)
    expect(screen.getAllByTestId('read-act-label').map((el) => el.textContent)).toEqual(['第1幕', '第2幕'])
    cleanup()
    renderAt(`/t/${titleId}/read?piece=${otherPiece}`)
    expect(screen.getAllByTestId('read-piece')).toHaveLength(3)
    cleanup()
    renderAt(`/t/${titleId}/read?piece=nothing`)
    expect(screen.getAllByTestId('read-piece')).toHaveLength(3)
  })
})
