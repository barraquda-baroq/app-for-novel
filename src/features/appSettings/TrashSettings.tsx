// ゴミ箱: 削除したものが30日間残ることの説明と、ゴミ箱の画面へのリンク。
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { TRASH_RETENTION_DAYS } from '../../domain/trash'
import { paths } from '../../routes'
import { useApp } from '../../store/appStore'
import { TrashIcon } from '../../ui/icons'

const LEAD = `削除したタイトル・話・推敲バージョン・メモ・アイデア・設定項目・応募計画は、ゴミ箱に${TRASH_RETENTION_DAYS}日間残り、その間は元の場所に戻せます。${TRASH_RETENTION_DAYS}日たつと自動で完全に削除されます。`

export function TrashSettings() {
  const id = useId()
  const count = useApp((s) => Object.keys(s.data.trashEntries).length)
  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="trash-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>ゴミ箱</h2>
        <p className="aset-card-lead">{LEAD}</p>
      </div>
      <div className="aset-actions">
        <Link to={paths.trash()} className="btn" data-testid="open-trash">
          <TrashIcon />
          ゴミ箱を開く（{count.toLocaleString('ja-JP')}件）
        </Link>
      </div>
    </section>
  )
}
