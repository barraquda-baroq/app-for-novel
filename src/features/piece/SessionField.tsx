// 原稿画面の入力欄（本文・推敲メモ・稿の名前・話の題・見出し）。
// 値は編集セッション（session.ts）が持ち、「保存」を押すまでストアには入れない。
// 巻き戻し／進む（Ctrl/Cmd+Z・Ctrl/Cmd+Shift+Z・Ctrl+Y）は自前の履歴で行う（値を書き換えるとブラウザ標準の履歴は使えないため）。
// - 続けて打った文字は1手にまとめ、カーソルを動かした・クリックした・フォーカスし直した時に区切る
// - 日本語入力は、変換を確定した時に1手にする（変換中の文字は履歴に積まない）
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type TextareaHTMLAttributes,
} from 'react'
import { useSessionValue, type EditorHub, type FieldHandle } from './editorHub'
import type { Sel } from './history'
import type { FieldKey } from './session'
import { applySymbol } from './symbols'

type FieldEl = HTMLTextAreaElement | HTMLInputElement

interface FieldOptions {
  hub: EditorHub
  fieldKey: FieldKey
  /** 保存先の値 */
  stored: string
  /** 記号ボタンで記号を入れられる欄か（本文・推敲メモ） */
  symbols?: boolean
  /** 本文なら稿の名前（保存前に稿が削除された時の控えの名前） */
  label?: string
}

/** カーソルを動かすキー（押したら履歴を区切る） */
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

function readSel(el: FieldEl): Sel {
  const len = el.value.length
  return { start: el.selectionStart ?? len, end: el.selectionEnd ?? len }
}

function useFieldEditor<E extends FieldEl>({ hub, fieldKey, stored, symbols = false, label }: FieldOptions) {
  const { session } = hub
  const value = useSessionValue(session, fieldKey, stored)
  const ref = useRef<E>(null)
  const latest = useRef({ stored, label })
  latest.current = { stored, label }
  /** 次の変更の前の選択範囲（beforeinput / keydown で控える） */
  const selBefore = useRef<Sel | null>(null)
  /** 日本語入力の変換中: 変換を始める前の値と選択範囲 */
  const composing = useRef<{ before: string; sel: Sel } | null>(null)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 値を書き換えた後に戻すカーソル位置 */
  const pendingSel = useRef<Sel | null>(null)

  const handle = useMemo<FieldHandle>(() => {
    const showSelection = (sel: Sel) => {
      pendingSel.current = sel
      const el = ref.current
      if (el && document.activeElement !== el) el.focus({ preventScroll: true })
      // 値が変わらない時（描き直しが起きない時）もカーソルは動かす
      if (el && el.value === session.display(fieldKey, latest.current.stored)) {
        pendingSel.current = null
        el.setSelectionRange(sel.start, sel.end)
      }
    }
    return {
      key: fieldKey,
      symbols,
      element: () => ref.current,
      insert: (kind) => {
        const el = ref.current
        if (!el || composing.current) return
        const sel = readSel(el)
        const { stored: st, label: l } = latest.current
        const r = applySymbol(session.display(fieldKey, st), sel.start, sel.end, kind)
        session.change(
          fieldKey,
          st,
          { value: r.value, selBefore: sel, selAfter: r.selection, kind: 'symbol', splice: r.splice, at: Date.now() },
          l,
        )
        showSelection(r.selection)
      },
      undo: () => {
        if (composing.current) return
        const r = session.undo(fieldKey, latest.current.stored)
        if (r) showSelection(r.selection)
      },
      redo: () => {
        if (composing.current) return
        const r = session.redo(fieldKey, latest.current.stored)
        if (r) showSelection(r.selection)
      },
    }
  }, [session, fieldKey, symbols])

  useEffect(() => hub.register(handle), [hub, handle])

  // 巻き戻し・記号の挿入で値を書き換えたら、カーソル（選択範囲）を戻す
  useLayoutEffect(() => {
    const el = ref.current
    const sel = pendingSel.current
    if (!el || !sel) return
    pendingSel.current = null
    try {
      el.setSelectionRange(sel.start, sel.end)
    } catch {
      /* 種類によっては選択範囲を持たない */
    }
  }, [value])

  /** 変換を確定した文字を1手として履歴に積む */
  const flushComposition = useRef(() => {})
  flushComposition.current = () => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current)
      commitTimer.current = null
    }
    const comp = composing.current
    if (!comp) return
    composing.current = null
    const el = ref.current
    const { stored: st, label: l } = latest.current
    const now = session.display(fieldKey, st)
    const end = { start: now.length, end: now.length }
    session.change(
      fieldKey,
      st,
      { before: comp.before, value: now, selBefore: comp.sel, selAfter: el ? readSel(el) : end, kind: 'ime', at: Date.now() },
      l,
    )
  }

  // 変換中に画面を離れても、確定した分は履歴に積む
  useEffect(() => () => flushComposition.current(), [])

  // ブラウザの「元に戻す」（メニュー・iPad のキーボードのボタンなど）も自前の履歴で行う。変更前の選択範囲も控える
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent
      if (ie.inputType === 'historyUndo' || ie.inputType === 'historyRedo') {
        e.preventDefault()
        if (ie.inputType === 'historyUndo') handle.undo()
        else handle.redo()
        return
      }
      if (!composing.current && !ie.isComposing) selBefore.current = readSel(el)
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => el.removeEventListener('beforeinput', onBeforeInput)
  }, [handle])

  const onChange = (e: ChangeEvent<E>) => {
    const el = e.currentTarget
    const next = el.value
    const ne = e.nativeEvent as InputEvent
    const { stored: st, label: l } = latest.current
    if (composing.current || ne.isComposing) {
      session.setValue(fieldKey, st, next, l)
      return
    }
    const sel = readSel(el)
    const before = selBefore.current ?? { start: sel.start, end: sel.start }
    selBefore.current = null
    session.change(fieldKey, st, { value: next, selBefore: before, selAfter: sel, inputType: ne.inputType, at: Date.now() }, l)
  }

  const onCompositionStart = (e: CompositionEvent<E>) => {
    flushComposition.current()
    composing.current = { before: session.display(fieldKey, latest.current.stored), sel: readSel(e.currentTarget) }
    selBefore.current = null
    session.seal(fieldKey)
  }

  const onCompositionEnd = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current)
    // Safari では確定の input イベントが compositionend の後に届くので、それを待ってから1手にする
    commitTimer.current = setTimeout(() => flushComposition.current(), 0)
  }

  const onKeyDown = (e: KeyboardEvent<E>) => {
    if (e.nativeEvent.isComposing || composing.current) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && !e.altKey && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) handle.redo()
      else handle.undo()
      return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k === 'y') {
      e.preventDefault()
      handle.redo()
      return
    }
    if (NAV_KEYS.has(e.key)) session.seal(fieldKey)
    selBefore.current = readSel(e.currentTarget)
  }

  const onPointerDown = () => session.seal(fieldKey)

  const onFocus = () => {
    session.seal(fieldKey)
    hub.focused(handle)
  }

  return { ref, value, onChange, onCompositionStart, onCompositionEnd, onKeyDown, onPointerDown, onFocus }
}

