// フォルダの移動のダイアログ（2.9。メニューの「移動…」）: 仕切りごとの「1段目にする」とほかの1段目、現在の場所の印、
// 中にフォルダのあるフォルダはフォルダの中へ移せない、仕切りが変わる時のまとめ、移す先の同じ名前、移した後の知らせと見出し。
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { IdeaArea } from '../home/IdeaArea'
import { resetFolderCollapseForTests } from './folderCollapse'
import { FOLDER_HAS_SUBFOLDERS } from './IdeaFolderMoveDialog'

let n = 0

const folder = (name: string) =>
  screen
    .getAllByTestId('idea-folder')
    .find((f) => f.querySelector(':scope > .idea-folder-head [data-testid="idea-folder-name"]')?.textContent === name)!
const head = (name: string) => folder(name).querySelector<HTMLElement>(':scope > .idea-folder-head')!
const dialog = () => screen.getByTestId('idea-folder-move-dialog').closest<HTMLElement>('[role="dialog"]')!
const rows = () =>
  within(dialog())
    .getAllByTestId('idea-folder-move-option')
    .map((o) => {
      const input = o.querySelector('input')!
      return `${o.className.includes('is-depth-1') ? '  ' : ''}${o.textContent}${input.disabled ? '（選べない）' : ''}`
    })
const row = (text: string) =>
  within(dialog())
    .getAllByTestId('idea-folder-move-option')
    .find((o) => [text, `${text}（1段目にする）`].includes(o.querySelector('.idea-move-name')?.textContent ?? ''))!

async function openMove(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(head(name)).getByTestId('idea-folder-menu'))
  await user.click(screen.getByTestId('idea-folder-move'))
}

