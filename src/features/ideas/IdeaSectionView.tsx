// アイデア領域の仕切り1つ分（タイトルごと、または「どのタイトルにも属さない」）。
// ホームでは折りたたみでき、タイトル画面のアイデアタブでは常に開いた状態で使う。
// 済み（実装した・没にした）のアイデアは、済みでないものの下に「済み n件」の区切りを挟んでまとまる。
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { isIdeaChecked, type IdeaSection } from '../../domain/entityOps'
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
  /** 見出しの横に「タイトルへ」（タイトル画面へのリンク）を出す */
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
  // 件数は済みのものも含めた数（仕切りに入っているアイデアの数）。済みの数は区切りと読み上げで伝える
  const count = section.ideas.length
  const doneCount = section.ideas.reduce((n, i) => (isIdeaChecked(i) ? n + 1 : n), 0)
  const openCount = count - doneCount
  const isCollapsed = collapsible && collapsed
  const key = sectionKey(section.titleId)

  const add = (b: string) => {
    const id = attempt(() => actions.addIdea(section.titleId, '', b))
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
      <span
        className="idea-section-count"
        data-testid="idea-section-count"
        data-count={count}
        title={doneCount ? `${count}件（うち済み ${doneCount}件）` : undefined}
      >
        {count}
        <span className="visually-hidden">{doneCount ? `件（うち済み ${doneCount}件）` : '件'}</span>
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
            aria-label={`タイトルへ（${name}）`}
            title={`タイトル「${name}」の画面へ移動`}
            data-testid="idea-section-open"
          >
            タイトルへ
            <ChevronRightIcon />
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
            {/* 1つの平らな並びにする（済みにしたカードが動いても作り直さず、開いている編集ダイアログなどが残る） */}
            {section.ideas.flatMap((idea, i) => {
              const card = (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  sectionName={name}
                  unassigned={unassigned}
                  first={i === 0}
                  last={i === openCount - 1}
                />
              )
              // 済みのアイデアの前に区切り（並びは sortIdeas: 済みでないもの → 済み）
              if (i !== openCount) return [card]
              return [
                <li key="done-divider" className="idea-list-done" aria-hidden="true" data-testid="idea-done-divider">
                  済み {doneCount}件
                </li>,
                card,
              ]
            })}
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
