// アイデアの追加・編集ダイアログ: 入力欄は内容だけ。書きかけを端末に控え、同じダイアログを開き直すと復元する。
// 古い版で見出しを付けたアイデア・下書きは、見出しを内容の1行目にまとめて開く。
// 2.8: 編集を始めた時の内容（base）を控えて保存の時に渡し、Claude が作ったアイデアでは届いた依頼・下書きの後の追記を知らせる。
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ideaAppendId, trashRequestId } from '../../claude/derivedId'
import { ideaReadMark } from '../../claude/ideaAppend'
import { createPersistence } from '../../db/persistence'
import type { IdeaAppend, TrashRequest } from '../../domain/types'
import { commit, getData, initStore, resetStoreForTests } from '../../store/appStore'
import { IdeaEditorModal } from './IdeaEditorModal'
import { ideaModalDraftKey } from './ideaLogic'

/** 入力欄の値 */
const value = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement | HTMLTextAreaElement).value

const addKey = ideaModalDraftKey({ mode: 'add', section: 'none' })
const editKey = ideaModalDraftKey({ mode: 'edit', ideaId: 'i1' })

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('IdeaEditorModal の下書き', () => {
  it('入力するたびに控え、閉じずに画面が消えても（戻る・アプリの終了）次に開くと復元する', async () => {
    const user = userEvent.setup()
    const first = render(
      <IdeaEditorModal mode="add" sectionName="どのタイトルにも属さない" draftKey={addKey} onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('idea-heading-input')).toBeNull()
    await user.type(screen.getByTestId('idea-body-input'), '記憶を売る')
    expect(JSON.parse(localStorage.getItem(addKey)!)).toEqual({ heading: '', body: '記憶を売る' })
    // 保存も破棄もせずに消える（ブラウザの「戻る」で画面が切り替わった時など）
    first.unmount()

    render(
      <IdeaEditorModal mode="add" sectionName="どのタイトルにも属さない" draftKey={addKey} onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('idea-draft-restored').textContent).toContain('下書きを復元しました')
    expect(value('idea-body-input')).toBe('記憶を売る')
  })

  it('保存すると下書きを消す', async () => {
    const user = userEvent.setup()
    localStorage.setItem(addKey, JSON.stringify({ heading: '', body: '書きかけ' }))
    const onSave = vi.fn()
    render(<IdeaEditorModal mode="add" sectionName="x" draftKey={addKey} onSave={onSave} onClose={vi.fn()} />)
    await user.click(screen.getByTestId('idea-save'))
    // 追加は編集を始めた時の内容が空
    expect(onSave).toHaveBeenCalledWith('書きかけ', '')
    expect(localStorage.getItem(addKey)).toBeNull()
  })

  it('編集: 元の内容と同じ下書きは使わない。「下書きを破棄して元に戻す」で元の内容に戻して消す', async () => {
    const user = userEvent.setup()
    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '元の本文' }))
    const { unmount } = render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody="元の本文"
        draftKey={editKey}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('idea-draft-restored')).toBeNull()
    unmount()

    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '直しかけ' }))
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody="元の本文"
        draftKey={editKey}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(value('idea-body-input')).toBe('直しかけ')
    await user.click(screen.getByTestId('idea-draft-discard'))
    expect(value('idea-body-input')).toBe('元の本文')
    expect(screen.queryByTestId('idea-draft-restored')).toBeNull()
    expect(localStorage.getItem(editKey)).toBeNull()
  })

  it('元の内容に戻したら下書きは残さない。変更せずに閉じても消す', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<IdeaEditorModal mode="add" sectionName="x" draftKey={addKey} onSave={vi.fn()} onClose={onClose} />)
    const body = screen.getByTestId('idea-body-input')
    await user.type(body, 'あ')
    expect(localStorage.getItem(addKey)).not.toBeNull()
    await user.clear(body)
    expect(localStorage.getItem(addKey)).toBeNull()
    await user.click(screen.getByTestId('idea-cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('見出しのある古い下書き（更新前の版で書きかけたもの）は、見出しを1行目にまとめて復元する', () => {
    localStorage.setItem(editKey, JSON.stringify({ heading: '見出し', body: '直しかけ' }))
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody={'見出し\n元の本文'}
        mergedHeading
        draftKey={editKey}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('idea-draft-restored')).toBeTruthy()
    expect(value('idea-body-input')).toBe('見出し\n直しかけ')
  })
})