beforeEach(async () => {
  localStorage.clear()
  resetFolderCollapseForTests()
  useToasts.setState({ toasts: [] })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  await initStore(createPersistence(`test-db-idea-folder-move-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  localStorage.clear()
  resetFolderCollapseForTests()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

function seed() {
  const ids = { title: '', top: '', sub: '', people: '', home: '', homeSub: '' }
  act(() => {
    ids.title = actions.createTitle('星の庭')
    ids.top = actions.createIdeaFolder(ids.title, null, '場面の相談')
    ids.sub = actions.createIdeaFolder(ids.title, ids.top, '雨の駅')
    ids.people = actions.createIdeaFolder(ids.title, null, '人物の相談')
    ids.home = actions.createIdeaFolder(null, null, '新作の相談')
    ids.homeSub = actions.createIdeaFolder(null, ids.home, '2026/11/12　港町')
    for (const b of ['駅の案1', '駅の案2', '駅の案3', '駅の案4', '駅の案5']) actions.addIdea(ids.title, '', b, ids.sub)
    actions.addIdea(null, '', '港町の案', ids.homeSub)
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

describe('フォルダを移す', () => {
  it('移動先は仕切りごとの「1段目にする」と、自分以外の1段目。今の場所に印。ほかの1段目の中へ移すと、中のカードも一緒に移る', async () => {
    const user = userEvent.setup()
    const ids = seed()
    await openMove(user, '雨の駅')
    expect(within(dialog()).getByRole('heading').textContent).toBe('フォルダを移動')
    expect(rows()).toEqual([
      '星の庭（1段目にする）',
      '  人物の相談',
      '  場面の相談現在の場所',
      'どのタイトルにも属さない（1段目にする）',
      '  新作の相談',
    ])
    expect(within(dialog()).getByTestId('idea-folder-move-submit')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe('現在の位置です。移動先か位置を選んでください。')
    await user.click(row('人物の相談'))
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe(
      '「雨の駅」を「人物の相談」の中の先頭に移します（中のカード 5件も一緒に移ります）',
    )
    await user.click(within(dialog()).getByTestId('idea-folder-move-submit'))
    expect(getData().ideaFolders[ids.sub]).toMatchObject({ titleId: ids.title, parentId: ids.people })
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('「雨の駅」を「人物の相談」へ移しました')
    await waitFor(() => expect(document.activeElement).toBe(within(head('雨の駅')).getByTestId('idea-folder-toggle')))
    expect(folder('雨の駅').parentElement?.closest('[data-testid="idea-folder"]')).toBe(folder('人物の相談'))
  })

  it('ほかの仕切りへ移すと、そのことを添える。1段目にもできる（位置は兄弟の中で選べる。既定は先頭）', async () => {
    const user = userEvent.setup()
    const ids = seed()
    await openMove(user, '雨の駅')
    await user.click(row('新作の相談'))
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe(
      '「雨の駅」を「新作の相談」の中の先頭（「2026/11/12　港町」の前）に移します（中のカード 5件も一緒に移ります）（「どのタイトルにも属さない」へ移ります）',
    )
    await user.click(row('星の庭'))
    const position = within(dialog()).getByTestId('idea-folder-move-position') as HTMLSelectElement
    expect(Array.from(position.options).map((o) => o.textContent)).toEqual([
      '先頭（「人物の相談」の前）',
      '「人物の相談」の後',
      '末尾（「場面の相談」の後）',
    ])
    await user.selectOptions(position, '2')
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe(
      '「雨の駅」を「星の庭」の1段目の末尾（「場面の相談」の後）に移します（中のカード 5件も一緒に移ります）',
    )
    await user.click(within(dialog()).getByTestId('idea-folder-move-submit'))
    expect(getData().ideaFolders[ids.sub]).toMatchObject({ titleId: ids.title, parentId: null })
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('「雨の駅」を「星の庭」の1段目へ移しました')
  })

  it('タイトルの仕切りへ移す時は「（タイトル『星の庭』へ移ります）」。中のカードも、そのタイトルへ移る', async () => {
    const user = userEvent.setup()
    const ids = seed()
    await openMove(user, '2026/11/12　港町')
    await user.click(row('場面の相談'))
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toContain('（タイトル『星の庭』へ移ります）')
    await user.click(within(dialog()).getByTestId('idea-folder-move-submit'))
    expect(getData().ideaFolders[ids.homeSub]).toMatchObject({ titleId: ids.title, parentId: ids.top })
    const moved = Object.values(getData().ideas).find((i) => i.body === '港町の案')!
    expect(moved).toMatchObject({ titleId: ids.title, folderId: ids.homeSub })
  })

  it('中にフォルダのあるフォルダは、フォルダの中へは移せない（3段目は作れない）。1段目のまま、ほかの仕切りへは移せる', async () => {
    const user = userEvent.setup()
    const ids = seed()
    await openMove(user, '場面の相談')
    expect(within(dialog()).getByTestId('idea-folder-move-note').textContent).toBe(FOLDER_HAS_SUBFOLDERS)
    expect(rows()).toEqual([
      '星の庭（1段目にする）現在の場所',
      '  人物の相談（選べない）',
      'どのタイトルにも属さない（1段目にする）',
      '  新作の相談（選べない）',
    ])
    await user.click(row('どのタイトルにも属さない'))
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe(
      '「場面の相談」を「どのタイトルにも属さない」の1段目の先頭（「新作の相談」の前）に移します（中のフォルダ1つと中のカード 5件も一緒に移ります）（「どのタイトルにも属さない」へ移ります）',
    )
    await user.click(within(dialog()).getByTestId('idea-folder-move-submit'))
    expect(getData().ideaFolders[ids.top]).toMatchObject({ titleId: null, parentId: null })
    expect(getData().ideaFolders[ids.sub]).toMatchObject({ titleId: null, parentId: ids.top })
  })

  it('移す先に同じ名前のフォルダがあれば、移させない', async () => {
    const user = userEvent.setup()
    act(() => {
      const t = actions.createTitle('星の庭')
      const top = actions.createIdeaFolder(t, null, '場面の相談')
      // 字の幅・空白の違いは同じ名前（folderNameKey）
      actions.createIdeaFolder(t, top, 'ｱﾒの  駅')
      actions.createIdeaFolder(t, null, 'アメの　駅')
    })
    render(
      <MemoryRouter>
        <AppFrame>
          <IdeaArea headingId="h" />
        </AppFrame>
      </MemoryRouter>,
    )
    await openMove(user, 'ｱﾒの 駅')
    await user.click(row('星の庭'))
    expect(screen.getByTestId('idea-folder-move-summary').textContent).toBe('移す先に同じ名前のフォルダがあります。')
    expect(within(dialog()).getByTestId('idea-folder-move-submit')).toHaveProperty('disabled', true)
  })
})
