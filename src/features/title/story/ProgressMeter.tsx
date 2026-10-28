// 一覧の行の進捗: 細い棒と「34%」。説明は読み上げとマウスを乗せた時に出す。
import { progressDescription, progressLabel } from './storyLogic'

export function ProgressMeter({
  percent,
  hasActive,
  what = 'この話',
}: {
  percent: number | null
  hasActive: boolean
  /** 説明の主語（「この話」「この幕」） */
  what?: string
}) {
  const description = progressDescription(percent, hasActive, what)
  return (
    <span
      className="story-row-progress"
      role="img"
      aria-label={description}
      title={description}
      data-testid="piece-progress"
      data-progress={percent ?? ''}
    >
      <span className="story-row-progress-bar" aria-hidden="true">
        <span className="story-row-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="story-row-progress-value" aria-hidden="true">
        {progressLabel(percent)}
      </span>
    </span>
  )
}
