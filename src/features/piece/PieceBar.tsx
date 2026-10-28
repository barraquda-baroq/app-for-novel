// 原稿画面の上部バー: 第n話（変更不可）／特殊ブロックの見出し、話の題、前後の話、表示の設定。
// 幕の画面では「第3話　話の題　第2幕」（話の題は属する話のもの）、前後は同じ話の中の幕。
import { useId, useRef, useState } from 'react'
import type { ID, Piece } from '../../domain/types'
import { usePrefs, type SplitOrientation } from '../../store/uiStore'
import { useMediaQuery } from '../../ui/hooks'
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons'
import { PopupMenu, type PopupMenuItem } from '../../ui/PopupMenu'
import { ActsIcon } from '../acts/actIcons'
import { useDismiss } from './editing'
import type { EditorHub } from './editorHub'
import { COMPACT_QUERY, RATIO_MAX, RATIO_MIN, ratioToSlider, sliderToRatio } from './logic'
import { LockIcon, SlidersIcon } from './pieceIcons'
import { pieceField } from './session'
import { SessionInput } from './SessionField'

const LOCK_HINT = '話数は並び順で自動的に決まり、変更できません'

const ORIENTATIONS: { value: SplitOrientation; label: string; hint: string }[] = [
  { value: 'auto', label: '自動', hint: '画面の幅に合わせる（広い画面は左右、スマホは上下）' },
  { value: 'horizontal', label: '左右', hint: '採用原稿を左、推敲バージョンを右に並べる' },
  { value: 'vertical', label: '上下', hint: '採用原稿を上、推敲バージョンを下に並べる' },
]

interface NavTarget {
  id: ID
  label: string
}

export interface PieceBarProps {
  piece: Piece
  /** 話数・題を出す話（幕なら属する話。それ以外は piece と同じ） */
  episode: Piece
  /** 幕なら「第2幕」 */
  actLabel: string | null
  /** 「幕」メニューの項目（開いた時に作る）。幕に分けられない話（特殊ブロック・採用原稿なし）は null */
  actMenu: (() => PopupMenuItem[]) | null
  /** 話の題・見出しの編集（保存ボタンで確定する） */
  hub: EditorHub
  label: string
  prev: NavTarget | null
  next: NavTarget | null
  onNavigate: (id: ID) => void
  comparing: boolean
  showDiff: boolean
  onShowDiffChange: (v: boolean) => void
  scrollSync: boolean
  onScrollSyncChange: (v: boolean) => void
}

