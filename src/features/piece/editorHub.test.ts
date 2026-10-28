// 記号バー・巻き戻しが働く欄（最後にフォーカスした欄）と、見えなくなった欄の外し方
import { describe, expect, it, vi } from 'vitest'
import { EditorHub, isFieldVisible, type FieldHandle } from './editorHub'
import { EditSession, versionField } from './session'

function handle(key: string, el: HTMLTextAreaElement | null): FieldHandle {
  return { key, symbols: true, element: () => el, insert: vi.fn(), undo: vi.fn(), redo: vi.fn() }
}

function textarea(visible: boolean): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  Object.defineProperty(el, 'checkVisibility', { configurable: true, value: () => visible })
  return el
}

describe('記号バーの働き先', () => {
  it('畳んだ推敲メモ（release）は働き先から外し、知らせる。ほかの欄が働き先なら何もしない', () => {
    const hub = new EditorHub(new EditSession('p'))
    const listener = vi.fn()
    hub.subscribe(listener)
    const note = handle(versionField('v', 'note'), textarea(true))
    const body = handle(versionField('v', 'body'), textarea(true))
    hub.register(note)
    hub.register(body)
    hub.focused(body)
    listener.mockClear()
    hub.release(note.key)
    expect(hub.getTarget()).toBe(body)
    expect(listener).not.toHaveBeenCalled()
    hub.focused(note)
    hub.release(note.key)
    expect(hub.getTarget()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('見えなくなった欄（しまった「…」の中など）は releaseHidden で外す。見えている欄はそのまま', () => {
    const hub = new EditorHub(new EditSession('p'))
    const shown = handle(versionField('v', 'name'), textarea(true))
    hub.register(shown)
    hub.focused(shown)
    hub.releaseHidden()
    expect(hub.getTarget()).toBe(shown)
    const hidden = handle(versionField('w', 'name'), textarea(false))
    hub.register(hidden)
    hub.focused(hidden)
    hub.releaseHidden()
    expect(hub.getTarget()).toBeNull()
  })

  it('isFieldVisible: 画面から外れた欄は見えていない。checkVisibility の無いブラウザでは見えているとみなす', () => {
    const el = document.createElement('textarea')
    expect(isFieldVisible(el)).toBe(false)
    document.body.appendChild(el)
    Object.defineProperty(el, 'checkVisibility', { configurable: true, value: undefined })
    expect(isFieldVisible(el)).toBe(true)
    el.remove()
  })
})
