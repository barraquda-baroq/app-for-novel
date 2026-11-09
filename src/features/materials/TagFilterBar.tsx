// 棚のタグのチップの列（資料の棚（2.6）と相対比較の棚（2.7）で共通）: 使っているタグを数つきで並べ、押すと絞る
// （いくつか選ぶと、選んだタグをすべて持つものだけ。もう一度押すと外す）。タグが多い時は初めの12個だけを出し、
// 「すべてのタグ（n）」で全部（選んでいるタグはいつも出す）。「タグの選択を解除」「タグを管理」も。
// タグが1つも無い時は、付け方の案内だけを出す。
import { useState } from 'react'
import { TagIcon, XIcon } from '../../ui/icons'
import type { TagChip } from './materialLogic'
import './tags.css'

/** 棚のタグのチップを初めから出す数（それより多ければ「すべてのタグ（n）」で開く。選んでいるタグはいつも出す） */
export const TAG_CHIPS_SHOWN = 12

export function TagFilterBar({
  chips,
  selected,
  onToggle,
  onClear,
  onManage,
  testIdPrefix,
  groupLabel,
  hint,
  countUnit = '件',
}: {
  chips: readonly TagChip[]
  /** 選んでいるタグ（tagKey の形） */
  selected: readonly string[]
  onToggle: (key: string) => void
  onClear: () => void
  onManage: () => void
  /** data-testid の頭（material-tag-chip など。相対比較は bench で、色も相対比較の色にする） */
  testIdPrefix: 'material' | 'bench'
  /** チップの列の読み上げの名前 */
  groupLabel: string
  /** タグが1つも無い時の案内 */
  hint: string
  /** チップの数の読み上げの単位（既定「件」。相対比較は「作品」） */
  countUnit?: string
}) {
  const [all, setAll] = useState(false)
  const tid = (name: string) => `${testIdPrefix}-${name}`
  if (!chips.length)
    return (
      <p className="small muted home-mat-tags-hint" data-testid={tid('tags-hint')}>
        {hint}
      </p>
    )
  const visible = all ? chips : chips.filter((c, i) => i < TAG_CHIPS_SHOWN || selected.includes(c.key))
  return (
    <div className={`home-mat-tagbar${testIdPrefix === 'bench' ? ' tag-bench' : ''}`}>
      <div className="home-mat-tags" role="group" aria-label={groupLabel} data-testid={tid('tags')}>
        {visible.map((c) => {
          const on = selected.includes(c.key)
          return (
            <button
              key={c.key}
              type="button"
              className={`home-mat-tag${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(c.key)}
              data-testid={tid('tag-chip')}
              data-tag={c.tag}
            >
              <span className="home-mat-tag-name">{c.tag}</span>
              <span className="home-mat-tag-count">
                {c.count}
                <span className="visually-hidden">{countUnit}</span>
              </span>
            </button>
          )
        })}
        {chips.length > TAG_CHIPS_SHOWN ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm home-mat-tags-more"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
            data-testid={tid('tags-more')}
          >
            {all ? 'タグを閉じる' : `すべてのタグ（${chips.length}）`}
          </button>
        ) : null}
      </div>
      <div className="home-mat-tag-actions">
        {selected.length ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} data-testid={tid('tags-clear')}>
            <XIcon />
            タグの選択を解除
          </button>
        ) : null}
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onManage} data-testid={tid('manage-tags-open')}>
          <TagIcon />
          タグを管理
        </button>
      </div>
    </div>
  )
}
