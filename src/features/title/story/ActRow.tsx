// 幕に分けた話の、幕の1行（第1幕…）。行全体が幕の画面へのリンク。
// 右クリック・長押し・「…」で操作メニュー（さらに分ける・次の幕とつなぐ）。
// 行ごとの値（ActRowData）だけを受け取って React.memo で包む（幕が変わった行だけを描き直す）。
import { memo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { bodyMetrics, formatCount } from '../../../domain/text'
import { paths } from '../../../routes'
import { ChevronRightIcon, MoreIcon } from '../../../ui/icons'
import { LazyRubySegments } from '../../../ui/RubyText'
import { ProgressMeter } from './ProgressMeter'
import { useRowMenu } from './RowMenu'
import { excerptSegments, type ActRowData } from './storyLogic'

function ActRowView({ act, version, label, fullLabel, progress }: ActRowData) {
  const menu = useRowMenu({ type: 'act', id: act.id })
  const excerptRef = useRef<HTMLSpanElement>(null)
  const excerpt = version ? excerptSegments(version.body, 60) : []
  return (
    <li className={`story-act${version ? '' : ' is-missing'}`} data-testid="act-row" data-act-id={act.id}>
      <div className="story-row-main story-act-main" {...menu?.handlers}>
        <Link to={paths.piece(act.titleId, act.id)} className="story-act-link" aria-label={fullLabel}>
          <span className="story-act-head">
            <span className="story-act-label" data-testid="act-label">
              {label}
            </span>
            {version ? (
              <span className="badge badge-active" data-testid="act-adopted">
                採用: {version.name.trim() || '無題の稿'}・{formatCount(bodyMetrics(version).chars)}字
              </span>
            ) : (
              <span className="badge badge-missing" data-testid="act-missing">
                採用原稿なし
              </span>
            )}
            <ProgressMeter percent={progress} hasActive={version !== null} what="この幕" />
          </span>
          {excerpt.length > 0 ? (
            <span ref={excerptRef} className="story-row-excerpt story-act-excerpt">
              <LazyRubySegments segments={excerpt} watch={excerptRef} />
            </span>
          ) : null}
          <ChevronRightIcon className="icon story-row-chevron" />
        </Link>
        {menu ? (
          <button
            type="button"
            className="icon-btn story-row-more"
            aria-label={`${fullLabel}の操作`}
            title="操作（さらに分ける・次の幕とつなぐ）"
            aria-haspopup="menu"
            onClick={(e) => menu.openFrom(e.currentTarget)}
            data-testid="act-more"
          >
            <MoreIcon />
          </button>
        ) : null}
      </div>
    </li>
  )
}

export const ActRow = memo(ActRowView)
