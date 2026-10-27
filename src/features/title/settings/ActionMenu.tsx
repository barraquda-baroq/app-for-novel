// 「…」ボタンから開く小さな操作メニュー。外側のクリック・Esc で閉じ、矢印キーで項目を移動できる。
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MoreIcon } from '../../../ui/icons'

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  testId?: string
}

export function ActionMenu({ label, items, testId }: { label: string; items: MenuItem[]; testId?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const first = root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    first?.focus()
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let j = -1
    if (e.key === 'ArrowDown') j = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = buttons.length - 1
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    } else if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (j < 0 || buttons.length === 0) return
    e.preventDefault()
    buttons[j].focus()
  }

  return (
    <div className="st-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn st-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="st-menu-list" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`st-menu-item${it.danger ? ' is-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                // 先に開くボタンへフォーカスを戻しておく（ダイアログを閉じた後にここへ戻る）
                close(true)
                it.onSelect()
              }}
              data-testid={it.testId}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
