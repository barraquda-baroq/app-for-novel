// アイデア領域の仕切り1つ分（タイトルごと、または「どのタイトルにも属さない」）。
// ホームでは折りたたみでき、タイトル画面のアイデアタブでは常に開いた状態で使う。
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IdeaSection } from '../../domain/entityOps'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { attempt, notify } from '../../store/uiStore'
import { BookIcon, ChevronRightIcon, PlusIcon } from '../../ui/icons'
import { IdeaCard } from './IdeaCard'
import { IdeaEditorModal } from './IdeaEditorModal'
import { InboxIcon } from './ideaIcons'
import { ideaModalDraftKey, sectionDisplayName, sectionKey } from './ideaLogic'
import './ideas.css'

export interface IdeaSectionViewProps {
  section: IdeaSection
  /** 折りたためるか（ホーム）。false なら常に開いている（タイトルのアイデアタブ） */
  collapsible?: boolean
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** 見出しの横に「開く」（タイトル画面へのリンク）を出す */
  showOpenLink?: boolean
  /** 見出しの表記を変える（省略時は仕切りの名前） */
  heading?: string
}

export function IdeaSectionView({
  section,
  collapsible = false,
  collapsed = false,
  onToggleCollapsed,
  showOpenLink,
  heading,
}: IdeaSectionViewProps) {
  const bodyId = useId()
  const [adding, setAdding] = useState(false)
  const name = sectionDisplayName(section)
  const unassigned = section.titleId === null
  const count = section.ideas.length
  const isCollapsed = collapsible && collapsed
  const key = sectionKey(section.titleId)

  const add = (h: string, b: string) => {
    const id = attempt(() => actions.addIdea(section.titleId, h, b))
    if (id) notify(`「${name}」にアイデアを追加しました`)
    setAdding(false)
  }

  const titleContent = (
    <>
      <span className="idea-section-mark" aria-hidden="true">
        {unassigned ? <InboxIcon /> : <BookIcon />}
      </span>
      <span className="idea-section-name" data-testid="idea-section-name">
        {heading ?? name}
      </span>
      <span className="idea-section-count" data-testid="idea-section-count" data-count={count}>
        {count}
        <span className="visually-hidden">件</span>
      </span>
    </>
  )

  return (
    <section
      id={`idea-section-${key}`}
      className={`idea-section${unassigned ? ' is-unassigned' : ''}${isCollapsed ? ' is-collapsed' : ''}`}
      data-testid="idea-section"
      data-section={key}
      aria-label={`アイデア: ${name}`}
    >
      <div className="idea-section-head">
        {collapsible ? (
          <button
            type="button"
            className="idea-section-title is-toggle"
            aria-expanded={!isCollapsed}
            aria-controls={bodyId}
            onClick={onToggleCollapsed}
            data-testid="idea-section-toggle"
          >
            <ChevronRightIcon className="icon idea-section-chevron" />
            {titleContent}
          </button>
        ) : (
          <h3 className="idea-section-title">{titleContent}</h3>
        )}
        {showOpenLink && section.titleId ? (
          <Link
            to={paths.title(section.titleId)}
            className="btn btn-sm btn-ghost idea-section-open"
            aria-label={`タイトル「${name}」を開く`}
          >
            開く
          </Link>
        ) : null}
        <button
          type="button"
          className="btn btn-sm idea-section-add"
          onClick={() => setAdding(true)}
          aria-label={`「${name}」にアイデアを追加`}
          title="アイデアを追加"
          data-testid="idea-add"
        >
          <PlusIcon />
          <span className="idea-section-add-label">追加</span>
        </button>
      </div>

      <div id={bodyId} className="idea-section-body" hidden={isCollapsed}>
        {count === 0 ? (
          <button type="button" className="idea-section-empty" onClick={() => setAdding(true)} data-testid="idea-section-empty">
            <span>まだアイデアはありません。</span>
            <span className="idea-section-empty-add">
              <PlusIcon />
              ここに追加
            </span>
          </button>
        ) : (
          <ul className="idea-list">
            {section.ideas.map((idea, i) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                sectionName={name}
                unassigned={unassigned}
                first={i === 0}
                last={i === count - 1}
              />
            ))}
          </ul>
        )}
      </div>

      {adding ? (
        <IdeaEditorModal
          mode="add"
          sectionName={name}
          draftKey={ideaModalDraftKey({ mode: 'add', section: key })}
          onSave={add}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </section>
  )
}
