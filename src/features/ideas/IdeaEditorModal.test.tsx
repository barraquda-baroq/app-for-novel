// アイデアの追加・編集ダイアログ: 入力欄は内容だけ。書きかけを端末に控え、同じダイアログを開き直すと復元する。
// 古い版で見出しを付けたアイデア・下書きは、見出しを内容の1行目にまとめて開く。
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    expect(onSave).toHaveBeenCalledWith('書きかけ')
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
    expect(onSave).toHaveBeenCalledWith('記憶を売る古書店\n客は記憶を売る。')
  })

  it('見出しのないアイデアには添え書きを出さない', () => {
    render(<IdeaEditorModal mode="edit" sectionName="x" initialBody="内容" onSave={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('idea-heading-merged')).toBeNull()
  })
})