export function PieceBar({
  piece,
  episode,
  actLabel,
  actMenu,
  hub,
  label,
  prev,
  next,
  onNavigate,
  comparing,
  showDiff,
  onShowDiffChange,
  scrollSync,
  onScrollSyncChange,
}: PieceBarProps) {
  const orientation = usePrefs((s) => s.splitOrientation)
  const ratio = usePrefs((s) => s.splitRatio)
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [menuOpen, setMenuOpen] = useState(false)
  const [acts, setActs] = useState<{ anchor: HTMLElement; items: PopupMenuItem[] } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useDismiss(menuOpen, viewRef, () => setMenuOpen(false))

  // 高さの低い画面（スマホの横持ちなど）では上部バーを1行にし、比率も「表示の設定」の中に入れる
  const compact = useMediaQuery(COMPACT_QUERY)

  const sliderValue = ratioToSlider(ratio)
  const noun = actLabel ? '幕' : '話'
  const compareHint = comparing ? undefined : '推敲バージョンを選んで比較するときに使えます'

  const ratioControl = (
    <label className="pw-ratio" title="採用原稿と推敲バージョンの表示比率">
      <span className="pw-ratio-label">比率</span>
      <input
        type="range"
        min={RATIO_MIN}
        max={RATIO_MAX}
        step={1}
        value={sliderValue}
        onChange={(e) => setPrefs({ splitRatio: sliderToRatio(Number(e.target.value)) })}
        aria-label="表示比率"
        aria-valuetext={`採用原稿 ${sliderValue}%・推敲バージョン ${100 - sliderValue}%`}
        data-testid="ratio-slider"
      />
      <span className="pw-ratio-value" aria-hidden="true">
        {sliderValue}:{100 - sliderValue}
      </span>
    </label>
  )

  return (
    <div className="pw-bar" data-testid="piece-bar">
      <button
        type="button"
        className="btn pw-nav pw-prev"
        disabled={!prev}
        onClick={() => prev && onNavigate(prev.id)}
        aria-label={prev ? `前の${noun}（${prev.label}）` : `前の${noun}`}
        title={prev ? `前の${noun}：${prev.label}` : `前の${noun}はありません`}
        data-testid="prev-piece"
      >
        <ChevronLeftIcon />
        <span className="pw-nav-text">前の{noun}</span>
      </button>

      <div className="pw-ident">
        {piece.kind !== 'special' ? (
          <span className="pw-label" data-testid="piece-label" title={LOCK_HINT}>
            <span className="pw-label-text">{label}</span>
            <LockIcon className="icon pw-lock" />
            <span className="visually-hidden">（{LOCK_HINT}）</span>
          </span>
        ) : (
          <span className="pw-label pw-label-special">
            <span className="badge badge-special">特殊</span>
            <SessionInput
              key={piece.id}
              hub={hub}
              fieldKey={pieceField(piece.id, 'label')}
              stored={piece.label}
              className="input-bare pw-label-input"
              placeholder="見出し（例：プロローグ）"
              aria-label="見出し（特殊ブロック）"
              data-testid="special-label-input"
              maxLength={60}
            />
          </span>
        )}
        <SessionInput
          key={episode.id}
          hub={hub}
          fieldKey={pieceField(episode.id, 'subtitle')}
          stored={episode.subtitle}
          className="input pw-subtitle"
          placeholder="話の題（任意）"
          aria-label={actLabel ? '話の題（すべての幕の見出しに入ります）' : '話の題'}
          data-testid="subtitle-input"
        />
        {actLabel ? (
          <span className="pw-act-label" data-testid="act-label" title="幕の番号は話の中の並び順で決まります">
            {actLabel}
          </span>
        ) : null}
        {actMenu ? (
          <button
            type="button"
            className="btn pw-acts-btn"
            aria-haspopup="menu"
            aria-expanded={acts !== null}
            aria-label={actLabel ? '幕の操作（さらに分ける・次の幕とつなぐ・セパレート解除）' : '幕に分ける（セパレート）'}
            title={actLabel ? '幕の操作' : '幕に分ける（セパレート）'}
            onClick={(e) => {
              const anchor = e.currentTarget
              setActs((open) => (open ? null : { anchor, items: actMenu() }))
            }}
            data-testid="acts-menu-button"
          >
            <ActsIcon />
            <span className="pw-acts-btn-text">{actLabel ? '幕の操作' : 'セパレート'}</span>
          </button>
        ) : null}
        {acts ? (
          <PopupMenu
            label={actLabel ? `${label}　${actLabel}の操作` : `${label}を幕に分ける`}
            items={acts.items}
            placement={{ anchor: acts.anchor }}
            onClose={() => setActs(null)}
            returnFocus={acts.anchor}
            testId="acts-menu"
          />
        ) : null}
      </div>

      <button
        type="button"
        className="btn pw-nav pw-next"
        disabled={!next}
        onClick={() => next && onNavigate(next.id)}
        aria-label={next ? `次の${noun}（${next.label}）` : `次の${noun}`}
        title={next ? `次の${noun}：${next.label}` : `次の${noun}はありません`}
        data-testid="next-piece"
      >
        <span className="pw-nav-text">次の{noun}</span>
        <ChevronRightIcon />
      </button>

      <div className={`pw-view${menuOpen ? ' is-open' : ''}`} ref={viewRef}>
        {compact ? null : ratioControl}

        <label
          className={`switch pw-switch${comparing ? '' : ' is-disabled'}`}
          title={compareHint ?? '採用原稿との違いを色分けして表示します'}
        >
          <input
            type="checkbox"
            checked={showDiff}
            disabled={!comparing}
            onChange={(e) => onShowDiffChange(e.target.checked)}
            data-testid="diff-toggle"
          />
          <span className="track" aria-hidden="true" />
          <span>差分</span>
        </label>

        <button
          type="button"
          className="icon-btn pw-view-toggle"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={compact ? '表示の設定（比率・分割の向き・スクロール同期）' : '表示の設定（分割の向き・スクロール同期）'}
          title="表示の設定"
          onClick={() => setMenuOpen((o) => !o)}
          data-testid="view-menu-button"
        >
          <SlidersIcon />
        </button>

        <div className="pw-view-more" id={menuId}>
          {compact ? ratioControl : null}
          <div className="segmented" role="group" aria-label="分割の向き">
            {ORIENTATIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={orientation === o.value}
                title={o.hint}
                onClick={() => setPrefs({ splitOrientation: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label
            className={`switch pw-switch${comparing ? '' : ' is-disabled'}`}
            title={compareHint ?? '2つの原稿のスクロール位置を揃えます'}
          >
            <input
              type="checkbox"
              checked={scrollSync}
              disabled={!comparing}
              onChange={(e) => onScrollSyncChange(e.target.checked)}
              data-testid="scroll-sync-toggle"
            />
            <span className="track" aria-hidden="true" />
            <span>スクロール同期</span>
          </label>
        </div>
      </div>
    </div>
  )
}
