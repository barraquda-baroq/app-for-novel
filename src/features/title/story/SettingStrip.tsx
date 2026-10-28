// 本編タブの上部に出す「設定項目」の帯。タイトルに入ったらすぐ設定項目が見えるようにする。
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { categoriesOf } from '../../../domain/entityOps'
import type { ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { useData } from '../../../store/appStore'
import { ChevronRightIcon } from '../../../ui/icons'
import { entryCounts } from './storyLogic'

export function SettingStrip({ titleId }: { titleId: ID }) {
  const data = useData()
  const categories = useMemo(() => categoriesOf(data, titleId), [data, titleId])
  const counts = useMemo(
    () =>
      entryCounts(
        data,
        categories.map((c) => c.id),
      ),
    [data, categories],
  )
  const settingsPath = paths.title(titleId, 'settings')

  return (
    <section className="story-settings" aria-labelledby="story-settings-heading" data-testid="settings-strip">
      <h2 id="story-settings-heading" className="story-settings-title">
        設定項目
      </h2>
      <ul className="story-settings-chips">
        {categories.length === 0 ? <li className="small muted">まだありません</li> : null}
        {categories.map((c) => {
          const name = c.name.trim() || '無題の設定項目'
          return (
            <li key={c.id}>
              <Link
                to={`${settingsPath}&cat=${encodeURIComponent(c.id)}`}
                className="story-settings-chip"
                data-testid="setting-chip"
                aria-label={`${name}（${counts[c.id] ?? 0}件）`}
                title={name}
              >
                <span className="story-settings-chip-name">{name}</span>
                <span className="story-settings-chip-count">{counts[c.id] ?? 0}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      <Link to={settingsPath} className="btn btn-ghost btn-sm story-settings-open">
        設定項目を開く
        <ChevronRightIcon />
      </Link>
    </section>
  )
}
