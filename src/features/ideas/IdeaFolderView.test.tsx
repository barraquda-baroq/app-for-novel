// アイデアのフォルダ（2.9）の画面: フォルダ → 済みでないカード → 済み の順（入れ物ごと）、開け閉めはフォルダごとに別の鍵で覚える、
// 「Claude が作成」の印、作る・名前を変える・削除のダイアログ、段ごとのメニュー、空のフォルダ、フォルダにアイデアを足す、並べ替え。
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID, IdeaFolder } from '../../domain/types'
import { actions } from '../../store/actions'
import { commit, getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { AppFrame } from '../../ui/Layout'
import { IdeaArea } from '../home/IdeaArea'
import { TitleIdeasTab } from '../title/ideas/TitleIdeasTab'
import { FOLDER_COLLAPSED_KEY, resetFolderCollapseForTests } from './folderCollapse'
import { COLLAPSED_KEY } from './storage'

let n = 0

function renderTab(titleId: ID) {
  return render(
    <MemoryRouter initialEntries={[`/t/${titleId}?tab=ideas`]}>
      <AppFrame>
        <TitleIdeasTab titleId={titleId} />
      </AppFrame>
    </MemoryRouter>,
  )
}

function renderHomeIdeas() {
  return render(
    <MemoryRouter>
      <AppFrame>
        <IdeaArea headingId="ideas-heading" />
      </AppFrame>
    </MemoryRouter>,
  )
}

const folders = () => screen.getAllByTestId('idea-folder')
const folder = (name: string) => folders().find((f) => within(f).getAllByTestId('idea-folder-name')[0].textContent === name)!
const head = (name: string) => folder(name).querySelector<HTMLElement>(':scope > .idea-folder-head')!
const toggle = (name: string) => within(head(name)).getByTestId('idea-folder-toggle')
const cardTexts = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLElement>(':scope > .idea-folder-body > .idea-list > [data-testid="idea-card"]')).map(
    (c) => `${within(c).getByTestId('idea-body').textContent}${c.dataset.checked === 'true' ? '✓' : ''}`,
  )
const dialog = () => screen.getByRole('dialog')

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(head(name)).getByTestId('idea-folder-menu'))
  return screen.getByTestId('idea-folder-menu-popup')
}

