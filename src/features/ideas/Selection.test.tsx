// 選んで移す（2.9）: 選んでいる間は済みのチェックボックスの代わりに選ぶチェックボックス、カードを押しても選べる、
// フォルダの見出しの□（中のフォルダのカードも。閉じたままでも）、下の帯の数と［移す…］、もう無いカードは除く、Esc・やめる・移した後に終わる
// （［やめる］の後は［選んで移す］にフォーカス）。移した後は移した先（既にあるフォルダ・新しく作ったフォルダ）を開いて最初の1枚を見せる。
// カードの長押し（指）: そのカードを選んだ状態で始める・選んでいる最中は選ぶ・外す・ほかの仕切りから切り替える。離した時のクリックは
// どこに届いても取り消す。指が動いた・スクロールした・マウス・ボタンの所からは始めない。押したカードは同じ位置に残す。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import { lightTap } from '../../platform/haptics'
import '../../test/pointerEvent'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { LONG_PRESS_MS } from '../../ui/longPress'
import { IdeaArea } from '../home/IdeaArea'
import { resetFolderCollapseForTests } from './folderCollapse'
import { useReveal } from './reveal'
import { stopSelect, useSelection } from './selection'

vi.mock('../../platform/haptics', () => ({ lightTap: vi.fn() }))

let n = 0

const section = (key: string) => screen.getAllByTestId('idea-section').find((s) => s.dataset.section === key)!
const card = (text: string) => screen.getAllByTestId('idea-card').find((c) => c.textContent?.includes(text))!
const folder = (name: string) =>
  screen
    .getAllByTestId('idea-folder')
    .find((f) => f.querySelector(':scope > .idea-folder-head [data-testid="idea-folder-name"]')?.textContent === name)!
const head = (name: string) => folder(name).querySelector<HTMLElement>(':scope > .idea-folder-head')!
const folderBox = (name: string) => within(head(name)).getByTestId('idea-folder-select') as HTMLInputElement
const folderToggle = (name: string) => within(head(name)).getByTestId('idea-folder-toggle')
/** フォルダにじかに入っているカードの文（並び順） */
const cardsIn = (name: string) =>
  Array.from(
    folder(name).querySelectorAll<HTMLElement>(':scope > .idea-folder-body > .idea-list > [data-testid="idea-card"]'),
  ).map((c) => within(c).getByTestId('idea-body').textContent)

/** そのカードを見せた（目立たせて、スクロールして、フォーカスした）か */
async function expectRevealed(text: string) {
  expect(card(text).className).toContain('is-revealed')
  const scroll = HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>
  await waitFor(() => expect(scroll.mock.contexts).toContain(card(text)))
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))
  expect(document.activeElement).toBe(card(text))
}

