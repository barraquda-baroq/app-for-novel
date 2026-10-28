// ヘッダーのゴミ箱へのリンク（アイコンボタン）。ホームの右上に置く。
import { Link } from 'react-router-dom'
import { paths } from '../../routes'
import { useApp } from '../../store/appStore'
import { TrashIcon } from '../../ui/icons'

export function TrashLink() {
  const count = useApp((s) => Object.keys(s.data.trashEntries).length)
  const label = count > 0 ? `ゴミ箱（${count.toLocaleString('ja-JP')}件）` : 'ゴミ箱'
  return (
    <Link to={paths.trash()} className="icon-btn" aria-label={label} title={label} data-testid="trash-link">
      <TrashIcon />
    </Link>
  )
}
