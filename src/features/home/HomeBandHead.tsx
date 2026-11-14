// ホームの帯（2.9）の見出し。見出しの中のボタンに名前と件数を入れ、押すと帯を開け閉めする（閉じていても件数が分かる）。
// 見出しのボタンは、右の追加のボタンまでの幅いっぱいに広げ、帯（見出しの行）のほかの所（左の余白・ボタンの間・説明の文・折り返した行の空き）を
// 押しても開け閉めする（ボタン・リンク・入力の上と、文字を選んだ時は除く。キーボードと読み上げは見出しのボタンで操作する）。
// 追加のボタン（actions）は閉じていても出す。帯の中身（bodyId）は閉じている間は描かない（aria-controls は開いている時だけ）。
// 領域（section）と一覧は `${headingId}-name` を名前にする（件数を2度読み上げないように）。
import type { ComponentType, MouseEvent, ReactNode, SVGProps } from 'react'
import { ChevronRightIcon } from '../../ui/icons'
import type { HomeView } from './homeLogic'

export interface HomeBandHeadProps {
  area: HomeView
  headingId: string
  /** 帯の中身の id（開いている時だけ aria-controls で指す） */
  bodyId: string
  open: boolean
  onToggle: () => void
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  count: number
  /** 件数の data-testid（title-count・idea-total・bench-count・material-count） */
  countTestId: string
  /** 見出しの右に置くボタン（追加など。閉じていても出す） */
  actions?: ReactNode
}

/** 帯を押しても開け閉めしない所（それぞれが自分の動きを持つ。見出しのボタンも自分で開け閉めする） */
const OWN_CLICK = 'button, a, input, select, textarea, label, [role="button"], [contenteditable]'

/**
 * 見出しの行を押した時に開け閉めするか（ボタンなどの上と、その行の中で文字を選んだ時は除く）。追加のボタンが開くダイアログ
 * （portal。React の上ではこの行の子）の中のクリックもここへ伝わるので、画面の上でこの行の中にあるものだけを見る
 */
export function togglesBand(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented || e.button !== 0) return false
  const target = e.target
  if (!(target instanceof Node) || !e.currentTarget.contains(target)) return false
  if (target instanceof Element ? target.closest(OWN_CLICK) : target.parentElement?.closest(OWN_CLICK)) return false
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return false
  return true
}

export function HomeBandHead({
  area,
  headingId,
  bodyId,
  open,
  onToggle,
  icon: Icon,
  label,
  count,
  countTestId,
  actions,
}: HomeBandHeadProps) {
  return (
    <div
      className="home-pane-head"
      data-testid="home-band-head"
      onClick={(e) => {
        if (togglesBand(e)) onToggle()
      }}
    >
      <h2 id={headingId} className="home-band-title">
        <button
          type="button"
          id={`${headingId}-toggle`}
          className="home-band-toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={onToggle}
          data-testid="home-band-toggle"
          data-area={area}
        >
          <ChevronRightIcon className="icon home-band-chevron" />
          <Icon className="icon home-pane-icon" />
          <span id={`${headingId}-name`} className="home-band-name">
            {label}
          </span>
          <span className="home-pane-count">
            <span data-testid={countTestId}>{count}</span>
            <span className="visually-hidden">件</span>
          </span>
        </button>
      </h2>
      {actions}
    </div>
  )
}

/** 帯の中身の id（見出しの id から作る） */
export function bandBodyId(headingId: string): string {
  return `${headingId}-body`
}
