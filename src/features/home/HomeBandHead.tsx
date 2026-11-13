// ホームの帯（2.9）の見出し。見出しの中のボタンに名前と件数を入れ、押すと帯を開け閉めする（閉じていても件数が分かる）。
// 追加のボタン（actions）は閉じていても出す。帯の中身（bodyId）は閉じている間は描かない（aria-controls は開いている時だけ）。
// 領域（section）と一覧は `${headingId}-name` を名前にする（件数を2度読み上げないように）。
import type { ComponentType, ReactNode, SVGProps } from 'react'
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
    <div className="home-pane-head">
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
      <span className="grow" />
      {actions}
    </div>
  )
}

/** 帯の中身の id（見出しの id から作る） */
export function bandBodyId(headingId: string): string {
  return `${headingId}-body`
}
