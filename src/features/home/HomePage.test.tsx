// ホーム: 4つの領域（タイトル・アイデア・相対比較・資料）と、スマホの上の切り替え（数つき）・リンクの ?view= で開く棚
// 2.9: 4つの領域は帯で、起動した時は4つとも閉じている（見出しに件数。切り替え・リンク・［＋ 書きとめる］はその帯を開く）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import { actions } from '../../store/actions'
import { initStore, resetStoreForTests, useApp } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { HomePage } from './HomePage'
import { resetBenchShelfForTests } from './BenchShelf'
import { resetMaterialShelfForTests } from './MaterialShelf'
import { isBandOpen, openBand, resetHomeBandsForTests } from './homeBands'
import type { MouseEvent } from 'react'
import { togglesBand } from './HomeBandHead'
import { COPY_TITLE_HINT } from './homeLogic'

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
  resetHomeBandsForTests()
  useToasts.setState({ toasts: [] })
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
  const view = render(<RouterProvider router={router} />)
  return Object.assign(router, { unmount: view.unmount })
}

/** 帯の見出しのボタン */
function bandToggle(area: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid="home-band-toggle"][data-area="${area}"]`)!
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
    const heading = within(shelf).getByRole('heading', { level: 2 })
    // 見出しの中は、名前と件数（読み上げは「資料 2件」）。領域の名前は名前の部分だけ（件数を2度読み上げない）
    const name = document.getElementById(`${heading.id}-name`)!
    expect(name.textContent).toBe('資料')
    expect(heading.textContent).toBe('資料2件')
    expect(shelf.getAttribute('aria-labelledby')).toBe(name.id)
    // 切り替えはその領域を指す
    const materials = within(jump).getByTestId('home-jump-materials')
    expect(materials.getAttribute('aria-controls')).toBe(shelf.id)
  })

  it('?view=materials（資料の画面のパンくずから）: 資料の帯を開いて見出しのボタンにフォーカスし、切り替えは「資料」を表示中にする', async () => {
    actions.addMaterial({ name: '江戸の町と暮らし' })
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const router = renderHome('/?view=materials')
    expect(bandToggle('materials').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('material-list')).toBeTruthy()
    // ほかの帯は閉じたまま
    expect(bandToggle('bench').getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(document.activeElement).toBe(bandToggle('materials')))
    expect(scrolled.mock.contexts.some((el) => el === screen.getByTestId('material-shelf'))).toBe(true)
    await waitFor(() => expect(screen.getByTestId('home-jump-materials').getAttribute('aria-current')).toBe('true'))
    // URL からは消す
    await waitFor(() => expect(router.state.location.search).toBe(''))
    scrolled.mockRestore()
  })

  it('?view=bench でも、下に資料の棚があっても切り替えは「相対比較」を表示中にする', async () => {
    actions.addBenchWork({ name: '銀河の果て' })
    renderHome('/?view=bench')
    expect(bandToggle('bench').getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(bandToggle('bench')))
    await waitFor(() => expect(screen.getByTestId('home-jump-bench').getAttribute('aria-current')).toBe('true'))
    expect(screen.getByTestId('home-jump-materials').getAttribute('aria-current')).toBeNull()
  })
})

describe('ホームの帯（2.9）', () => {
  function seedAll() {
    const t = actions.createTitle('星の庭')
    actions.addIdea(null, '', 'アイデア1')
    actions.addIdea(t, '', 'アイデア2')
    actions.addBenchWork({ name: '銀河の果て' })
    actions.addMaterial({ name: '江戸の町と暮らし' })
    actions.addMaterial({ name: '和食の基本' })
    return t
  }

  it('起動した時は4つとも閉じている。見出しに件数、追加のボタンは出ていて、一覧は描かない', () => {
    seedAll()
    renderHome()
    const toggles = screen.getAllByTestId('home-band-toggle')
    expect(toggles.map((b) => [b.getAttribute('data-area'), b.getAttribute('aria-expanded'), b.textContent])).toEqual([
      ['titles', 'false', 'タイトル1件'],
      ['ideas', 'false', 'アイデア2件'],
      ['bench', 'false', '相対比較1件'],
      ['materials', 'false', '資料2件'],
    ])
    // 閉じている間は、中身を指さない
    for (const b of toggles) expect(b.hasAttribute('aria-controls')).toBe(false)
    // 件数（切り替えと同じ数）
    expect(screen.getByTestId('title-count').textContent).toBe('1')
    expect(screen.getByTestId('idea-total').textContent).toBe('2')
    expect(screen.getByTestId('bench-count').textContent).toBe('1')
    expect(screen.getByTestId('material-count').textContent).toBe('2')
    // 追加のボタンは閉じていても出す（アイデアの帯には［＋ 書きとめる］）
    for (const id of ['new-title', 'idea-band-capture', 'new-bench-work', 'new-material'])
      expect(screen.getByTestId(id)).toBeTruthy()
    // 一覧・すばやく追加・並べ替えのボタンは描かない
    for (const id of ['title-card', 'quick-capture', 'idea-sections', 'bench-list', 'material-list'])
      expect(screen.queryByTestId(id)).toBeNull()
    for (const id of ['titles-edit-toggle', 'bench-edit-toggle', 'material-edit-toggle'])
      expect(screen.queryByTestId(id)).toBeNull()
  })

  it('見出しを押すと開け閉め。開けた帯は、ホームを離れて戻っても開いたまま（起動し直すと閉じる）', () => {
    seedAll()
    const first = renderHome()
    fireEvent.click(bandToggle('titles'))
    const toggle = bandToggle('titles')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(within(body).getAllByTestId('title-card')).toHaveLength(1)
    expect(screen.getByTestId('titles-edit-toggle')).toBeTruthy()
    // ほかの帯は閉じたまま
    expect(bandToggle('ideas').getAttribute('aria-expanded')).toBe('false')
    // ホームを離れて戻る（画面を作り直す）
    first.unmount()
    renderHome()
    expect(bandToggle('titles').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('title-card')).toHaveLength(1)
    // もう一度押すと閉じる
    fireEvent.click(bandToggle('titles'))
    expect(bandToggle('titles').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('title-card')).toBeNull()
    // 起動し直した時と同じ
    fireEvent.click(bandToggle('bench'))
    act(() => resetHomeBandsForTests())
    expect(bandToggle('bench').getAttribute('aria-expanded')).toBe('false')
  })

  it('帯（見出しの行）のどこを押しても開け閉め。追加などのボタン・文字を選んだ時は開け閉めしない', () => {
    seedAll()
    renderHome()
    const head = (area: string) => bandToggle(area).closest<HTMLElement>('[data-testid="home-band-head"]')!
    const expanded = (area: string) => bandToggle(area).getAttribute('aria-expanded')
    // 行そのもの（左の余白・ボタンの間・折り返した行の空き）
    fireEvent.click(head('titles'))
    expect(expanded('titles')).toBe('true')
    expect(screen.getAllByTestId('title-card')).toHaveLength(1)
    fireEvent.click(head('titles'))
    expect(expanded('titles')).toBe('false')
    // 説明の文（アイデアの帯）
    fireEvent.click(within(head('ideas')).getByText(/タイトルごとに仕切られ/))
    expect(expanded('ideas')).toBe('true')
    // 見出しのボタンの中（件数）を押しても1回だけ（行へ伝わっても2回にならない）
    fireEvent.click(screen.getByTestId('bench-count'))
    expect(expanded('bench')).toBe('true')
    fireEvent.click(bandToggle('bench'))
    expect(expanded('bench')).toBe('false')
    // 追加などのボタンは、それぞれの動きだけ（帯を閉じない）
    fireEvent.click(bandToggle('titles'))
    fireEvent.click(screen.getByTestId('titles-edit-toggle'))
    expect(screen.getByTestId('titles-edit-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(expanded('titles')).toBe('true')
    fireEvent.click(screen.getByTestId('idea-band-capture'))
    expect(expanded('ideas')).toBe('true')
    // 行の中の文字を選んだ時（なぞって選んだ指を離した時）は開け閉めしない
    const name = head('materials').querySelector('.home-band-name')!
    const range = document.createRange()
    range.selectNodeContents(name)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.click(head('materials'))
    expect(expanded('materials')).toBe('false')
    window.getSelection()!.removeAllRanges()
    fireEvent.click(head('materials'))
    expect(expanded('materials')).toBe('true')
    // 右ボタン・中ボタンでは開け閉めしない
    fireEvent.click(head('materials'), { button: 1 })
    expect(expanded('materials')).toBe('true')
  })

  it('帯の見出しの行へ伝わる、画面の上で行の外にあるもの（portal のダイアログなど）のクリックでは開け閉めしない', () => {
    const outside = document.createElement('div')
    document.body.append(outside)
    const head = document.createElement('div')
    const inside = document.createElement('span')
    head.append(inside)
    document.body.append(head)
    const at = (target: Element, button = 0) =>
      togglesBand({
        defaultPrevented: false,
        button,
        target,
        currentTarget: head,
      } as unknown as MouseEvent<HTMLElement>)
    expect(at(inside)).toBe(true)
    expect(at(head)).toBe(true)
    // React の上ではこの行の子でも、画面の上では外（portal）
    expect(at(outside)).toBe(false)
    const button = document.createElement('button')
    head.append(button)
    expect(at(button)).toBe(false)
    head.remove()
    outside.remove()
  })

  it('帯を閉じると「並べ替え・編集」も終わる（開き直すと見るだけ）', () => {
    seedAll()
    renderHome()
    fireEvent.click(bandToggle('bench'))
    fireEvent.click(screen.getByTestId('bench-edit-toggle'))
    expect(screen.getByTestId('bench-edit-toggle').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(bandToggle('bench'))
    expect(screen.queryByTestId('bench-edit-toggle')).toBeNull()
    fireEvent.click(bandToggle('bench'))
    expect(screen.getByTestId('bench-edit-toggle').getAttribute('aria-pressed')).toBe('false')
  })

  it('上の切り替えは、閉じた帯を開いて見出しのボタンにフォーカスする（開いている帯は閉じない）', () => {
    seedAll()
    renderHome()
    fireEvent.click(screen.getByTestId('home-jump-bench'))
    expect(bandToggle('bench').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('bench-list')).toBeTruthy()
    expect(document.activeElement).toBe(bandToggle('bench'))
    expect(screen.getByTestId('home-jump-bench').getAttribute('aria-current')).toBe('true')
    fireEvent.click(screen.getByTestId('home-jump-bench'))
    expect(bandToggle('bench').getAttribute('aria-expanded')).toBe('true')
    expect(bandToggle('ideas').getAttribute('aria-expanded')).toBe('false')
  })

  it('［＋ 書きとめる］は、アイデアの帯を開いて、すばやく追加の欄にフォーカスする', () => {
    seedAll()
    renderHome()
    fireEvent.click(screen.getByTestId('idea-band-capture'))
    expect(bandToggle('ideas').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('quick-idea-input'))
    // 開いている時も同じ（閉じない）
    screen.getByTestId('new-title').focus()
    fireEvent.click(screen.getByTestId('idea-band-capture'))
    expect(bandToggle('ideas').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('quick-idea-input'))
  })

  it('?view=titles はタイトルの帯を開いて、見出しのボタンにフォーカスする', async () => {
    seedAll()
    renderHome('/?view=titles')
    expect(bandToggle('titles').getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(bandToggle('titles')))
    expect(isBandOpen('ideas')).toBe(false)
  })

  it('?view=ideas&focus=（タイトルの「すべてのアイデアを見る」から）: 閉じていたアイデアの帯を開き、その仕切りの見出しにフォーカスする', async () => {
    const t = seedAll()
    renderHome(`/?view=ideas&focus=${t}`)
    expect(bandToggle('ideas').getAttribute('aria-expanded')).toBe('true')
    const section = document.getElementById(`idea-section-${t}`)!
    await waitFor(() => expect(document.activeElement).toBe(within(section).getByTestId('idea-section-toggle')))
  })

  it('アイデアの帯を開くと、仕切りの開け閉めは前のまま（帯とは別に覚えている）', () => {
    const t = seedAll()
    renderHome()
    fireEvent.click(bandToggle('ideas'))
    const section = () => document.getElementById(`idea-section-${t}`)!
    fireEvent.click(within(section()).getByTestId('idea-section-toggle'))
    expect(within(section()).getByTestId('idea-section-toggle').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(bandToggle('ideas'))
    fireEvent.click(bandToggle('ideas'))
    expect(within(section()).getByTestId('idea-section-toggle').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('タイトルのコピー（第二稿）', () => {
  function cardNames(): string[] {
    return screen.getAllByTestId('title-card-name').map((e) => e.textContent ?? '')
  }

  function openCopyDialog(name: string): HTMLElement {
    fireEvent.click(bandToggle('titles'))
    fireEvent.click(screen.getByTestId('titles-edit-toggle'))
    const card = screen.getAllByTestId('title-card').find((c) => within(c).getByTestId('title-card-name').textContent === name)!
    fireEvent.click(within(card).getByTestId('title-copy'))
    return screen.getByRole('dialog')
  }

  it('並べ替え・編集の「コピー」: 名前に「（第二稿）」を付けて聞き、元のすぐ後ろに作って知らせる', async () => {
    const t = actions.createTitle('海の町')
    const ep = actions.addEpisode(t)
    actions.updateVersion(useApp.getState().data.pieces[ep].activeVersionId!, { body: '一話の本文' })
    actions.createTitle('後の話')
    renderHome()
    const dialog = openCopyDialog('海の町')
    expect(within(dialog).getByRole('heading').textContent).toBe('「海の町」をコピー')
    const input = within(dialog).getByTestId('prompt-input') as HTMLInputElement
    expect(input.value).toBe('海の町（第二稿）')
    expect(within(dialog).getByText('新しいタイトル名')).toBeTruthy()
    // 何を写し、何を写さないか（2行）
    const hint = dialog.querySelector('.dialog-hint')!
    expect(hint.textContent).toBe(COPY_TITLE_HINT)
    expect(COPY_TITLE_HINT.split('\n')).toHaveLength(2)
    expect(hint.textContent).toContain('話・幕の採用原稿と、設定項目・メモ・全体戦略・相対比較する作品をコピーします')
    expect(hint.textContent).toContain('応募計画')
    // 空の名前ではコピーできない
    const ok = within(dialog).getByTestId('prompt-ok') as HTMLButtonElement
    expect(ok.textContent).toBe('コピーする')
    fireEvent.change(input, { target: { value: '　 ' } })
    expect(ok.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  海の町　改  ' } })
    expect(ok.disabled).toBe(false)
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    fireEvent.click(ok)
    await waitFor(() => expect(cardNames()).toEqual(['海の町', '海の町　改', '後の話']))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useToasts.getState().toasts.map((x) => x.message)).toContain('「海の町」をコピーして「海の町　改」を作りました')
    // 新しいカードを画面の真ん中まで出す（下の端に寄せると、下に出る通知に隠れる）
    const copyId = Object.values(useApp.getState().data.titles).find((x) => x.name === '海の町　改')!.id
    const scrolledCopy = () =>
      scrolled.mock.calls.filter((_, i) => (scrolled.mock.contexts[i] as HTMLElement).dataset?.titleId === copyId)
    await waitFor(() => expect(scrolledCopy()).toHaveLength(1))
    expect(scrolledCopy()[0]).toEqual([{ block: 'center' }])
    scrolled.mockRestore()
    // 写しの話も同じ
    const data = useApp.getState().data
    const copyEp = data.titles[copyId].structure[0].id
    expect(data.versions[data.pieces[copyEp].activeVersionId!].body).toBe('一話の本文')
  })

  it('名前が「（第n稿）」で終わっていれば次の番号。キャンセルすると何も作らない', () => {
    actions.createTitle('海の町（第二稿）')
    renderHome()
    const dialog = openCopyDialog('海の町（第二稿）')
    expect((within(dialog).getByTestId('prompt-input') as HTMLInputElement).value).toBe('海の町（第三稿）')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(Object.keys(useApp.getState().data.titles)).toHaveLength(1)
  })

  it('同じタイトルを2回コピーする時は、もうある名前を避けて次の番号を出す', async () => {
    actions.createTitle('海の町')
    renderHome()
    let dialog = openCopyDialog('海の町')
    expect((within(dialog).getByTestId('prompt-input') as HTMLInputElement).value).toBe('海の町（第二稿）')
    fireEvent.click(within(dialog).getByTestId('prompt-ok'))
    await waitFor(() => expect(cardNames()).toEqual(['海の町', '海の町（第二稿）']))
    const card = screen.getAllByTestId('title-card')[0]
    fireEvent.click(within(card).getByTestId('title-copy'))
    dialog = screen.getByRole('dialog')
    expect((within(dialog).getByTestId('prompt-input') as HTMLInputElement).value).toBe('海の町（第三稿）')
    fireEvent.click(within(dialog).getByTestId('prompt-ok'))
    await waitFor(() => expect(cardNames()).toEqual(['海の町', '海の町（第三稿）', '海の町（第二稿）']))
  })
})

describe('ホームの棚のタグ（資料のタグと相対比較の作品のタグは別）', () => {
  it('相対比較の棚には作品のタグ、資料の棚には資料のタグだけを出す', () => {
    const w = actions.addBenchWork({ name: '銀河の果て' })
    actions.setBenchWorkTags(w, ['SF', '宇宙'])
    actions.addMaterial({ name: '江戸の町と暮らし', tags: ['歴史', 'SF'] })
    openBand('bench')
    openBand('materials')
    renderHome()
    const tags = (prefix: string) =>
      within(screen.getByTestId(`${prefix}-tags`))
        .getAllByTestId(`${prefix}-tag-chip`)
        .map((c) => c.getAttribute('data-tag'))
    expect(tags('bench')).toEqual(['SF', '宇宙'])
    expect(tags('material')).toEqual(['SF', '歴史'])
  })
})
