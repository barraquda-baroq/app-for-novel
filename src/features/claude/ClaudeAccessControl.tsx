// タイトルの設定「Claude に見せる: 見せない／読むだけ／読む＋書き込む」（Title.claudeAccess。無い = 読む＋書き込む）。
// タイトル画面の集計の並びのチップから選ぶ。コネクタはこの設定で、タイトルを見せるか・推敲案などを足せるかを決める。
import { useState } from 'react'
import { claudeAccessLabel, claudeAccessOf, CLAUDE_ACCESS_OPTIONS } from '../../claude/visibility'
import type { ClaudeAccess, Title } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt, notify } from '../../store/uiStore'
import { CheckIcon } from '../../ui/icons'
import { PopupMenu } from '../../ui/PopupMenu'
import { SparkIcon } from './claudeIcons'
import './claude.css'

export const CLAUDE_ACCESS_HINTS: Record<ClaudeAccess, string> = {
  none: 'Claude のコネクタにこのタイトルを出しません',
  read: '採用原稿・すべての稿・設定などを読めますが、推敲案などは足せません',
  write: '読んで、推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果を足せます（本文は書き換えません）',
}

export function ClaudeAccessControl({ title }: { title: Title }) {
  const access = claudeAccessOf(title)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const choose = (value: ClaudeAccess) => {
    if (value === access && title.claudeAccess !== undefined) return
    if (attempt(() => (actions.setTitleClaudeAccess(title.id, value), true)))
      notify(`Claude に見せる: ${claudeAccessLabel(value)}にしました`)
  }
  return (
    <>
      <button
        type="button"
        className={`tpage-chip cl-access-chip is-${access}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title="Claude に見せるか（Claude 用のコネクタ）"
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        data-testid="claude-access-chip"
        data-access={access}
      >
        <SparkIcon />
        <span className="cl-access-label">Claude に見せる:</span>
        <span className="cl-access-value">{claudeAccessLabel(access)}</span>
      </button>
      {anchor ? (
        <PopupMenu
          label="Claude に見せる"
          placement={{ anchor }}
          returnFocus={anchor}
          onClose={() => setAnchor(null)}
          testId="claude-access-menu"
          items={CLAUDE_ACCESS_OPTIONS.map((o) => ({
            label: o.label,
            hint: CLAUDE_ACCESS_HINTS[o.value],
            icon: o.value === access ? <CheckIcon /> : <span className="cl-access-blank" />,
            onSelect: () => choose(o.value),
            testId: `claude-access-${o.value}`,
          }))}
        />
      ) : null}
    </>
  )
}
