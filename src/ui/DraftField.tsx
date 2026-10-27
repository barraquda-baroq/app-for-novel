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

const DEFAULT_DELAY = 500

/**
 * value（保存済みの値）と onCommit（保存処理）を受け取り、編集中の下書きを管理するフック。
 * 別のレコードを編集する時は、この部品に key（レコードID）を付けて作り直すこと。
 */
export function useDraft(value: string, onCommit: (v: string) => void, delay = DEFAULT_DELAY) {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft: value, onCommit, pendingCommit: onCommit })
  latest.current.onCommit = onCommit

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
      // 編集を始めた時点の保存先に書く（途中で props が変わっても別レコードに書き込まない）
      latest.current.pendingCommit(latest.current.draft)
    }
  }, [])

  const change = useCallback(
    (v: string) => {
      setDraft(v)
      latest.current.draft = v
      if (!dirty.current) latest.current.pendingCommit = latest.current.onCommit
      dirty.current = true
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, delay)
    },
    [delay, flush],
  )

  // アンマウント時・ページを離れる時に保存漏れを防ぐ
  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

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
}

export const DraftTextarea = forwardRef<DraftHandle, DraftTextareaProps>(function DraftTextarea(
  { value, onCommit, delay, onDraftChange, onBlur, ...rest },
  ref,
) {
  const { draft, change, flush } = useDraft(value, onCommit, delay)
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
