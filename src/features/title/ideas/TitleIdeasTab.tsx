// TODO: 実装予定 — このタイトルのアイデア
import type { ID } from '../../../domain/types'

export function TitleIdeasTab({ titleId }: { titleId: ID }) {
  return <p className="muted" data-title-id={titleId}>このタイトルのアイデア（準備中）</p>
}
