// 指定した位置（右クリック・長押しした所、または「…」ボタンの下）に開く小さな操作メニュー。
// 外側を押す・Esc・Tab・スクロール・画面の幅の変更で閉じ、矢印キーで項目を移動できる。閉じたら開く前の要素へフォーカスを戻す。
// 外側を押して閉じた時は閉じるだけ（下にある行のリンクなどは開かない）。
// 押せない項目は aria-disabled にして（フォーカスは移せる）、押すと理由（hint）を知らせる。
// 記号バーの「括弧」のように、本文にカーソルを置いたまま開くメニュー（autoFocus・keepFocus）にも使う。
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { onNativeKeyboard } from '../platform/keyboard'
import { keyboardCover } from '../platform/viewportKeyboard'
import { notifyError } from '../store/uiStore'
import { keepFocus as keepFocusHandler } from './keys'
import './menu.css'

export interface PopupMenuItem {
  label: string
  /** 読み上げの名前（省くと label） */
  ariaLabel?: string
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  /** 押せない（押すと hint を知らせる） */
  disabled?: boolean
  /** 項目の下に出す短い説明（押せない理由など） */
  hint?: string
  testId?: string
}

/**
 * 開く位置。point は画面上の座標、anchor はその要素の下（右端を揃える）。
 * side: 'above' はその要素の上（真ん中を揃える。上に入らなければ下）。開いている間に画面の高さが変わったら（キーボードの開閉）置き直す
 */
export type MenuPlacement = { point: { x: number; y: number } } | { anchor: Element; side?: 'below' | 'above' }

export interface PopupMenuProps {
  label: string
  items: PopupMenuItem[]
  placement: MenuPlacement
  onClose: () => void
  /** 閉じた後にフォーカスを戻す要素（省くと開く前にフォーカスしていた要素） */
  returnFocus?: HTMLElement | null
  /** 開いた時に最初の項目へフォーカスする（既定 true）。false なら今のフォーカス（本文など）を動かさない */
  autoFocus?: boolean
  /** 押してもフォーカスを奪わない（本文のカーソル・スマホのキーボードを残す。記号バーと同じ） */
  keepFocus?: boolean
  /** 外側を押して閉じた時に、続くクリックを取り消す（既定 true）。false なら、押した外側のボタンもそのまま働く */
  swallowOutsideClick?: boolean
  /** 項目の並び（row は横一列。←→ でも動く） */
  layout?: 'column' | 'row'
  testId?: string
}

/** 画面の端からの余白 */
const EDGE = 8
/** 上に開く時の、押した要素との間 */
const ABOVE_GAP = 8

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

export function PopupMenu({
  label,
  items,
  placement,
  onClose,
  returnFocus,
  autoFocus = true,
  keepFocus = false,
  swallowOutsideClick = true,
  layout = 'column',
  testId,
}: PopupMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const previous = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  const focusBack = useRef(returnFocus)
  focusBack.current = returnFocus
  const options = useRef({ autoFocus, swallowOutsideClick })

  // 画面からはみ出さない位置に置く（右・下にはみ出す時は左・上へ寄せる）。
  // 描き直さずに直接置く（隠れたままだとフォーカスを移せないので、描いた直後に見えるようにする）
  const place = useRef(() => {})
  place.current = () => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    // 画面キーボードに隠れる下の所と、Safari が見えている範囲を下げた分の上の所には置かない（src/platform/viewportKeyboard.ts）
    const kb = keyboardCover()
    const minTop = EDGE + kb.top
    const vh = window.innerHeight - kb.bottom
    let x: number
    let y: number
    if ('anchor' in placement) {
      const r = placement.anchor.getBoundingClientRect()
      if (placement.side === 'above') {
        // 下のボタンの並び（記号バー）の上端にも重ならないよう、少し離す
        x = r.left + r.width / 2 - w / 2
        y = r.top - h - ABOVE_GAP
        if (y < minTop) y = r.bottom + 4
      } else {
        x = r.right - w
        y = r.bottom + 4
        if (y + h > vh - EDGE) y = r.top - h - 4
      }
    } else {
      x = placement.point.x
      y = placement.point.y
      if (x + w > vw - EDGE) x = x - w
      if (y + h > vh - EDGE) y = y - h
    }
    el.style.left = `${Math.max(EDGE, Math.min(x, vw - w - EDGE))}px`
    el.style.top = `${Math.max(minTop, Math.min(y, vh - h - EDGE))}px`
    el.style.visibility = 'visible'
  }
  useLayoutEffect(() => place.current(), [placement])

  useEffect(() => {
    const el = ref.current
    if (options.current.autoFocus) {
      el?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    }
    // 開いたボタン（anchor）を押した時は、そのボタンの操作（開く・閉じる）に任せる
    const anchor = 'anchor' in placement ? placement.anchor : null
    const above = 'anchor' in placement && placement.side === 'above'
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchor?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) {
        // 外側を押して閉じる時は、閉じるだけにする（下にある行のリンクなどを開かない）
        if (options.current.swallowOutsideClick) swallowNextClick()
        closeRef.current()
      }
    }
    // Esc は document の捕捉の段階で受けて止める（フォーカスが本文にあっても閉じられ、
    // 同じ1回の Esc で本文の側の部品（検索窓など）まで閉じない。いちばん上のメニューだけが閉じる）
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    // 画面キーボードの開閉（Android は interactive-widget=resizes-content で高さだけが変わる）では閉じない。
    // 回転・ウィンドウの幅の変更の時だけ閉じる（置いた位置がずれるので）。
    // 上に開くメニュー（記号バーの括弧）は、キーボードの開閉で動いたボタンの上に置き直す（--kb-inset を入れた後に測る）。
    // iPhone のアプリは画面が縮まないので、アプリから届くキーボードの高さの変化でも置き直す
    const openWidth = window.innerWidth
    let frame = 0
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => place.current())
    }
    const onResize = () => {
      if (window.innerWidth !== openWidth) closeRef.current()
      else if (above) follow()
    }
    const vv = above ? window.visualViewport : null
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    vv?.addEventListener('resize', follow)
    const offNative = above ? onNativeKeyboard(follow) : null
    return () => {
      cancelAnimationFrame(frame)
      offNative?.()
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      vv?.removeEventListener('resize', follow)
      // 閉じた後は開く前の場所へ（確認ダイアログを開いた時は、ダイアログが閉じた後にここへ戻る）
      const back = focusBack.current ?? (previous.current instanceof HTMLElement ? previous.current : null)
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body || el?.contains(active))) {
        back.focus({ preventScroll: true })
      }
    }
  }, [])

  const row = layout === 'row'
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let j = -1
    if (e.key === 'ArrowDown' || (row && e.key === 'ArrowRight')) j = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp' || (row && e.key === 'ArrowLeft')) j = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = buttons.length - 1
    // Esc は上の document の捕捉の段階で受ける
    else if (e.key === 'Tab') {
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
      className={`pm-menu${row ? ' is-row' : ''}`}
      role="menu"
      id={menuId}
      aria-label={label}
      aria-orientation={row ? 'horizontal' : undefined}
      onKeyDown={onKey}
      // 右クリックでメニューの上にブラウザのメニューを重ねない
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={keepFocus ? keepFocusHandler : undefined}
      onMouseDown={keepFocus ? keepFocusHandler : undefined}
      style={row ? ({ ...HIDDEN, '--pm-cols': items.length } as CSSProperties) : HIDDEN}
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
          aria-label={it.ariaLabel}
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
