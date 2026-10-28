// 指定した位置（右クリック・長押しした所、または「…」ボタンの下）に開く小さな操作メニュー。
// 外側を押す・Esc・Tab・スクロール・画面の幅の変更で閉じ、矢印キーで項目を移動できる。閉じたら開く前の要素へフォーカスを戻す。
// 外側を押して閉じた時は閉じるだけ（下にある行のリンクなどは開かない）。
// 押せない項目は aria-disabled にして（フォーカスは移せる）、押すと理由（hint）を知らせる。
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { notifyError } from '../store/uiStore'
import './menu.css'

export interface PopupMenuItem {
  label: string
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  /** 押せない（押すと hint を知らせる） */
  disabled?: boolean
  /** 項目の下に出す短い説明（押せない理由など） */
  hint?: string
  testId?: string
}

/** 開く位置。point は画面上の座標、anchor は下に開く要素 */
export type MenuPlacement = { point: { x: number; y: number } } | { anchor: Element }

export interface PopupMenuProps {
  label: string
  items: PopupMenuItem[]
  placement: MenuPlacement
  onClose: () => void
  /** 閉じた後にフォーカスを戻す要素（省くと開く前にフォーカスしていた要素） */
  returnFocus?: HTMLElement | null
  testId?: string
}

/** 画面の端からの余白 */
const EDGE = 8

/**
 * 外側を押してメニューを閉じた時は、続けて届くクリック（下にある行のリンクなど）を取り消す（閉じるだけにする。
 * 各 OS のメニューと同じ）。取り消しは document に付けるので、閉じて消えたメニューより長く残る
 */
function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    done()
  }
  const done = () => {
    clearTimeout(timer)
    document.removeEventListener('click', stop, true)
    document.removeEventListener('pointerdown', done, true)
  }
  // クリックが届かなかった時（なぞってスクロールした等）は持ち越さない
  const timer = setTimeout(done, 1000)
  document.addEventListener('click', stop, true)
  // 次に触れたら取り消しをやめる（今の pointerdown の途中で足したものは、今回は呼ばれない）
  document.addEventListener('pointerdown', done, true)
}

/** 置く位置を測るまでは見せない（位置は描いた後に直接置く） */
const HIDDEN = { left: 0, top: 0, visibility: 'hidden' } as const

export function PopupMenu({ label, items, placement, onClose, returnFocus, testId }: PopupMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const previous = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  const focusBack = useRef(returnFocus)
  focusBack.current = returnFocus

  // 画面からはみ出さない位置に置く（右・下にはみ出す時は左・上へ寄せる）。
  // 描き直さずに直接置く（隠れたままだとフォーカスを移せないので、描いた直後に見えるようにする）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x: number
    let y: number
    if ('anchor' in placement) {
      const r = placement.anchor.getBoundingClientRect()
      x = r.right - w
      y = r.bottom + 4
      if (y + h > vh - EDGE) y = r.top - h - 4
    } else {
      x = placement.point.x
      y = placement.point.y
      if (x + w > vw - EDGE) x = x - w
      if (y + h > vh - EDGE) y = y - h
    }
    el.style.left = `${Math.max(EDGE, Math.min(x, vw - w - EDGE))}px`
    el.style.top = `${Math.max(EDGE, Math.min(y, vh - h - EDGE))}px`
    el.style.visibility = 'visible'
  }, [placement])

  useEffect(() => {
    const el = ref.current
    const first = el?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    first?.focus({ preventScroll: true })
    // 開いたボタン（anchor）を押した時は、そのボタンの操作（開く・閉じる）に任せる
    const anchor = 'anchor' in placement ? placement.anchor : null
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchor?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) {
        // 外側を押して閉じる時は、閉じるだけにする（下にある行のリンクなどを開かない）
        swallowNextClick()
        closeRef.current()
      }
    }
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    // 画面キーボードの開閉（Android は interactive-widget=resizes-content で高さだけが変わる）では閉じない。
    // 回転・ウィンドウの幅の変更の時だけ閉じる（置いた位置がずれるので）
    const openWidth = window.innerWidth
    const onResize = () => {
      if (window.innerWidth !== openWidth) closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      // 閉じた後は開く前の場所へ（確認ダイアログを開いた時は、ダイアログが閉じた後にここへ戻る）
      const back = focusBack.current ?? (previous.current instanceof HTMLElement ? previous.current : null)
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body || el?.contains(active))) {
        back.focus({ preventScroll: true })
      }
    }
  }, [])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let j = -1
    if (e.key === 'ArrowDown') j = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = buttons.length - 1
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
      return
    }
    if (j < 0 || buttons.length === 0) return
    e.preventDefault()
    buttons[j].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="pm-menu"
      role="menu"
      id={menuId}
      aria-label={label}
      onKeyDown={onKey}
      // 右クリックでメニューの上にブラウザのメニューを重ねない
      onContextMenu={(e) => e.preventDefault()}
      style={HIDDEN}
      data-testid={testId ?? 'popup-menu'}
    >
      <p className="pm-title" aria-hidden="true">
        {label}
      </p>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`pm-item${it.danger ? ' is-danger' : ''}${it.disabled ? ' is-disabled' : ''}`}
          aria-disabled={it.disabled || undefined}
          onClick={() => {
            if (it.disabled) {
              if (it.hint) notifyError(it.hint)
              return
            }
            closeRef.current()
            it.onSelect()
          }}
          data-testid={it.testId}
        >
          {it.icon ? <span className="pm-icon">{it.icon}</span> : null}
          <span className="pm-text">
            <span className="pm-label">{it.label}</span>
            {it.hint ? <span className="pm-hint">{it.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
