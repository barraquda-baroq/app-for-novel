// カードの移動のダイアログ（2.9: 木の形）: 現在の場所の印・フォルダの中のカードの既定の移動先・フォルダの中の位置、
// まとめて移す（題・まとめ・移動先を選ぶまで押せない）、「選んだ場所に新しいフォルダを作って移す」（2段目の中には作れない）。
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { IdeaArea } from '../home/IdeaArea'
import { TitleIdeasTab } from '../title/ideas/TitleIdeasTab'
import { FOLDER_COLLAPSED_KEY, resetFolderCollapseForTests, toggleFolder } from './folderCollapse'
import { IdeaMoveDialog } from './IdeaMoveDialog'
import { COLLAPSED_KEY } from './storage'
import { useReveal } from './reveal'

let n = 0

function renderTab(titleId: ID) {
  return render(
    <MemoryRouter>
      <AppFrame>
        <TitleIdeasTab titleId={titleId} />
      </AppFrame>
    </MemoryRouter>,
  )
}

const toasts = () => useToasts.getState().toasts.map((t) => t.message)
const card = (text: string) => screen.getAllByTestId('idea-card').find((c) => c.textContent?.includes(text))!
const dialog = () => screen.getByTestId('idea-move-dialog').closest<HTMLElement>('[role="dialog"]')!
const options = () =>
  within(dialog())
    .getAllByTestId('idea-move-option')
    .map((o) => `${'  '.repeat(Number(o.dataset.depth))}${o.textContent}`)
const option = (name: string) =>
  within(dialog())
    .getAllByTestId('idea-move-option')
    .find((o) => o.querySelector('.idea-move-name')?.textContent === name)!