beforeEach(async () => {
  localStorage.clear()
  resetFolderCollapseForTests()
  useToasts.setState({ toasts: [] })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  await initStore(createPersistence(`test-db-idea-folders-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  localStorage.clear()
  resetFolderCollapseForTests()
  vi.useRealTimers()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

/** タイトル「星の庭」に 場面の相談（1段目）＞雨の駅（2段目）と、フォルダの外のカード */
function seedTree() {
  let titleId = ''
  let top = ''
  let sub = ''
  act(() => {
    titleId = actions.createTitle('星の庭')
    top = actions.createIdeaFolder(titleId, null, '場面の相談')
    sub = actions.createIdeaFolder(titleId, top, '雨の駅')
    actions.addIdea(titleId, '', '外の案A')
    actions.addIdea(titleId, '', '外の案B')
    actions.addIdea(titleId, '', '相談の案1', top)
    actions.addIdea(titleId, '', '相談の案2', top)
    actions.addIdea(titleId, '', '駅の案1', sub)
    actions.addIdea(titleId, '', '駅の案2', sub)
  })
  return { titleId, top, sub }
}

describe('フォルダの木', () => {
  it('どの段でもフォルダが上、フォルダの外のカードがその下。済みは入れ物ごとに下へ沈み、件数は下のすべてのカード', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTree()
    renderTab(titleId)
    const section = screen.getByTestId('idea-section')
    const body = section.querySelector('.idea-section-body')!
    // 道具の行 → フォルダ → フォルダの外のカード
    expect(Array.from(body.children).map((c) => c.className)).toEqual(['idea-section-tools', 'idea-folders', 'idea-list'])
    expect(folders().map((f) => [within(f).getAllByTestId('idea-folder-name')[0].textContent, f.dataset.depth])).toEqual([
      ['場面の相談', '1'],
      ['雨の駅', '2'],
    ])
    // 2段目は1段目の中にあり、1段目のカードより上
    const topBody = folder('場面の相談').querySelector(':scope > .idea-folder-body')!
    expect(Array.from(topBody.children).map((c) => c.className)).toEqual(['idea-folders', 'idea-list'])
    expect(cardTexts(folder('場面の相談'))).toEqual(['相談の案1', '相談の案2'])
    expect(cardTexts(folder('雨の駅'))).toEqual(['駅の案1', '駅の案2'])
    // 件数: 仕切りはすべて、1段目は中のフォルダのカードも
    expect(screen.getByTestId('idea-section-count').dataset.count).toBe('6')
    expect(within(head('場面の相談')).getByTestId('idea-folder-count').dataset.count).toBe('4')
    expect(within(head('雨の駅')).getByTestId('idea-folder-count').dataset.count).toBe('2')

    // フォルダの中で済みにすると、そのフォルダの中で下へ沈む（区切りもそのフォルダの中）
    const card = (text: string) => screen.getAllByTestId('idea-card').find((c) => c.textContent?.includes(text))!
    await user.click(within(card('駅の案1')).getByTestId('idea-check'))
    expect(cardTexts(folder('雨の駅'))).toEqual(['駅の案2', '駅の案1✓'])
    expect(within(folder('雨の駅')).getByTestId('idea-done-divider').textContent).toBe('済み 1件')
    expect(
      within(folder('場面の相談').querySelector(':scope > .idea-folder-body > .idea-list')!).queryByTestId('idea-done-divider'),
    ).toBeNull()
    expect(within(head('場面の相談')).getByTestId('idea-folder-count').getAttribute('title')).toBe('4件（うち済み 1件）')
    expect(within(head('雨の駅')).getByTestId('idea-folder-count').getAttribute('title')).toBe('2件（うち済み 1件）')
    // 並べ替えの端は入れ物ごと
    expect(within(card('相談の案1')).getByTestId('idea-up')).toHaveProperty('disabled', true)
    expect(within(card('相談の案2')).getByTestId('idea-down')).toHaveProperty('disabled', true)
    expect(within(card('外の案A')).getByTestId('idea-up')).toHaveProperty('disabled', true)
    expect(within(card('駅の案2')).getByTestId('idea-down')).toHaveProperty('disabled', true)
    // ↑↓ はそのフォルダの中だけで動かす
    await user.click(within(card('相談の案2')).getByTestId('idea-up'))
    expect(cardTexts(folder('場面の相談'))).toEqual(['相談の案2', '相談の案1'])
  })

  it('「まだアイデアはありません。」はカードもフォルダも無い時だけ。空のフォルダは「まだカードはありません。」から足せる', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の庭')
    })
    renderTab(titleId)
    expect(screen.getByTestId('idea-section-empty')).toBeTruthy()
    let id = ''
    act(() => {
      id = actions.createIdeaFolder(titleId, null, '新作の相談')
    })
    expect(screen.queryByTestId('idea-section-empty')).toBeNull()
    const empty = within(folder('新作の相談')).getByTestId('idea-folder-empty')
    expect(empty.textContent).toContain('まだカードはありません。')
    await user.click(empty)
    // 追加先は場所の表記（仕切り › フォルダ）
    expect(within(dialog()).getByText('星の庭 › 新作の相談')).toBeTruthy()
    await user.type(screen.getByTestId('idea-body-input'), '港町の話')
    await user.click(screen.getByTestId('idea-save'))
    const [idea] = Object.values(getData().ideas)
    expect(idea).toMatchObject({ titleId, folderId: id, body: '港町の話' })
    expect(await screen.findByText('「新作の相談」にアイデアを追加しました')).toBeTruthy()
    expect(within(folder('新作の相談')).queryByTestId('idea-folder-empty')).toBeNull()
  })

  it('［＋］でフォルダにアイデアを足す: 場所は「星の庭 › 場面の相談 › 雨の駅」、下書きはフォルダごと（new:f:<id>）。閉じていれば開いて見せる', async () => {
    const user = userEvent.setup()
    const { titleId, top, sub } = seedTree()
    renderTab(titleId)
    await user.click(toggle('雨の駅'))
    expect(toggle('雨の駅').getAttribute('aria-expanded')).toBe('false')
    await user.click(within(head('雨の駅')).getByTestId('idea-folder-add'))
    expect(within(head('雨の駅')).getByTestId('idea-folder-add').getAttribute('aria-label')).toBe('『雨の駅』にアイデアを追加')
    expect(within(dialog()).getByText('星の庭 › 場面の相談 › 雨の駅')).toBeTruthy()
    await user.type(screen.getByTestId('idea-body-input'), '書きかけ')
    expect(localStorage.getItem(`novel-studio:idea-modal-draft:new:f:${sub}`)).toContain('書きかけ')
    await user.click(screen.getByTestId('idea-save'))
    const added = Object.values(getData().ideas).find((i) => i.body === '書きかけ')!
    expect(added).toMatchObject({ titleId, folderId: sub })
    expect(localStorage.getItem(`novel-studio:idea-modal-draft:new:f:${sub}`)).toBeNull()
    expect(toggle('雨の駅').getAttribute('aria-expanded')).toBe('true')
    expect(cardTexts(folder('雨の駅'))).toEqual(['駅の案1', '駅の案2', '書きかけ'])
    // 編集ダイアログの「場所」もフォルダのつながり
    const card = screen.getAllByTestId('idea-card').find((c) => c.textContent?.includes('相談の案1'))!
    await user.click(within(card).getByTestId('idea-edit'))
    expect(within(dialog()).getByText('星の庭 › 場面の相談')).toBeTruthy()
    void top
  })
})

describe('開け閉め', () => {
  it('フォルダごとに別の鍵で覚え、仕切りの「すべて折りたたむ／開く」では消えない。読み込み直しても閉じたまま', async () => {
    const user = userEvent.setup()
    const { top, sub } = seedTree()
    act(() => {
      actions.addIdea(null, '', 'ホームの案')
    })
    const view = renderHomeIdeas()
    await user.click(toggle('雨の駅'))
    expect(toggle('雨の駅').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('雨の駅').getAttribute('aria-controls')).toBeNull()
    expect(toggle('雨の駅').getAttribute('aria-label')).toBe('『雨の駅』を開く')
    expect(toggle('場面の相談').getAttribute('aria-label')).toBe('『場面の相談』を折りたたむ')
    expect(toggle('場面の相談').getAttribute('aria-controls')).toBe(folder('場面の相談').querySelector('.idea-folder-body')!.id)
    expect(folder('雨の駅').querySelector<HTMLElement>('.idea-folder-body')!.hidden).toBe(true)
    expect(JSON.parse(localStorage.getItem(FOLDER_COLLAPSED_KEY)!)).toEqual([sub])

    await user.click(screen.getByTestId('idea-collapse-all'))
    await user.click(screen.getByTestId('idea-expand-all'))
    expect(localStorage.getItem(COLLAPSED_KEY)).toBeNull()
    expect(toggle('雨の駅').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('場面の相談').getAttribute('aria-expanded')).toBe('true')

    // 読み込み直し（覚えた状態から始める）
    view.unmount()
    resetFolderCollapseForTests()
    renderHomeIdeas()
    expect(toggle('雨の駅').getAttribute('aria-expanded')).toBe('false')
    // もう無いフォルダは、次に保存する時に除く
    localStorage.setItem(FOLDER_COLLAPSED_KEY, JSON.stringify(['gone', sub]))
    resetFolderCollapseForTests()
    await user.click(toggle('場面の相談'))
    expect(JSON.parse(localStorage.getItem(FOLDER_COLLAPSED_KEY)!)).toEqual([sub, top])
  })

  it('タイトルの「アイデア」でも開け閉めでき、ホームと同じ状態を使う', async () => {
    const user = userEvent.setup()
    const { titleId, top } = seedTree()
    renderTab(titleId)
    // タイトルの「アイデア」の仕切りは閉じられない
    expect(screen.queryByTestId('idea-section-toggle')).toBeNull()
    await user.click(toggle('場面の相談'))
    expect(JSON.parse(localStorage.getItem(FOLDER_COLLAPSED_KEY)!)).toEqual([top])
    // 閉じた1段目の中（2段目とカード）は見えない
    expect(folder('場面の相談').querySelector<HTMLElement>(':scope > .idea-folder-body')!.hidden).toBe(true)
    cleanup()
    renderHomeIdeas()
    expect(toggle('場面の相談').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('「Claude が作成」の印', () => {
  function putFolder(f: Partial<IdeaFolder> & Pick<IdeaFolder, 'id' | 'name'>) {
    const data = getData()
    const folder: IdeaFolder = { titleId: null, parentId: null, order: 0, createdAt: 1, updatedAt: 1, ...f }
    commit({ ...data, ideaFolders: { ...data.ideaFolders, [f.id]: folder } })
  }

  it('印は id が cf-… で source が claude のフォルダだけ（狭い画面ではアイコンだけ）。名前を変えても残る', async () => {
    const user = userEvent.setup()
    act(() => {
      putFolder({ id: 'cf-abc.1', name: '2026/11/12　港町', source: 'claude', v: 1, order: 0 })
      putFolder({ id: '6f1c1c9e-0000-4000-8000-000000000001', name: '形だけ似せた', source: 'claude', order: 1 })
      putFolder({ id: 'cf-def.2', name: 'source の無い', order: 2 })
    })
    renderHomeIdeas()
    const badge = within(head('2026/11/12　港町')).getByTestId('idea-folder-by')
    expect(badge.textContent).toBe('Claude が作成')
    expect(badge.getAttribute('title')).toBe('Claude がコネクタで作ったフォルダ')
    expect(badge.className).toContain('is-compact')
    expect(badge.className).toContain('badge')
    expect(within(head('形だけ似せた')).queryByTestId('idea-folder-by')).toBeNull()
    expect(within(head('source の無い')).queryByTestId('idea-folder-by')).toBeNull()

    await openMenu(user, '2026/11/12　港町')
    await user.click(screen.getByTestId('idea-folder-rename'))
    const input = within(dialog()).getByRole('textbox')
    await user.clear(input)
    await user.type(input, '港町の新作')
    await user.click(within(dialog()).getByRole('button', { name: '変更' }))
    expect(getData().ideaFolders['cf-abc.1']).toMatchObject({ name: '港町の新作', source: 'claude' })
    expect(within(head('港町の新作')).getByTestId('idea-folder-by')).toBeTruthy()
  })
})

describe('フォルダを作る・名前を変える・削除する', () => {
  it('［＋ フォルダ］: 上に入り、開いて見出しにフォーカスする。同じ名前（字の幅・空白の違いも）は作らせない。ホームでは Claude に見える説明', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の庭')
      actions.createIdeaFolder(titleId, null, '新作の相談')
    })
    renderTab(titleId)
    const create = screen.getByTestId('idea-folder-create')
    expect(create.getAttribute('aria-label')).toBe('『星の庭』にフォルダを作る')
    await user.click(create)
    expect(within(dialog()).getByRole('heading').textContent).toBe('フォルダを作る')
    expect(within(dialog()).getByText('フォルダの名前（40字まで）')).toBeTruthy()
    const input = within(dialog()).getByRole('textbox') as HTMLInputElement
    expect(input.placeholder).toBe('例: 新作の相談')
    // タイトルのフォルダには Claude に見える説明は出さない
    expect(within(dialog()).queryByText(/Claude にも見えます/)).toBeNull()
    const ok = within(dialog()).getByRole('button', { name: '作る' })
    expect(ok).toHaveProperty('disabled', true)
    expect(within(dialog()).queryByTestId('prompt-problem')).toBeNull()
    await user.type(input, '新作の相談')
    expect(within(dialog()).getByTestId('prompt-problem').textContent).toBe('同じ名前のフォルダがもうあります')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(ok).toHaveProperty('disabled', true)
    await user.clear(input)
    await user.type(input, 'ｓｆ　の  相談')
    expect(ok).toHaveProperty('disabled', false)
    await user.clear(input)
    await user.type(input, '場面の相談')
    await user.click(ok)
    expect(folders().map((f) => within(f).getAllByTestId('idea-folder-name')[0].textContent)).toEqual([
      '場面の相談',
      '新作の相談',
    ])
    expect(await screen.findByText('フォルダ「場面の相談」を作りました')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(toggle('場面の相談')))
    expect(toggle('場面の相談').getAttribute('aria-expanded')).toBe('true')
    // 41字は作らせない
    await user.click(screen.getByTestId('idea-folder-create'))
    await user.type(within(dialog()).getByRole('textbox'), 'あ'.repeat(41))
    expect(within(dialog()).getByTestId('prompt-problem').textContent).toBe('フォルダの名前は40字までです')
    await user.click(within(dialog()).getByRole('button', { name: 'キャンセル' }))
  })

  it('ホームの［＋ フォルダ］は、フォルダの名前が Claude にも見えることを添える', async () => {
    const user = userEvent.setup()
    renderHomeIdeas()
    await user.click(screen.getByTestId('idea-folder-create'))
    expect(screen.getByTestId('idea-folder-create').getAttribute('aria-label')).toBe(
      '『どのタイトルにも属さない』にフォルダを作る',
    )
    expect(
      within(dialog()).getByText(
        'どのタイトルにも属さないフォルダの名前は、Claude と連携していると Claude にも見えます（作者が書いたカードの中身は見えません）',
      ),
    ).toBeTruthy()
    await user.type(within(dialog()).getByRole('textbox'), '新作の相談')
    await user.click(within(dialog()).getByRole('button', { name: '作る' }))
    expect(Object.values(getData().ideaFolders)).toMatchObject([{ titleId: null, parentId: null, name: '新作の相談' }])
  })

  it('「この中にフォルダを作る」: 名前の初期値は今日の日付と全角の空白（カーソルはその後ろ）。閉じていた親は開く', async () => {
    const user = userEvent.setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 12, 15, 30))
    const { titleId, top } = seedTree()
    renderTab(titleId)
    await user.click(toggle('場面の相談'))
    await openMenu(user, '場面の相談')
    await user.click(screen.getByTestId('idea-folder-new-sub'))
    expect(within(dialog()).getByRole('heading').textContent).toBe('『場面の相談』の中にフォルダを作る')
    const input = within(dialog()).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('2026/11/13　')
    expect(input.placeholder).toBe('例: 2026/11/13　港町')
    expect([input.selectionStart, input.selectionEnd]).toEqual([11, 11])
    await user.type(input, '港町')
    await user.click(within(dialog()).getByRole('button', { name: '作る' }))
    const made = Object.values(getData().ideaFolders).find((f) => f.name === '2026/11/13　港町')!
    expect(made).toMatchObject({ titleId, parentId: top })
    expect(toggle('場面の相談').getAttribute('aria-expanded')).toBe('true')
    // 新しい2段目は兄弟（雨の駅）の上
    const subs = folder('場面の相談').querySelectorAll(':scope > .idea-folder-body > .idea-folders > [data-testid="idea-folder"]')
    expect(Array.from(subs).map((f) => (f as HTMLElement).dataset.folderId)).toEqual([made.id, expect.any(String)])
  })

  it('メニュー: 1段目には「この中にフォルダを作る」があり、2段目には無い。上へ・下へは端で押せない', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTree()
    act(() => {
      actions.createIdeaFolder(titleId, null, '人物の相談')
    })
    renderTab(titleId)
    const ids = (menu: HTMLElement) =>
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => `${b.dataset.testid}${b.getAttribute('aria-disabled') ? '（押せない）' : ''}`)
    let menu = await openMenu(user, '人物の相談')
    expect(menu.getAttribute('aria-label')).toBe('『人物の相談』の操作')
    expect(within(head('人物の相談')).getByTestId('idea-folder-menu').getAttribute('aria-haspopup')).toBe('menu')
    expect(ids(menu)).toEqual([
      'idea-folder-new-sub',
      'idea-folder-rename',
      'idea-folder-up（押せない）',
      'idea-folder-down',
      'idea-folder-move',
      'idea-folder-delete',
    ])
    await user.keyboard('{Escape}')
    menu = await openMenu(user, '雨の駅')
    expect(ids(menu)).toEqual([
      'idea-folder-rename',
      'idea-folder-up（押せない）',
      'idea-folder-down（押せない）',
      'idea-folder-move',
      'idea-folder-delete',
    ])
    await user.keyboard('{Escape}')
    // 見出しの右クリックでも同じメニュー
    await user.pointer({ keys: '[MouseRight]', target: toggle('場面の相談') })
    expect(ids(screen.getByTestId('idea-folder-menu-popup'))[0]).toBe('idea-folder-new-sub')
  })

  it('上へ・下へ: 同じ入れ物のフォルダの中で動かす', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTree()
    act(() => {
      actions.createIdeaFolder(titleId, null, '人物の相談')
    })
    renderTab(titleId)
    const topNames = () =>
      Array.from(screen.getByTestId('idea-folders').querySelectorAll<HTMLElement>(':scope > [data-testid="idea-folder"]')).map(
        (f) => within(f).getAllByTestId('idea-folder-name')[0].textContent,
      )
    expect(topNames()).toEqual(['人物の相談', '場面の相談'])
    await openMenu(user, '人物の相談')
    await user.click(screen.getByTestId('idea-folder-down'))
    expect(topNames()).toEqual(['場面の相談', '人物の相談'])
    // メニューを開いた［…］にフォーカスが戻る（続けて操作できる）
    await waitFor(() => expect(document.activeElement).toBe(within(head('人物の相談')).getByTestId('idea-folder-menu')))
    await openMenu(user, '人物の相談')
    await user.click(screen.getByTestId('idea-folder-up'))
    expect(topNames()).toEqual(['人物の相談', '場面の相談'])
  })

  it('名前を変える: 今の名前を選んだ状態で開き、同じ入れ物の同じ名前は断る（自分は除く）', async () => {
    const user = userEvent.setup()
    const { titleId, top } = seedTree()
    act(() => {
      actions.createIdeaFolder(titleId, null, '人物の相談')
    })
    renderTab(titleId)
    await openMenu(user, '場面の相談')
    await user.click(screen.getByTestId('idea-folder-rename'))
    expect(within(dialog()).getByRole('heading').textContent).toBe('フォルダの名前を変える')
    const input = within(dialog()).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('場面の相談')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
    const ok = within(dialog()).getByRole('button', { name: '変更' })
    // 自分の名前のままなら断らない（書き込まない）
    expect(ok).toHaveProperty('disabled', false)
    await user.clear(input)
    await user.type(input, '人物の相談')
    expect(within(dialog()).getByTestId('prompt-problem').textContent).toBe('同じ名前のフォルダがもうあります')
    // 2段目の名前（別の入れ物）とは同じでもよい
    await user.clear(input)
    await user.type(input, '雨の駅')
    expect(within(dialog()).queryByTestId('prompt-problem')).toBeNull()
    await user.click(ok)
    expect(getData().ideaFolders[top].name).toBe('雨の駅')
  })

  it('削除: 中のフォルダとカードの数を添えて確かめ、ゴミ箱の1件にする。フォーカスは次のフォルダの見出しへ', async () => {
    const user = userEvent.setup()
    const { titleId, top } = seedTree()
    act(() => {
      actions.createIdeaFolder(titleId, null, '人物の相談')
    })
    renderTab(titleId)
    await openMenu(user, '人物の相談')
    await user.click(screen.getByTestId('idea-folder-delete'))
    expect(within(dialog()).getByRole('heading').textContent).toBe('フォルダを削除しますか？')
    expect(within(dialog()).getByText(/^フォルダ「人物の相談」をゴミ箱に移します。30日後に/)).toBeTruthy()
    await user.click(within(dialog()).getByRole('button', { name: 'キャンセル' }))

    await openMenu(user, '場面の相談')
    await user.click(screen.getByTestId('idea-folder-delete'))
    expect(
      within(dialog()).getByText(
        'フォルダ「場面の相談」と、中のフォルダ1つ・カード4件をゴミ箱に移します。30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。',
      ),
    ).toBeTruthy()
    await user.click(within(dialog()).getByRole('button', { name: '削除' }))
    expect(getData().ideaFolders[top]).toBeUndefined()
    expect(Object.values(getData().trashEntries)).toMatchObject([{ kind: 'ideaFolder', label: '場面の相談' }])
    expect(Object.keys(getData().ideaFolders)).toHaveLength(1)
    expect(Object.values(getData().ideas).map((i) => i.body)).toEqual(['外の案A', '外の案B'])
    expect(await screen.findByText('フォルダ「場面の相談」をゴミ箱に移しました')).toBeTruthy()
    // 次（下）の兄弟が無いので前の兄弟へ
    await waitFor(() => expect(document.activeElement).toBe(toggle('人物の相談')))
  })

  it('最後のフォルダを削除すると、フォーカスは仕切りの見出しへ（タイトルの「アイデア」では［＋ フォルダ］へ）', async () => {
    const user = userEvent.setup()
    act(() => {
      actions.createIdeaFolder(null, null, '新作の相談')
    })
    renderHomeIdeas()
    await openMenu(user, '新作の相談')
    await user.click(screen.getByTestId('idea-folder-delete'))
    await user.click(within(dialog()).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('idea-section-toggle')))
  })
})