describe('IdeaEditorModal の古い版の見出し', () => {
  it('見出しを1行目にまとめた内容で開き、その旨を添える。保存するとその内容を渡す（見出しの入力欄はない）', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody={'記憶を売る古書店\n客は記憶を売る。'}
        mergedHeading
        draftKey={editKey}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('idea-heading-input')).toBeNull()
    expect(value('idea-body-input')).toBe('記憶を売る古書店\n客は記憶を売る。')
    expect(screen.getByTestId('idea-heading-merged').textContent).toContain('見出しは内容の1行目に入れました')
    await user.click(screen.getByTestId('idea-save'))
    expect(onSave).toHaveBeenCalledWith('記憶を売る古書店\n客は記憶を売る。', '記憶を売る古書店\n客は記憶を売る。')
  })

  it('見出しのないアイデアには添え書きを出さない', () => {
    render(<IdeaEditorModal mode="edit" sectionName="x" initialBody="内容" onSave={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('idea-heading-merged')).toBeNull()
  })
})

const HEADER = '2026/11/13のセッションで以下の内容へ変更'

describe('IdeaEditorModal の編集を始めた時の内容（2.8）', () => {
  it('変えたかどうかは編集を始めた時の内容と比べる（開いている間にアイデアが変わっても、何も変えなければ確かめずに閉じる）', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSave = vi.fn()
    const props = { mode: 'edit' as const, sectionName: 'x', draftKey: editKey, onSave, onClose }
    const view = render(<IdeaEditorModal {...props} initialBody="元の本文" />)
    // 別の画面で Claude の追記が足された
    view.rerender(<IdeaEditorModal {...props} initialBody={`元の本文\n\n${HEADER}\n追記`} />)
    expect(value('idea-body-input')).toBe('元の本文')
    await user.click(screen.getByTestId('idea-cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('編集中の内容を破棄しますか？')).toBeNull()
    // 保存すると、保存する内容と編集を始めた時の内容を渡す
    await user.click(screen.getByTestId('idea-save'))
    expect(onSave).toHaveBeenCalledWith('元の本文', '元の本文')
  })

  it('編集の下書きには書き始めた時の内容も控える（追加の下書きは今までの形）', async () => {
    const user = userEvent.setup()
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody="元の本文"
        draftKey={editKey}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await user.type(screen.getByTestId('idea-body-input'), 'を直す')
    expect(JSON.parse(localStorage.getItem(editKey)!)).toEqual({ heading: '', body: '元の本文を直す', base: '元の本文' })
  })

  it('下書きを書いた後に Claude の追記が足されていたら知らせ、保存すると下書きと書き始めた時の内容を渡す', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '元の本文\n直しかけ', base: '元の本文' }))
    const current = `元の本文\n\n${HEADER}\n追記`
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody={current}
        draftKey={editKey}
        ideaId="cy-a1"
        holdClaude
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    expect(value('idea-body-input')).toBe('元の本文\n直しかけ')
    expect(screen.getByTestId('idea-draft-restored')).toBeTruthy()
    expect(screen.getByTestId('idea-draft-claude-appended').textContent).toBe(
      '下書きを書いた後に、このアイデアに Claude の追記が足されました。保存すると、追記は下書きの後ろに残ります。',
    )
    await user.click(screen.getByTestId('idea-save'))
    expect(onSave).toHaveBeenCalledWith('元の本文\n直しかけ', '元の本文')
  })

  it('下書きを破棄すると今の内容に戻し、編集を始めた時の内容も今の内容にする（追記をもう一度足さない）', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '元の本文\n直しかけ', base: '元の本文' }))
    const current = `元の本文\n\n${HEADER}\n追記`
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody={current}
        draftKey={editKey}
        ideaId="cy-a1"
        holdClaude
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    await user.click(screen.getByTestId('idea-draft-discard'))
    expect(value('idea-body-input')).toBe(current)
    expect(screen.queryByTestId('idea-draft-claude-appended')).toBeNull()
    await user.click(screen.getByTestId('idea-save'))
    expect(onSave).toHaveBeenCalledWith(current, current)
  })

  it('書き始めた時の内容の無い古い下書き・作者が書いたアイデアには、追記の知らせを出さない', () => {
    const current = `元の本文\n\n${HEADER}\n追記`
    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '元の本文\n直しかけ' }))
    const view = render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody={current}
        draftKey={editKey}
        ideaId="cy-a1"
        holdClaude
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('idea-draft-restored')).toBeTruthy()
    expect(screen.queryByTestId('idea-draft-claude-appended')).toBeNull()
    view.unmount()
    localStorage.setItem(editKey, JSON.stringify({ heading: '', body: '元の本文\n直しかけ', base: '元の本文' }))
    render(
      <IdeaEditorModal mode="edit" sectionName="x" initialBody={current} draftKey={editKey} onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('idea-draft-restored')).toBeTruthy()
    expect(screen.queryByTestId('idea-draft-claude-appended')).toBeNull()
  })
})