type TextareaProps = FieldOptions &
  Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'
  >

export function SessionTextarea({
  hub,
  fieldKey,
  stored,
  symbols,
  label,
  onKeyDown,
  onFocus,
  onPointerDown,
  ...rest
}: TextareaProps) {
  const f = useFieldEditor<HTMLTextAreaElement>({ hub, fieldKey, stored, symbols, label })
  return (
    <textarea
      {...rest}
      ref={f.ref}
      value={f.value}
      onChange={f.onChange}
      onCompositionStart={f.onCompositionStart}
      onCompositionEnd={f.onCompositionEnd}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        f.onKeyDown(e)
        onKeyDown?.(e)
      }}
      onFocus={(e: FocusEvent<HTMLTextAreaElement>) => {
        f.onFocus()
        onFocus?.(e)
      }}
      onPointerDown={(e: PointerEvent<HTMLTextAreaElement>) => {
        f.onPointerDown()
        onPointerDown?.(e)
      }}
    />
  )
}

type InputProps = FieldOptions &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'>

/** 1行の入力欄。Enter で入力を終える（保存はしない） */
export function SessionInput({ hub, fieldKey, stored, symbols, label, onKeyDown, onFocus, onPointerDown, ...rest }: InputProps) {
  const f = useFieldEditor<HTMLInputElement>({ hub, fieldKey, stored, symbols, label })
  return (
    <input
      {...rest}
      ref={f.ref}
      value={f.value}
      onChange={f.onChange}
      onCompositionStart={f.onCompositionStart}
      onCompositionEnd={f.onCompositionEnd}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        f.onKeyDown(e)
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.defaultPrevented) e.currentTarget.blur()
        onKeyDown?.(e)
      }}
      onFocus={(e: FocusEvent<HTMLInputElement>) => {
        f.onFocus()
        onFocus?.(e)
      }}
      onPointerDown={(e: PointerEvent<HTMLInputElement>) => {
        f.onPointerDown()
        onPointerDown?.(e)
      }}
    />
  )
}
