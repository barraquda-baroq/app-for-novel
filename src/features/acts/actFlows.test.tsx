// セパレート（幕）の操作の確認: 操作する幕・話に保存されていない編集の控えがあれば、先にそれを伝える
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { cancelAllDialogs, DialogHost } from '../../ui/dialogs'
import { ownerLockName, writeCrashDraft } from '../piece/crashDraft'
import { versionField } from '../piece/session'
import { confirmJoin, confirmPendingDrafts, confirmUnseparate, NOTE_CARRY_NOTICE } from './actFlows'

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-act-flows-${++n}`))
})

afterEach(() => {
  cancelAllDialogs()
  cleanup()
  resetStoreForTests()
  useToasts.setState({ toasts: [] })
  Reflect.deleteProperty(navigator, 'locks')
  localStorage.clear()
})

/** 'AAABBBCCC' を3幕に分けた第1話 */
function seed(): { titleId: ID; pieceId: ID; acts: ID[] } {
  const titleId = actions.createTitle('作品')
  const pieceId = actions.addEpisode(titleId)
  actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: 'AAABBBCCC' })
  const acts = actions.separatePiece(pieceId, [3, 6])
  return { titleId, pieceId, acts }
}

/** 幕 actId の採用稿の本文に、保存されていない編集の控えを書く */
function draftOn(actId: ID, owner: string) {
  const vid = getData().pieces[actId].activeVersionId!
  const body = getData().versions[vid].body
  writeCrashDraft(actId, { [versionField(vid, 'body')]: { base: body, value: `${body}（未保存）` } }, owner)
}

/** 別のタブが持っている（開いている）控えの持ち主のロックを、Web Locks の代わりに用意する */
function fakeLocks(heldOwners: string[]) {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: () => new Promise(() => {}),
      query: async () => ({ held: heldOwners.map((o) => ({ name: ownerLockName(o), mode: 'exclusive' })), pending: [] }),
    },
  })
}

const press = (dialog: HTMLElement, name: string) => fireEvent.click(within(dialog).getByRole('button', { name }))

describe('操作の前の、保存されていない編集の控え', () => {
  it('次の幕とつなぐ: 消える幕に控えがあれば伝え、キャンセルならつながない。「開く」でその幕を開く', async () => {
    const { pieceId, acts } = seed()
    draftOn(acts[1], 'closed-tab')
    render(<DialogHost />)
    let done = confirmJoin(acts[0])
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('第1話　第2幕に保存されていない編集があります')
    expect(dialog.textContent).toContain('の控え')
    // 開く画面が渡されていなければ「開く」は出さない
    expect(within(dialog).queryByRole('button', { name: '開く' })).toBeNull()
    press(dialog, 'キャンセル')
    expect(await done).toBe(false)
    expect(getData().pieces[pieceId].actIds).toEqual(acts)

    const open = vi.fn()
    done = confirmJoin(acts[0], { open })
    dialog = await screen.findByRole('dialog')
    press(dialog, '開く')
    expect(await done).toBe(false)
    expect(open).toHaveBeenCalledWith(acts[1])
    expect(getData().pieces[pieceId].actIds).toEqual(acts)
  })

  it('「このまま続ける」ならつなぐ確認へ進む（推敲メモを引き継ぐことも伝える）', async () => {
    const { pieceId, acts } = seed()
    draftOn(acts[1], 'closed-tab')
    render(<DialogHost />)
    const done = confirmJoin(acts[0])
    press(await screen.findByRole('dialog'), 'このまま続ける')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('第1幕と第2幕をつなぎますか？')
    expect(dialog.textContent).toContain(NOTE_CARRY_NOTICE)
    press(dialog, 'つなぐ')
    expect(await done).toBe(true)
    expect(getData().pieces[pieceId].actIds).toEqual([acts[0], acts[2]])
    // 控えは消さない（あとで残った幕・話を開いた時に、新しい稿として残せる）
    expect(localStorage.getItem(`novel-studio:edit:${acts[1]}`)).not.toBeNull()
  })

  it('セパレート解除: どれかの幕に控えがあれば伝える。別のタブで編集中ならそう伝える', async () => {
    const { pieceId, acts } = seed()
    draftOn(acts[2], 'open-tab')
    fakeLocks(['open-tab'])
    render(<DialogHost />)
    const done = confirmUnseparate(pieceId, { open: vi.fn() })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('第1話　第3幕に保存されていない編集があります')
    expect(dialog.textContent).toContain('別のタブ・ウィンドウで編集中')
    // 別のタブの編集は、ここからは開けない
    expect(within(dialog).queryByRole('button', { name: '開く' })).toBeNull()
    press(dialog, 'キャンセル')
    expect(await done).toBe(false)
    expect(getData().pieces[pieceId].actIds).toEqual(acts)
  })

  it('控えの内容がもう保存されていれば聞かずに消す。控えが無ければ聞かない', async () => {
    const { acts } = seed()
    const vid = getData().pieces[acts[0]].activeVersionId!
    writeCrashDraft(acts[0], { [versionField(vid, 'body')]: { base: 'AA', value: 'AAA' } }, 'closed-tab')
    expect(await confirmPendingDrafts([acts[0], acts[1]])).toBe(true)
    expect(localStorage.getItem(`novel-studio:edit:${acts[0]}`)).toBeNull()
  })
})