beforeEach(async () => {
  localStorage.clear()
  resetFolderCollapseForTests()
  useToasts.setState({ toasts: [] })
  useReveal.setState({ id: null, seq: 0, scroll: false })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  await initStore(createPersistence(`test-db-idea-move-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  localStorage.clear()
  resetFolderCollapseForTests()
  vi.useRealTimers()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

function seed() {
  const ids = { title: '', other: '', top: '', sub: '', home: '' }
  act(() => {
    ids.title = actions.createTitle('星の庭')
    ids.other = actions.createTitle('風の街')
    ids.top = actions.createIdeaFolder(ids.title, null, '場面の相談')
    ids.sub = actions.createIdeaFolder(ids.title, ids.top, '雨の駅')
    ids.home = actions.createIdeaFolder(null, null, '新作の相談')
    actions.addIdea(ids.title, '', '外の案')
    actions.addIdea(ids.title, '', '相談の案1', ids.top)
    actions.addIdea(ids.title, '', '相談の案2', ids.top)
    actions.addIdea(ids.title, '', '駅の案', ids.sub)
  })
  return ids
}

describe('1枚のカードを移す', () => {
  it('移動先は木の形で、今の入れ物に「現在の場所」。フォルダの中のカードの既定は、その仕切りのフォルダの外', async () => {
    const user = userEvent.setup()
    const ids = seed()
    renderTab(ids.title)
    await user.click(within(card('相談の案2')).getByTestId('idea-move'))
    expect(options()).toEqual([
      '星の庭（フォルダの外）1件',
      '  場面の相談現在の場所',
      '    雨の駅1件',
      '風の街0件',
      'どのタイトルにも属さない（フォルダの外）0件',
      '  新作の相談0件',
    ])
    expect(option('星の庭（フォルダの外）').className).toContain('is-selected')
    expect(option('雨の駅').dataset.folder).toBe(ids.sub)
    expect(option('雨の駅').dataset.section).toBe(ids.title)
    expect(screen.getByTestId('idea-move-summary').textContent).toBe('「星の庭」の末尾（「外の案」の後）に入ります。')
    await user.click(within(dialog()).getByTestId('idea-move-submit'))
    expect(getData().ideas[card('相談の案2').dataset.ideaId!]).not.toHaveProperty('folderId')
    expect(await screen.findByText('「星の庭」へ移動しました')).toBeTruthy()
  })

  it('フォルダの外のカードの既定は、ほかの仕切りの先頭（今までどおり）。フォルダの中の位置を選べる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    renderTab(ids.title)
    await user.click(within(card('外の案')).getByTestId('idea-move'))
    expect(option('星の庭（フォルダの外）').textContent).toContain('現在の場所')
    expect(option('風の街').className).toContain('is-selected')
    await user.click(option('場面の相談'))
    const position = within(dialog()).getByTestId('idea-move-position') as HTMLSelectElement
    expect(Array.from(position.options).map((o) => o.textContent)).toEqual([
      '先頭（「相談の案1」の前）',
      '「相談の案1」の後',
      '末尾（「相談の案2」の後）',
    ])
    await user.selectOptions(position, '0')
    expect(screen.getByTestId('idea-move-summary').textContent).toBe(
      '「星の庭 › 場面の相談」の先頭（「相談の案1」の前）に入ります。',
    )
    await user.click(within(dialog()).getByTestId('idea-move-submit'))
    const moved = getData().ideas[card('外の案').dataset.ideaId!]
    expect(moved).toMatchObject({ titleId: ids.title, folderId: ids.top })
    expect(await screen.findByText('「星の庭 › 場面の相談」へ移動しました')).toBeTruthy()
    // 移した先のカードの並び
    const folderCards = screen
      .getAllByTestId('idea-folder')[0]
      .querySelectorAll(':scope > .idea-folder-body > .idea-list > [data-testid="idea-card"]')
    expect(Array.from(folderCards).map((c) => c.querySelector('[data-testid="idea-body"]')!.textContent)).toEqual([
      '外の案',
      '相談の案1',
      '相談の案2',
    ])
  })

  it('移した後は、閉じていた仕切り（ホーム）とフォルダを開いて、そのカードを見せる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    act(() => toggleFolder(ids.top))
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([ids.title]))
    render(
      <MemoryRouter>
        <AppFrame>
          <IdeaArea headingId="h" />
        </AppFrame>
      </MemoryRouter>,
    )
    // 別の仕切り（ホーム）のカードを、閉じた仕切りの閉じたフォルダの中の2段目へ
    let homeIdea = ''
    act(() => {
      homeIdea = actions.addIdea(null, '', 'ホームの案')
    })
    await user.click(within(card('ホームの案')).getByTestId('idea-move'))
    await user.click(option('雨の駅'))
    await user.click(within(dialog()).getByTestId('idea-move-submit'))
    expect(getData().ideas[homeIdea]).toMatchObject({ titleId: ids.title, folderId: ids.sub })
    const section = screen.getAllByTestId('idea-section').find((s) => s.dataset.section === ids.title)!
    expect(within(section).getByTestId('idea-section-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(JSON.parse(localStorage.getItem(FOLDER_COLLAPSED_KEY) ?? '[]')).toEqual([])
    expect(useReveal.getState()).toMatchObject({ id: homeIdea, scroll: true })
  })
})

describe('まとめて移す', () => {
  function renderBulk(ideaIds: ID[], onMoved = vi.fn(), onClose = vi.fn()) {
    render(
      <MemoryRouter>
        <AppFrame>
          <IdeaMoveDialog ideaIds={ideaIds} bulk onMoved={onMoved} onClose={onClose} />
        </AppFrame>
      </MemoryRouter>,
    )
    return { onMoved, onClose }
  }

  it('題は「8件のアイデアを移動」。移動先を選ぶまで移せず、位置は選ばない（末尾に入る）。もう無いカードの数を添えて知らせる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const cards: ID[] = []
    act(() => {
      for (let i = 0; i < 8; i++) cards.push(actions.addIdea(null, '', `Claude の案${i + 1}`))
      actions.setIdeaChecked(cards[7], true)
    })
    const { onMoved, onClose } = renderBulk(cards)
    expect(within(dialog()).getByRole('heading').textContent).toBe('8件のアイデアを移動')
    // すべて同じ入れ物なので、そこに印
    expect(option('どのタイトルにも属さない（フォルダの外）').textContent).toContain('現在の場所')
    expect(within(dialog()).queryByTestId('idea-move-position')).toBeNull()
    expect(within(dialog()).getByTestId('idea-move-submit')).toHaveProperty('disabled', true)
    expect(within(dialog()).getByTestId('idea-move-new-folder')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('idea-move-summary').textContent).toBe('移動先を選んでください。')
    await user.click(option('新作の相談'))
    expect(screen.getByTestId('idea-move-summary').textContent).toBe(
      '8件を「どのタイトルにも属さない › 新作の相談」の末尾に移します。済みのカードは済みのまま、下にまとまります。',
    )
    // 開いている間に2件が消えた（ほかの端末・Claude の依頼で）
    act(() => {
      actions.deleteIdea(cards[0])
      actions.deleteIdea(cards[1])
    })
    await user.click(within(dialog()).getByTestId('idea-move-submit'))
    const moved = cards.slice(2).map((id) => getData().ideas[id])
    expect(moved.every((i) => i.folderId === ids.home && i.titleId === null)).toBe(true)
    // 済みは済みのまま
    expect(getData().ideas[cards[7]].checked).toBe(true)
    expect(
      await screen.findByText('6件を「どのタイトルにも属さない › 新作の相談」へ移しました（2件はもうありません）'),
    ).toBeTruthy()
    expect(onMoved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('「選んだ場所に新しいフォルダを作って移す」: 1段目を選ぶと中に2段目（日付が入った名前）を作って移す。2段目の中には作れない', async () => {
    const user = userEvent.setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 12, 5, 0))
    const ids = seed()
    const cards: ID[] = []
    act(() => {
      for (const b of ['案A', '案B', '案C']) cards.push(actions.addIdea(null, '', b))
    })
    const { onMoved } = renderBulk(cards)
    await user.click(option('雨の駅'))
    expect(within(dialog()).getByTestId('idea-move-new-folder')).toHaveProperty('disabled', true)
    expect(within(dialog()).getByTestId('idea-move-new-note').textContent).toBe('3段目は作れません')
    await user.click(option('新作の相談'))
    expect(within(dialog()).queryByTestId('idea-move-new-note')).toBeNull()
    await user.click(within(dialog()).getByTestId('idea-move-new-folder'))
    const prompt = screen.getAllByRole('dialog').at(-1)!
    expect(within(prompt).getByRole('heading').textContent).toBe('『新作の相談』の中にフォルダを作る')
    const input = within(prompt).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('2026/11/12　')
    await user.type(input, '港町')
    await user.click(within(prompt).getByRole('button', { name: '作る' }))
    const made = Object.values(getData().ideaFolders).find((f) => f.name === '2026/11/12　港町')!
    expect(made).toMatchObject({ titleId: null, parentId: ids.home })
    expect(cards.map((id) => getData().ideas[id].folderId)).toEqual([made.id, made.id, made.id])
    // 全角の空白は getByText では半角にそろえられるので、知らせの文そのものを見る
    expect(toasts()).toContain('3件を「どのタイトルにも属さない › 新作の相談 › 2026/11/12\u3000港町」へ移しました')
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1))
  })

  it('仕切り（フォルダの外）を選んで新しいフォルダを作ると1段目になる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    const cards: ID[] = []
    act(() => {
      for (const b of ['案A', '案B']) cards.push(actions.addIdea(null, '', b))
    })
    renderBulk(cards)
    await user.click(option('風の街'))
    await user.click(within(dialog()).getByTestId('idea-move-new-folder'))
    const prompt = screen.getAllByRole('dialog').at(-1)!
    expect(within(prompt).getByRole('heading').textContent).toBe('フォルダを作る')
    await user.type(within(prompt).getByRole('textbox'), '新作')
    await user.click(within(prompt).getByRole('button', { name: '作る' }))
    const made = Object.values(getData().ideaFolders).find((f) => f.name === '新作')!
    expect(made).toMatchObject({ titleId: ids.other, parentId: null })
    expect(cards.map((id) => getData().ideas[id])).toMatchObject([
      { titleId: ids.other, folderId: made.id },
      { titleId: ids.other, folderId: made.id },
    ])
  })
})
