// カードを見せる（reveal.ts・IdeaCard の useRevealed）のは頼んだ直後だけ（2.9 の見直し）: 移した直後に入れ物が変わって描き直したカードは
// 見せるが、頼んでから1秒より後に描いたカード（ホームへ戻った・帯を閉じて開き直した）は、スクロールもフォーカスも目立たせもしない。
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
import { resetFolderCollapseForTests } from './folderCollapse'
import { REVEAL_FRESH_MS, revealIdea, useReveal } from './reveal'

let n = 0
const T0 = Date.UTC(2026, 10, 13, 3, 0)

const card = (text: string) => screen.getAllByTestId('idea-card').find((c) => c.textContent?.includes(text))!
const scrollMock = () => HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>
/** 描いた後の2回の描画（見せる時はその間にスクロールしてフォーカスする） */
const frames = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

function ideaArea(open: boolean) {
  return (
    <MemoryRouter>
      <AppFrame>
        <IdeaArea headingId="h" open={open} onToggle={() => {}} />
      </AppFrame>
    </MemoryRouter>
  )
}

async function expectNotRevealed(text: string) {
  await frames()
  expect(card(text).className).not.toContain('is-revealed')
  expect(scrollMock()).not.toHaveBeenCalled()
  expect(document.activeElement).not.toBe(card(text))
}

beforeEach(async () => {
  localStorage.clear()
  resetFolderCollapseForTests()
  useToasts.setState({ toasts: [] })
  useReveal.setState({ id: null, seq: 0, scroll: false, at: 0 })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  await initStore(createPersistence(`test-db-idea-reveal-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  localStorage.clear()
  resetFolderCollapseForTests()
  vi.useRealTimers()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

describe('カードを見せるのは頼んだ直後だけ', () => {
  it('頼んでから1秒より後に描いたカードは、スクロールもフォーカスも目立たせもしない。1秒以内なら見せる', async () => {
    let a: ID = ''
    act(() => {
      a = actions.addIdea(null, '', '灯台の案')
      actions.addIdea(null, '', 'ほかの案')
    })
    act(() => revealIdea(a, true))
    vi.setSystemTime(T0 + REVEAL_FRESH_MS + 1)
    const view = render(ideaArea(true))
    await expectNotRevealed('灯台の案')
    view.unmount()

    // 1秒以内に描いたカード（頼んだのと同じ時に描き直したもの）は見せる
    act(() => revealIdea(a, true))
    vi.setSystemTime(T0 + REVEAL_FRESH_MS + 1 + 500)
    render(ideaArea(true))
    expect(card('灯台の案').className).toContain('is-revealed')
    expect(card('ほかの案').className).not.toContain('is-revealed')
    await waitFor(() => expect(scrollMock().mock.contexts).toEqual([card('灯台の案')]))
    expect(scrollMock()).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))
    expect(document.activeElement).toBe(card('灯台の案'))
  })

  it('移した直後は、入れ物が変わって描き直したカードを見せる。帯を閉じて開き直した時・描き直した時は、もう一度は見せない', async () => {
    const user = userEvent.setup()
    let a: ID = ''
    let home: ID = ''
    act(() => {
      home = actions.createIdeaFolder(null, null, '新作の相談')
      a = actions.addIdea(null, '', '灯台の案')
      actions.addIdea(null, '', 'ほかの案')
    })
    const view = render(ideaArea(true))
    const before = card('灯台の案')
    await user.click(within(before).getByTestId('idea-move'))
    const target = within(screen.getByRole('dialog'))
      .getAllByTestId('idea-move-option')
      .find((o) => o.dataset.folder === home)!
    await user.click(target)
    await user.click(screen.getByTestId('idea-move-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(getData().ideas[a].folderId).toBe(home)
    // フォルダの中で描き直した（前の要素とは別の）カードを見せる
    expect(card('灯台の案')).not.toBe(before)
    expect(card('灯台の案').className).toContain('is-revealed')
    await waitFor(() => expect(scrollMock().mock.contexts).toEqual([card('灯台の案')]))
    expect(document.activeElement).toBe(card('灯台の案'))

    // 少したってから、帯を閉じて開き直す（ホームへ戻った時と同じく、カードを描き直す）
    vi.setSystemTime(T0 + 3000)
    ;(document.activeElement as HTMLElement).blur()
    scrollMock().mockClear()
    view.rerender(ideaArea(false))
    expect(screen.queryAllByTestId('idea-card')).toHaveLength(0)
    view.rerender(ideaArea(true))
    await expectNotRevealed('灯台の案')
    view.unmount()
    render(ideaArea(true))
    await expectNotRevealed('灯台の案')
    // 頼んだ時の記録は残っている（ほかのカードを見せるまで）。それでも見せない
    expect(useReveal.getState()).toMatchObject({ id: a, scroll: true })
  })
})
