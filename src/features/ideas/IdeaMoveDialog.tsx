// アイデアを別の仕切り（タイトル／どのタイトルにも属さない）へ移すダイアログ。
import { useMemo } from 'react'
import { ideaSections } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { BookIcon, CheckIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { ideaShortLabel, moveTargets, sectionKey } from './ideaLogic'
import { InboxIcon } from './ideaIcons'

export function IdeaMoveDialog({ ideaId, onClose }: { ideaId: ID; onClose: () => void }) {
  const data = useData()
  const idea = data.ideas[ideaId]
  const sections = useMemo(() => ideaSections(data), [data])
  const targets = useMemo(
    () => (idea ? moveTargets(sections, idea, (id) => Boolean(data.titles[id])) : []),
    [sections, idea, data.titles],
  )
  if (!idea) return null
  const label = ideaShortLabel(idea)

  const move = (titleId: ID | null, name: string) => {
    const ok = attempt(() => (actions.moveIdeaToSection(idea.id, titleId), true))
    if (ok) notify(`「${name}」へ移動しました`)
    onClose()
  }

  return (
    <Modal
      title="アイデアを移動"
      onClose={onClose}
      initialFocus="[data-autofocus]"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          キャンセル
        </button>
      }
    >
      <p className="idea-move-lead small muted">「{label}」の移動先を選んでください。移動先の仕切りの最後に入ります。</p>
      <ul className="idea-move-list" data-testid="idea-move-dialog">
        {targets.map((t, i) => {
          const firstChoice = targets.findIndex((x) => !x.current)
          return (
            <li key={sectionKey(t.titleId)}>
              <button
                type="button"
                className={`idea-move-option${t.current ? ' is-current' : ''}${t.titleId === null ? ' is-unassigned' : ''}`}
                onClick={() => move(t.titleId, t.name)}
                disabled={t.current}
                aria-current={t.current ? 'true' : undefined}
                data-autofocus={i === firstChoice ? true : undefined}
                data-testid="idea-move-option"
                data-section={sectionKey(t.titleId)}
              >
                <span className="idea-move-icon" aria-hidden="true">
                  {t.titleId === null ? <InboxIcon /> : <BookIcon />}
                </span>
                <span className="idea-move-name">{t.name}</span>
                {t.current ? (
                  <span className="idea-move-current">
                    <CheckIcon />
                    現在の場所
                  </span>
                ) : (
                  <span className="idea-move-count">{t.count}件</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}