let db = 0

describe('IdeaEditorModal の Claude の依頼の知らせ（2.8）', () => {
  beforeEach(async () => {
    await initStore(createPersistence(`test-db-idea-editor-${++db}`))
  })
  afterEach(() => {
    cleanup()
    resetStoreForTests()
  })

  /** cy-a1 への追記の依頼とゴミ箱へ移す依頼が同期で届いた */
  function seedRequests() {
    const append: IdeaAppend = {
      id: ideaAppendId('cy-a1', ideaReadMark('元の本文'), '追記'),
      ideaId: 'cy-a1',
      text: '追記',
      readMark: ideaReadMark('元の本文'),
      source: 'claude',
      v: 1,
      createdAt: 1000,
      updatedAt: 1000,
    }
    const trash: TrashRequest = {
      id: trashRequestId('ideas', 'cy-a1'),
      table: 'ideas',
      targetId: 'cy-a1',
      parentId: 'home',
      targetUpdatedAt: 100,
      label: 'ホームのアイデア「元の本文」',
      source: 'claude',
      v: 2,
      createdAt: 1000,
      updatedAt: 1000,
    }
    const data = getData()
    commit({ ...data, ideaAppends: { [append.id]: append }, trashRequests: { [trash.id]: trash } })
  }

  it('Claude が作ったアイデアの編集では、届いている追記・ゴミ箱へ移す依頼を知らせる', () => {
    seedRequests()
    render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody="元の本文"
        ideaId="cy-a1"
        holdClaude
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('idea-editor-claude-append').getAttribute('role')).toBe('status')
    expect(screen.getByTestId('idea-editor-claude-trash').getAttribute('role')).toBe('status')
  })

  it('ほかのアイデアへの依頼・作者が書いたアイデアの編集・追加のダイアログでは知らせない', () => {
    seedRequests()
    const view = render(
      <IdeaEditorModal
        mode="edit"
        sectionName="x"
        initialBody="別の案"
        ideaId="cy-b2"
        holdClaude
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('idea-editor-claude-append')).toBeNull()
    expect(screen.queryByTestId('idea-editor-claude-trash')).toBeNull()
    view.unmount()
    const author = render(
      <IdeaEditorModal mode="edit" sectionName="x" initialBody="元の本文" ideaId="cy-a1" onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('idea-editor-claude-append')).toBeNull()
    author.unmount()
    render(<IdeaEditorModal mode="add" sectionName="x" ideaId="cy-a1" holdClaude onSave={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('idea-editor-claude-append')).toBeNull()
    expect(screen.queryByTestId('idea-editor-claude-trash')).toBeNull()
  })
})
