// 「Claude が作成」の印（2.8: Claude が作ったアイデアのカード、2.9: Claude が作ったフォルダの見出し）。
// 見た目は Claude 連携の .badge.cl-badge と同じ（claude.css はホームで読み込まないので ideas.css に置く）。
// compact は狭い画面（719px まで）でアイコンだけにする（文字は読み上げには残す）。
import { SparkIcon as ClaudeMarkIcon } from '../claude/claudeIcons'
import { CLAUDE_IDEA_BADGE } from './ideaLogic'

export interface ClaudeMadeBadgeProps {
  /** 押さえた時の説明（「Claude がコネクタで作ったアイデア」など） */
  title: string
  testId: string
  /** 足すクラス（置き場所ごとの余白など） */
  className?: string
  /** 狭い画面ではアイコンだけにする */
  compact?: boolean
}

export function ClaudeMadeBadge({ title, testId, className, compact = false }: ClaudeMadeBadgeProps) {
  return (
    <span
      className={`badge idea-claude-badge${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      title={title}
    >
      <ClaudeMarkIcon />
      <span className="idea-claude-badge-label">{CLAUDE_IDEA_BADGE}</span>
    </span>
  )
}
