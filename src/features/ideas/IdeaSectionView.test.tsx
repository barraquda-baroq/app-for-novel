// アイデアの仕切り: 済みのチェックボックス（済みは斜線＋グレーで下へ沈む）、並べ替えは済みでないものだけ、
// 古い版の見出しは編集して保存すると内容の1行目にまとまる。
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
import { TitleIdeasTab } from '../title/ideas/TitleIdeasTab'

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

const cards = () => screen.getAllByTestId('idea-card')
/** カードの内容（済みは ✓ を付ける） */
const texts = () =>
  cards().map((c) => `${within(c).getByTestId('idea-body').textContent}${c.dataset.checked === 'true' ? '✓' : ''}`)
const card = (text: string) => cards().find((c) => c.textContent?.includes(text))!

/** jsdom には scrollIntoView が無いので、呼ばれたかだけ記録する */
const scrollIntoView = vi.fn()

beforeEach(async () => {
  localStorage.clear()
  useToasts.setState({ toasts: [] })
  scrollIntoView.mockClear()
  HTMLElement.prototype.scrollIntoView = scrollIntoView
  await initStore(createPersistence(`test-db-ideas-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  localStorage.clear()
  vi.useRealTimers()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

describe('アイデアの済み（チェック）', () => {
  it('チェックすると斜線＋グレーで済みの区切りの下へ沈み、外すと済みでないものの末尾に戻る', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      for (const body of ['案A', '案B', '案C']) actions.addIdea(titleId, '', body)
    })
    renderTab(titleId)
    expect(texts()).toEqual(['案A', '案B', '案C'])
    expect(screen.queryByTestId('idea-done-divider')).toBeNull()

    const box = within(card('案A')).getByTestId('idea-check')
    expect(box.getAttribute('aria-label')).toBe('「案A」を済みにする')
    box.focus()
    await user.click(box)
    expect(texts()).toEqual(['案B', '案C', '案A✓'])
    const done = card('案A')
    expect(done.className).toContain('is-checked')
    expect(within(done).getByTestId('idea-check')).toHaveProperty('checked', true)
    expect(within(done).getByTestId('idea-check').getAttribute('aria-label')).toBe('「案A」の済みを外す')
    // フォーカスは空いた所に来たカード（同じ側の次）のチェックボックスへ移る（動いた先は画面の外のことがある）
    expect(document.activeElement).toBe(within(card('案B')).getByTestId('idea-check'))
    // 済みのカードには並べ替えのボタンがない。済みでないものの末尾は↓を押せない
    expect(within(done).queryByTestId('idea-up')).toBeNull()
    expect(within(done).queryByTestId('idea-down')).toBeNull()
    expect(within(card('案C')).getByTestId('idea-down')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('idea-done-divider').textContent).toBe('済み 1件')
    // 件数は済みも含めた数（読み上げでは済みの数も伝える）
    const count = screen.getByTestId('idea-section-count')
    expect(count.dataset.count).toBe('3')
    expect(count.textContent).toContain('うち済み 1件')
    expect(getData().ideas[done.dataset.ideaId!]).toMatchObject({ checked: true })

    // 済みにした日時を分ける（同じミリ秒にならないように）
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1000)
    await user.click(within(card('案B')).getByTestId('idea-check'))
    // 新しく済みにしたものから
    expect(texts()).toEqual(['案C', '案B✓', '案A✓'])

    await user.click(within(card('案A')).getByTestId('idea-check'))
    expect(texts()).toEqual(['案C', '案A', '案B✓'])
    // 済みの側の末尾だったので、前（案B）へ
    expect(document.activeElement).toBe(within(card('案B')).getByTestId('idea-check'))
    expect(getData().ideas[card('案A').dataset.ideaId!]).toMatchObject({ checked: false, checkedAt: null })
    expect(within(card('案A')).getByTestId('idea-up')).toHaveProperty('disabled', false)
  })

  it('キーボードで続けて消し込める: 済みにすると空いた所に来たカードへフォーカスが移り、末尾なら前のカードへ', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      for (const body of ['案A', '案B', '案C', '案D']) actions.addIdea(titleId, '', body)
    })
    renderTab(titleId)
    const box = (text: string) => within(card(text)).getByTestId('idea-check')

    box('案A').focus()
    await user.keyboard(' ')
    expect(texts()).toEqual(['案B', '案C', '案D', '案A✓'])
    expect(document.activeElement).toBe(box('案B'))
    await user.keyboard(' ')
    expect(card('案B').dataset.checked).toBe('true')
    expect(document.activeElement).toBe(box('案C'))

    // 済みでないものの末尾（次は区切り）は前のカードへ
    box('案D').focus()
    await user.keyboard(' ')
    expect(texts().slice(0, 1)).toEqual(['案C'])
    expect(document.activeElement).toBe(box('案C'))
    expect(scrollIntoView).not.toHaveBeenCalled()

    // チェックボックスにフォーカスがない時（ほかの端末で済みにした時など）は、フォーカスを動かさない
    const outside = screen.getByTestId('idea-add')
    outside.focus()
    act(() => actions.setIdeaChecked(card('案C').dataset.ideaId!, true))
    expect(document.activeElement).toBe(outside)
  })

  it('同じ側にほかのカードがなければ、動いた先の自分のチェックボックスにフォーカスを残して見える所まで出す', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      for (const body of ['案A', '案B']) actions.addIdea(titleId, '', body)
    })
    renderTab(titleId)
    const box = (text: string) => within(card(text)).getByTestId('idea-check')
    await user.click(box('案B'))
    expect(document.activeElement).toBe(box('案A'))
    expect(scrollIntoView).not.toHaveBeenCalled()

    // 済みでないものは案Aだけ
    box('案A').focus()
    await user.keyboard(' ')
    expect(texts()).toEqual(['案A✓', '案B✓'])
    expect(document.activeElement).toBe(box('案A'))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(box('案A'))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    // 済みを外す側も同じ: 案Aを外すと空いた所に来た案Bへ。済みが案Bだけの時に外すと、案Bに残して見える所まで出す
    await user.keyboard(' ')
    expect(texts()).toEqual(['案A', '案B✓'])
    expect(document.activeElement).toBe(box('案B'))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(texts()).toEqual(['案A', '案B'])
    expect(document.activeElement).toBe(box('案B'))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView.mock.contexts[1]).toBe(box('案B'))
  })

  it('済みにした・外した時は、消えたように見えないよう通知で知らせ、移った先のカードを少しの間目立たせる', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      for (const body of ['案A', '案B', '案C']) actions.addIdea(titleId, '', body)
    })
    renderTab(titleId)
    expect(card('案A').className).not.toContain('is-revealed')

    await user.click(within(card('案A')).getByTestId('idea-check'))
    expect(texts()).toEqual(['案B', '案C', '案A✓'])
    const toast = await screen.findByText('「案A」を済みにしました（下の「済み」へ移しました）')
    // 通知は読み上げにも届く（aria-live）
    expect(toast.closest('[aria-live]')).toBeTruthy()
    expect(card('案A').className).toContain('is-revealed')
    expect(card('案B').className).not.toContain('is-revealed')

    await user.click(within(card('案A')).getByTestId('idea-check'))
    expect(texts()).toEqual(['案B', '案C', '案A'])
    expect(await screen.findByText('「案A」の済みを外しました（済みでないものの末尾へ戻しました）')).toBeTruthy()
    expect(card('案A').className).toContain('is-revealed')
  })

  it('2行以上のアイデアは1行目を少し目立たせる。1行だけのものはそのまま', () => {
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      actions.addIdea(titleId, '', '雨の駅\n来ない列車を待つ少女')
      actions.addIdea(titleId, '', '一行だけの案')
    })
    renderTab(titleId)
    expect(within(card('雨の駅')).getByTestId('idea-lead').textContent).toBe('雨の駅')
    expect(within(card('一行だけの案')).queryByTestId('idea-lead')).toBeNull()
    expect(screen.queryByTestId('idea-heading')).toBeNull()
  })
})

describe('古い版の見出し', () => {
  it('見出しのあるアイデアは保存するまで見出しのまま。編集して保存すると見出しを内容の1行目にまとめる', async () => {
    const user = userEvent.setup()
    let titleId = ''
    let ideaId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
      ideaId = actions.addIdea(titleId, '記憶を売る古書店', '客は記憶を売る。')
    })
    renderTab(titleId)
    expect(within(card('客は')).getByTestId('idea-heading').textContent).toBe('記憶を売る古書店')

    // 開いて閉じただけでは変えない
    await user.click(within(card('客は')).getByTestId('idea-edit'))
    const input = screen.getByTestId('idea-body-input') as HTMLTextAreaElement
    expect(input.value).toBe('記憶を売る古書店\n客は記憶を売る。')
    expect(screen.getByTestId('idea-heading-merged')).toBeTruthy()
    await user.click(screen.getByTestId('idea-cancel'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    expect(getData().ideas[ideaId]).toMatchObject({ heading: '記憶を売る古書店', body: '客は記憶を売る。' })

    await user.click(within(card('客は')).getByTestId('idea-edit'))
    await user.click(screen.getByTestId('idea-save'))
    await waitFor(() => expect(screen.queryByTestId('idea-editor')).toBeNull())
    expect(getData().ideas[ideaId]).toMatchObject({ heading: '', body: '記憶を売る古書店\n客は記憶を売る。' })
    expect(screen.queryByTestId('idea-heading')).toBeNull()
    expect(within(card('客は')).getByTestId('idea-lead').textContent).toBe('記憶を売る古書店')
  })

  it('追加ダイアログには見出しの入力欄がなく、内容だけで追加する', async () => {
    const user = userEvent.setup()
    let titleId = ''
    act(() => {
      titleId = actions.createTitle('星の海')
    })
    renderTab(titleId)
    await user.click(screen.getByTestId('idea-add'))
    expect(screen.queryByTestId('idea-heading-input')).toBeNull()
    await user.type(screen.getByTestId('idea-body-input'), '新しい案')
    await user.click(screen.getByTestId('idea-save'))
    const [idea] = Object.values(getData().ideas)
    expect(idea).toMatchObject({ heading: '', body: '新しい案', checked: false, checkedAt: null })
  })
})