beforeEach(async () => {
  localStorage.clear()
  resetFolderCollapseForTests()
  stopSelect()
  useToasts.setState({ toasts: [] })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  await initStore(createPersistence(`test-db-idea-select-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  stopSelect()
  localStorage.clear()
  resetFolderCollapseForTests()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

function seed() {
  const ids = { title: '', top: '', sub: '', home: '', cards: [] as ID[] }
  act(() => {
    ids.title = actions.createTitle('星の庭')
    ids.top = actions.createIdeaFolder(ids.title, null, '場面の相談')
    ids.sub = actions.createIdeaFolder(ids.title, ids.top, '雨の駅')
    ids.home = actions.createIdeaFolder(null, null, '新作の相談')
    ids.cards.push(actions.addIdea(ids.title, '', '相談の案', ids.top))
    ids.cards.push(actions.addIdea(ids.title, '', '駅の案1', ids.sub))
    ids.cards.push(actions.addIdea(ids.title, '', '駅の案2', ids.sub))
    for (let i = 1; i <= 8; i++) ids.cards.push(actions.addIdea(null, '', `Claude の案${i}`))
  })
  render(
    <MemoryRouter>
      <AppFrame>
        <IdeaArea headingId="h" />
      </AppFrame>
    </MemoryRouter>,
  )
  return ids
}

describe('選んで移す', () => {
  it('選んでいる間は、済みのチェックボックスの代わりに選ぶチェックボックス。並べ替え・移動・編集・削除は出さない。カードを押しても選べる', async () => {
    const user = userEvent.setup()
    seed()
    const home = section('none')
    const start = within(home).getByTestId('idea-select-start')
    expect(start.getAttribute('aria-pressed')).toBe('false')
    await user.click(start)
    expect(start.getAttribute('aria-pressed')).toBe('true')
    const c = card('Claude の案1')
    expect(within(c).queryByTestId('idea-check')).toBeNull()
    for (const id of ['idea-up', 'idea-down', 'idea-move', 'idea-edit', 'idea-delete', 'idea-make-title']) {
      expect(within(c).queryByTestId(id)).toBeNull()
    }
    const box = within(c).getByTestId('idea-select') as HTMLInputElement
    expect(box.getAttribute('aria-label')).toBe('『Claude の案1』を選ぶ')
    // ほかの仕切りのカードは今までどおり
    expect(within(card('相談の案')).getByTestId('idea-check')).toBeTruthy()
    expect(within(section(home.dataset.section!)).queryByTestId('idea-select-bar')).toBeTruthy()
    expect(within(home).getByTestId('idea-select-count').textContent).toBe('0件を選択中')
    const hint = within(home).getByTestId('idea-select-hint')
    expect(hint.textContent).toBe(
      '移すカードを選んでください（フォルダの見出しの□で中をまとめて選べます）。次からは、カードの長押しでも始められます',
    )
    // 長押しの説明は指で操作する端末だけ（CSS の pointer: coarse）
    expect(hint.querySelector('.idea-touch-only')?.textContent).toBe('。次からは、カードの長押しでも始められます')
    expect(within(home).getByTestId('idea-select-move')).toHaveProperty('disabled', true)

    await user.click(box)
    expect(box.checked).toBe(true)
    expect(card('Claude の案1').className).toContain('is-selected')
    await user.click(within(card('Claude の案2')).getByTestId('idea-body'))
    expect(card('Claude の案2').className).toContain('is-selected')
    expect(within(home).getByTestId('idea-select-count').textContent).toBe('2件を選択中')
    expect(within(home).queryByTestId('idea-select-hint')).toBeNull()
    expect(within(home).getByTestId('idea-select-move')).toHaveProperty('disabled', false)
    // もう一度押すと外れる
    await user.click(within(card('Claude の案2')).getByTestId('idea-body'))
    expect(within(home).getByTestId('idea-select-count').textContent).toBe('1件を選択中')

    // ［やめる］で終わる
    await user.click(within(home).getByTestId('idea-select-cancel'))
    expect(within(home).queryByTestId('idea-select-bar')).toBeNull()
    expect(within(card('Claude の案1')).getByTestId('idea-check')).toBeTruthy()
  })

  it('［やめる］で終わると、フォーカスはその仕切りの［選んで移す］に戻る（押したボタンと一緒に body へ落ちない）', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const t = section(ids.title)
    const start = within(t).getByTestId('idea-select-start')
    await user.click(start)
    expect(start.getAttribute('aria-pressed')).toBe('true')
    within(t).getByTestId('idea-select-cancel').focus()
    await user.keyboard('{Enter}')
    expect(within(t).queryByTestId('idea-select-bar')).toBeNull()
    expect(useSelection.getState().section).toBeNull()
    expect(start.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(start)
  })

  it('フォルダの見出しの□は、中のカード（中のフォルダのものも）をまとめて選ぶ。一部だけなら途中の印。閉じていても選べる。［＋］［…］は出さない', async () => {
    const user = userEvent.setup()
    seed()
    const t = section(getData().titles[Object.keys(getData().titles)[0]].id)
    // 閉じたままでも選べる
    await user.click(within(head('場面の相談')).getByTestId('idea-folder-toggle'))
    await user.click(within(t).getByTestId('idea-select-start'))
    expect(within(head('場面の相談')).queryByTestId('idea-folder-add')).toBeNull()
    expect(within(head('場面の相談')).queryByTestId('idea-folder-menu')).toBeNull()
    expect(folderBox('場面の相談').getAttribute('aria-label')).toBe('『場面の相談』の中のカードをすべて選ぶ')
    await user.click(folderBox('場面の相談'))
    expect(within(t).getByTestId('idea-select-count').textContent).toBe('3件を選択中')
    expect(folderBox('場面の相談').checked).toBe(true)
    expect(folderBox('雨の駅').checked).toBe(true)
    // 2段目の中の1枚を外すと、どちらの見出しも途中の印
    await user.click(within(head('場面の相談')).getByTestId('idea-folder-toggle'))
    await user.click(within(card('駅の案1')).getByTestId('idea-select'))
    expect(folderBox('場面の相談').checked).toBe(false)
    expect(folderBox('場面の相談').indeterminate).toBe(true)
    expect(folderBox('雨の駅').indeterminate).toBe(true)
    // もう一度押すと、すべて選ぶ。すべて選んでいる時に押すと、すべて外す
    await user.click(folderBox('場面の相談'))
    expect(within(t).getByTestId('idea-select-count').textContent).toBe('3件を選択中')
    await user.click(folderBox('場面の相談'))
    expect(within(t).getByTestId('idea-select-count').textContent).toBe('0件を選択中')
    // 別の仕切りで始めると、前の仕切りの選択は終わる
    await user.click(within(section('none')).getByTestId('idea-select-start'))
    expect(within(t).queryByTestId('idea-select-bar')).toBeNull()
    expect(within(section('none')).getByTestId('idea-select-bar')).toBeTruthy()
  })

  it('もう無いカード・ほかの仕切りへ移ったカードは選択から除く。Esc で終わる（ダイアログが開いている時はダイアログだけ閉じる）', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const home = section('none')
    await user.click(within(home).getByTestId('idea-select-start'))
    for (const i of [1, 2, 3]) await user.click(within(card(`Claude の案${i}`)).getByTestId('idea-select'))
    expect(within(home).getByTestId('idea-select-count').textContent).toBe('3件を選択中')
    act(() => {
      actions.deleteIdea(ids.cards[3])
      actions.moveIdeaToSection(ids.cards[4], ids.title)
    })
    expect(within(home).getByTestId('idea-select-count').textContent).toBe('1件を選択中')
    expect([...useSelection.getState().ids]).toEqual([ids.cards[5]])

    await user.click(within(home).getByTestId('idea-select-move'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(home).getByTestId('idea-select-bar')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(within(home).queryByTestId('idea-select-bar')).toBeNull()
  })

  it('［移す…］で8件を既にあるフォルダへまとめて移すと、今の並びのまま入って終わり、閉じていた移した先を開いて最初の1枚を見せる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const home = section('none')
    // 移した先のフォルダを閉じておく
    await user.click(folderToggle('新作の相談'))
    expect(folderToggle('新作の相談').getAttribute('aria-expanded')).toBe('false')
    await user.click(within(home).getByTestId('idea-select-start'))
    for (let i = 1; i <= 8; i++) await user.click(within(card(`Claude の案${i}`)).getByTestId('idea-select'))
    await user.click(within(home).getByTestId('idea-select-move'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toBe('8件のアイデアを移動')
    const target = within(dialog)
      .getAllByTestId('idea-move-option')
      .find((o) => o.dataset.folder === ids.home)!
    await user.click(target)
    await user.click(within(dialog).getByTestId('idea-move-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const moved = ids.cards.slice(3).map((id) => getData().ideas[id])
    expect(moved.every((i) => i.folderId === ids.home)).toBe(true)
    // 並びは前の見せる順のまま
    expect(moved.map((i) => i.order)).toEqual([...moved.map((i) => i.order)].sort((a, b) => a - b))
    expect(cardsIn('新作の相談')).toEqual(Array.from({ length: 8 }, (_, i) => `Claude の案${i + 1}`))
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
      '8件を「どのタイトルにも属さない › 新作の相談」へ移しました',
    )
    expect(within(home).queryByTestId('idea-select-bar')).toBeNull()
    expect(useSelection.getState().section).toBeNull()
    // 移した先を開いて、最初の1枚を見せる（入れ物が変わって描き直したカードも、移したのと同じ時なので見せる）
    expect(folderToggle('新作の相談').getAttribute('aria-expanded')).toBe('true')
    expect(useReveal.getState()).toMatchObject({ id: ids.cards[3], scroll: true })
    await expectRevealed('Claude の案1')
    expect(card('Claude の案2').className).not.toContain('is-revealed')
  })

  it('［移す…］で8件を、選んだ場所（仕切りのフォルダの外）に新しいフォルダを作ってまとめて移すと、終わって、そのフォルダを開いて最初の1枚を見せる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const home = section('none')
    await user.click(within(home).getByTestId('idea-select-start'))
    for (let i = 1; i <= 8; i++) await user.click(within(card(`Claude の案${i}`)).getByTestId('idea-select'))
    await user.click(within(home).getByTestId('idea-select-move'))
    const dialog = screen.getByRole('dialog')
    const root = within(dialog)
      .getAllByTestId('idea-move-option')
      .find((o) => o.dataset.section === 'none' && o.dataset.folder === '')!
    await user.click(root)
    await user.click(within(dialog).getByTestId('idea-move-new-folder'))
    await user.type(screen.getByTestId('prompt-input'), '港町の相談')
    await user.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const made = Object.values(getData().ideaFolders).filter((f) => f.name === '港町の相談')
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ titleId: null, parentId: null })
    const moved = ids.cards.slice(3).map((id) => getData().ideas[id])
    expect(moved.every((i) => i.folderId === made[0].id && i.titleId === null)).toBe(true)
    // 中は8枚、前の見せる順のまま。作者の既にあるフォルダは変わらない
    expect(cardsIn('港町の相談')).toEqual(Array.from({ length: 8 }, (_, i) => `Claude の案${i + 1}`))
    expect(cardsIn('新作の相談')).toEqual([])
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
      '8件を「どのタイトルにも属さない › 港町の相談」へ移しました',
    )
    expect(within(home).queryByTestId('idea-select-bar')).toBeNull()
    expect(useSelection.getState().section).toBeNull()
    expect(folderToggle('港町の相談').getAttribute('aria-expanded')).toBe('true')
    expect(useReveal.getState()).toMatchObject({ id: ids.cards[3], scroll: true })
    await expectRevealed('Claude の案1')
  })

  it('カードの無い仕切りには［選んで移す］を出さない', () => {
    act(() => {
      actions.createTitle('空のタイトル')
    })
    render(
      <MemoryRouter>
        <AppFrame>
          <IdeaArea headingId="h" />
        </AppFrame>
      </MemoryRouter>,
    )
    for (const s of screen.getAllByTestId('idea-section')) expect(within(s).queryByTestId('idea-select-start')).toBeNull()
  })
})

describe('カードの長押し（指）', () => {
  const touch = { pointerType: 'touch', isPrimary: true, button: 0 }
  const body = (text: string) => within(card(text)).getByTestId('idea-body')
  const bar = (key: string) => within(section(key)).queryByTestId('idea-select-bar')
  const count = (key: string) => within(section(key)).queryByTestId('idea-select-count')?.textContent ?? null
  const selectBox = (text: string) => within(card(text)).getByTestId('idea-select') as HTMLInputElement

  beforeEach(() => vi.mocked(lightTap).mockClear())
  afterEach(() => vi.useRealTimers())

  /** 描いた後で時計を止める（データの用意は本物のタイマーで） */
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  /** 指で長押しする（離さない） */
  function longPress(el: HTMLElement) {
    fireEvent.pointerDown(el, { ...touch, clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
  }
  /** 指を離す。クリックは clickOn（並びが動いた時は指の下に来たほかのカード）に届く */
  function lift(el: HTMLElement, clickOn: HTMLElement = el) {
    fireEvent.pointerUp(el, touch)
    fireEvent.click(clickOn)
  }
  /** ふつうに軽く押す */
  function tap(el: HTMLElement) {
    fireEvent.pointerDown(el, touch)
    fireEvent.pointerUp(el, touch)
    fireEvent.click(el)
  }

  it('本文の所を0.5秒押すと、そのカードを選んだ状態で始まり、軽く振動する。離した時のクリックでは選ぶ・外すにならない', () => {
    seed()
    fakeTimers()
    fireEvent.pointerDown(body('Claude の案1'), { ...touch, clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1))
    expect(bar('none')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(count('none')).toBe('1件を選択中')
    expect(card('Claude の案1').className).toContain('is-selected')
    expect(selectBox('Claude の案1').checked).toBe(true)
    expect(within(section('none')).getByTestId('idea-select-start').getAttribute('aria-pressed')).toBe('true')
    expect(lightTap).toHaveBeenCalledTimes(1)
    // 押したカードに届いたクリック
    lift(body('Claude の案1'))
    expect(count('none')).toBe('1件を選択中')
    // 後でふつうに押すと選べる
    tap(body('Claude の案2'))
    expect(count('none')).toBe('2件を選択中')

    // 選んでいる最中の長押しは、そのカードを選ぶ。離した時のクリックが、並びが動いて指の下に来たほかのカードに届いても選ばない
    longPress(body('Claude の案3'))
    expect(count('none')).toBe('3件を選択中')
    lift(body('Claude の案3'), body('Claude の案4'))
    expect(count('none')).toBe('3件を選択中')
    expect(card('Claude の案4').className).not.toContain('is-selected')
    // もう一度長押しすると外す
    longPress(body('Claude の案3'))
    lift(body('Claude の案3'))
    expect(count('none')).toBe('2件を選択中')
    expect(card('Claude の案3').className).not.toContain('is-selected')
    expect(lightTap).toHaveBeenCalledTimes(3)
  })

  it('［選んで移す］で始めた後の長押しは、そのカードを選ぶ・外す', async () => {
    const user = userEvent.setup()
    seed()
    await user.click(within(section('none')).getByTestId('idea-select-start'))
    expect(count('none')).toBe('0件を選択中')
    fakeTimers()
    longPress(body('Claude の案5'))
    lift(body('Claude の案5'))
    expect(count('none')).toBe('1件を選択中')
    expect(selectBox('Claude の案5').checked).toBe(true)
    longPress(body('Claude の案5'))
    lift(body('Claude の案5'))
    expect(count('none')).toBe('0件を選択中')
    expect(bar('none')).toBeTruthy()
  })

  it('ほかの仕切りで選んでいる時は、長押ししたカードの仕切りに切り替わる（前の選択はやめる）', async () => {
    const user = userEvent.setup()
    const ids = seed()
    await user.click(within(section(ids.title)).getByTestId('idea-select-start'))
    await user.click(within(card('相談の案')).getByTestId('idea-select'))
    expect(count(ids.title)).toBe('1件を選択中')
    fakeTimers()
    longPress(body('Claude の案2'))
    lift(body('Claude の案2'))
    expect(bar(ids.title)).toBeNull()
    expect(count('none')).toBe('1件を選択中')
    expect(useSelection.getState()).toMatchObject({ section: 'none', ids: new Set([ids.cards[4]]) })
  })

  it('指が動いた・0.5秒より前に離した・ブラウザが止めた（pointercancel）・スクロールした時は始めない', () => {
    seed()
    fakeTimers()
    const b = body('Claude の案1')
    fireEvent.pointerDown(b, { ...touch, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(b, { ...touch, clientX: 20, clientY: 50 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(b, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100))
    fireEvent.pointerUp(b, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(b, touch)
    fireEvent.pointerCancel(b, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(b, touch)
    fireEvent.scroll(window)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(useSelection.getState().section).toBeNull()
    expect(bar('none')).toBeNull()
    expect(lightTap).not.toHaveBeenCalled()
  })

  it('マウスの押し続け・右クリックでは始めない（右クリックはブラウザのメニューのまま）', () => {
    seed()
    fakeTimers()
    const b = body('Claude の案1')
    fireEvent.pointerDown(b, { pointerType: 'mouse', isPrimary: true, button: 0 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(fireEvent.contextMenu(b, { clientX: 20, clientY: 20 })).toBe(true)
    expect(useSelection.getState().section).toBeNull()
  })

  it('Android（長押しで contextmenu が先に届く）: ブラウザのメニューは出さずに始め、タイマーで二重に選ばない', () => {
    seed()
    fakeTimers()
    const b = body('Claude の案1')
    fireEvent.pointerDown(b, { ...touch, clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(400))
    expect(fireEvent.contextMenu(b, { clientX: 20, clientY: 20 })).toBe(false)
    expect(count('none')).toBe('1件を選択中')
    expect(lightTap).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(600))
    lift(b)
    expect(count('none')).toBe('1件を選択中')
    expect(selectBox('Claude の案1').checked).toBe(true)
  })

  it('済みのカード・フォルダの中のカードも長押しで選べる。済みの□・［移動］から始めた長押しは何もしない', () => {
    const ids = seed()
    act(() => actions.setIdeaChecked(ids.cards[3], true))
    fakeTimers()
    longPress(within(card('Claude の案2')).getByTestId('idea-check'))
    longPress(within(card('Claude の案2')).getByTestId('idea-move'))
    expect(useSelection.getState().section).toBeNull()
    longPress(body('Claude の案1'))
    lift(body('Claude の案1'))
    expect(card('Claude の案1').dataset.checked).toBe('true')
    expect(count('none')).toBe('1件を選択中')
    expect(selectBox('Claude の案1').checked).toBe(true)
    longPress(body('駅の案2'))
    lift(body('駅の案2'))
    expect(count(ids.title)).toBe('1件を選択中')
    expect(selectBox('駅の案2').checked).toBe(true)
  })

  it('始めてカードの高さが変わっても、押したカードは画面の同じ位置に残る（その分スクロールする）', () => {
    seed()
    const li = card('Claude の案6')
    const rect = (top: number) => ({ top, bottom: top + 80, left: 0, right: 300, width: 300, height: 80 }) as DOMRect
    // 始める前は 300、ボタンの行が消えて上のカードが縮んだ後は 250
    vi.spyOn(li, 'getBoundingClientRect').mockReturnValueOnce(rect(300)).mockReturnValue(rect(250))
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    try {
      fakeTimers()
      longPress(body('Claude の案6'))
      expect(count('none')).toBe('1件を選択中')
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: window.scrollY - 50 }))
    } finally {
      scrollTo.mockRestore()
    }
  })
})
