// 入力中はローカルに保持し、少し間を置いて（またはフォーカスを外した時に）保存する入力欄。
// 原稿のような長文でも、1文字ごとに全体を再描画・保存しないようにするための部品。
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { markDraftClean, markDraftDirty } from '../store/draftRegistry'

const DEFAULT_DELAY = 500
/** 打ち続けていても、最初の未反映の入力からこの時間以内にはストアへ反映する */
const MAX_WAIT = 1500

/**
 * 下書きを反映する前に、編集を始めた後で保存先の値が別の操作（同期で届いた別の端末の編集など）で
 * 変わっていないかを確かめる。変わっていたら上書きせずに onConflict に下書きを渡す。
 */
export interface DraftConflictGuard {
  /** 保存先のいまの値 */
  read: () => string
  onConflict: (draft: string) => void
}

/**
 * value（保存済みの値）と onCommit（保存処理）を受け取り、編集中の下書きを管理するフック。
 * 別のレコードを編集する時は、この部品に key（レコードID）を付けて作り直すこと。
 */
export function useDraft(value: string, onCommit: (v: string) => void, delay = DEFAULT_DELAY, guard?: DraftConflictGuard) {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft: value, onCommit, pendingCommit: onCommit, guard, base: null as string | null })
  latest.current.onCommit = onCommit
  latest.current.guard = guard
  const registryKey = useRef(Symbol('draft'))
  const dirtySince = useRef(0)

  // 外部で値が変わった（別の操作で更新された）ときは、未保存の編集がなければ追従する
  useEffect(() => {
    if (!dirty.current) {
      setDraft(value)
      latest.current.draft = value
    }
  }, [value])

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (dirty.current) {
      dirty.current = false
      markDraftClean(registryKey.current)
      const { guard: g, base } = latest.current
      if (g && base !== null) {
        const current = g.read()
        if (current !== base && current !== latest.current.draft) {
          // 編集中に保存先が書き換えられた: 上書きせずに控え、届いた内容を表示する
          g.onConflict(latest.current.draft)
          latest.current.draft = current
          setDraft(current)
          return
        }
      }
      // 編集を始めた時点の保存先に書く（途中で props が変わっても別レコードに書き込まない）
      latest.current.pendingCommit(latest.current.draft)
    }
  }, [])

  const change = useCallback(
    (v: string) => {
      setDraft(v)
      latest.current.draft = v
      if (!dirty.current) {
        latest.current.pendingCommit = latest.current.onCommit
        latest.current.base = latest.current.guard ? latest.current.guard.read() : null
        dirtySince.current = Date.now()
        // 画面を閉じる時などにまとめて反映できるよう登録する（src/store/lifecycle.ts）
        markDraftDirty(registryKey.current, flush)
      }
      dirty.current = true
      if (timer.current) clearTimeout(timer.current)
      const wait = Math.max(0, Math.min(delay, dirtySince.current + MAX_WAIT - Date.now()))
      timer.current = setTimeout(flush, wait)
    },
    [delay, flush],
  )

  // アンマウント時に保存漏れを防ぐ（画面を閉じる時は lifecycle.ts がまとめて反映する）
  useEffect(() => flush, [flush])

  return { draft, change, flush }
}

export interface DraftHandle {
  flush: () => void
  focus: () => void
  element: HTMLTextAreaElement | HTMLInputElement | null
}

type DraftTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'defaultValue'> & {
  value: string
  onCommit: (v: string) => void
  delay?: number
  /** 下書きが変わるたびに呼ばれる（文字数表示などに使う） */
  onDraftChange?: (v: string) => void
  /** 編集中に保存先が書き換えられた時の扱い（原稿の本文など、上書きしてはいけないもの） */
  conflictGuard?: DraftConflictGuard
}

export const DraftTextarea = forwardRef<DraftHandle, DraftTextareaProps>(function DraftTextarea(
  { value, onCommit, delay, onDraftChange, conflictGuard, onBlur, ...rest },
  ref,
) {
  const { draft, change, flush } = useDraft(value, onCommit, delay, conflictGuard)
  const el = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ({ flush, focus: () => el.current?.focus(), element: el.current }), [flush])
  useEffect(() => {
    onDraftChange?.(draft)
  }, [draft, onDraftChange])
  return (
    <textarea
      ref={el}
      {...rest}
      value={draft}
      onChange={(e) => change(e.target.value)}
      onBlur={(e) => {
        flush()
        onBlur?.(e)
      }}
    />
  )
})

type DraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'> & {
  value: string
  onCommit: (v: string) => void
  delay?: number
}

export const DraftInput = forwardRef<DraftHandle, DraftInputProps>(function DraftInput(
  { value, onCommit, delay, onBlur, onKeyDown, ...rest },
  ref,
) {
  const { draft, change, flush } = useDraft(value, onCommit, delay)
  const el = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => ({ flush, focus: () => el.current?.focus(), element: el.current }), [flush])
  return (
    <input
      ref={el}
      {...rest}
      value={draft}
      onChange={(e) => change(e.target.value)}
      onBlur={(e) => {
        flush()
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          flush()
          ;(e.target as HTMLInputElement).blur()
        }
        onKeyDown?.(e)
      }}
    />
  )
})
