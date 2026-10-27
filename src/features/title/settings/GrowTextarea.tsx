// 内容に合わせて高さが伸びる DraftTextarea（設定のフィールド・戦略のメモ欄で使う）。
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from 'react'
import { DraftTextarea, type DraftHandle } from '../../../ui/DraftField'
import './grow.css'

type Props = ComponentProps<typeof DraftTextarea>

export const GrowTextarea = forwardRef<DraftHandle, Props>(function GrowTextarea(
  { onDraftChange, className, rows = 1, ...rest },
  ref,
) {
  const inner = useRef<DraftHandle>(null)
  const userOnDraftChange = useRef(onDraftChange)
  userOnDraftChange.current = onDraftChange

  useImperativeHandle(
    ref,
    () => ({
      flush: () => inner.current?.flush(),
      focus: () => inner.current?.focus(),
      get element() {
        return inner.current?.element ?? null
      },
    }),
    [],
  )

  const resize = useCallback(() => {
    const el = inner.current?.element as HTMLTextAreaElement | null | undefined
    if (!el || typeof window === 'undefined') return
    const style = window.getComputedStyle(el)
    const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + borders}px`
  }, [])

  // DraftTextarea の effect が回り続けないよう、同じ関数を渡し続ける
  const handleDraftChange = useCallback(
    (v: string) => {
      resize()
      userOnDraftChange.current?.(v)
    },
    [resize],
  )

  useLayoutEffect(() => {
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [resize])

  return (
    <DraftTextarea
      ref={inner}
      rows={rows}
      className={`${className ?? 'textarea'} st-grow`}
      onDraftChange={handleDraftChange}
      {...rest}
    />
  )
})
