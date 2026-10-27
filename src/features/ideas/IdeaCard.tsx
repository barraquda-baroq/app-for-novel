// アイデア1件のカード。見出し（任意）＋内容（長い場合は6行で折りたたみ）と、編集・移動・並べ替え・削除。
import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Idea } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatRelative } from '../../ui/browser'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { DownIcon, EditIcon, MoveIcon, TrashIcon, UpIcon } from '../../ui/icons'
import { IdeaEditorModal } from './IdeaEditorModal'
import { IdeaMoveDialog } from './IdeaMoveDialog'
import { scrollToTop } from '../home/scroll'
import { SparkIcon } from './ideaIcons'
import { ideaShortLabel, titleNameFromIdea } from './ideaLogic'

export interface IdeaCardProps {
  idea: Idea
  /** 表示している仕切りの名前（編集ダイアログに出す） */
  sectionName: string
  /** 「どのタイトルにも属さない」仕切りにあるか（「この案でタイトルを作る」を出す） */
  unassigned: boolean
  first: boolean
  last: boolean
}

/** 内容が折りたたみ表示（6行）からはみ出しているか */
function useOverflow(text: string, expanded: boolean) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (expanded) return
      setOverflow(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])
  return [ref, overflow] as const
}

export function IdeaCard({ idea, sectionName, unassigned, first, last }: IdeaCardProps) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const heading = idea.heading.trim()
  const body = idea.body
  const [bodyRef, overflow] = useOverflow(body, expanded)
  const label = ideaShortLabel(idea)

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'アイデアを削除しますか？',
      message: `「${label}」を削除します。元に戻すことはできません。`,
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    attempt(() => actions.deleteIdea(idea.id))
  }

  const makeTitle = async () => {
    const name = await promptDialog({
      title: 'この案でタイトルを作る',
      label: 'タイトル名（このアイデアは新しいタイトルの仕切りへ移ります）',
      initial: titleNameFromIdea(idea),
      placeholder: '例: 星の海の図書館',
      confirmLabel: '作成',
    })
    if (name === null) return
    const titleId = attempt(() => {
      const id = actions.createTitle(name.trim())
      actions.moveIdeaToSection(idea.id, id)
      return id
    })
    if (!titleId) return
    notify(`タイトル「${getData().titles[titleId]?.name ?? name.trim()}」を作成し、アイデアを移しました`)
    scrollToTop()
    navigate(paths.title(titleId))
  }

  return (
    <li className="idea-card" data-testid="idea-card" data-idea-id={idea.id}>
      <div className="idea-card-main">
        {heading ? (
          <h4 className="idea-card-heading" data-testid="idea-heading">
            {heading}
          </h4>
        ) : null}
        {body.trim() ? (
          <p ref={bodyRef} className={`idea-card-body${expanded ? ' is-expanded' : ''}`} data-testid="idea-body">
            {body}
          </p>
        ) : null}
        {overflow || expanded ? (
          <button
            type="button"
            className="idea-card-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            data-testid="idea-more"
          >
            {expanded ? '折りたたむ' : '続きを表示'}
          </button>
        ) : null}
      </div>

      <div className="idea-card-actions" role="group" aria-label={`「${label}」の操作`}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => attempt(() => actions.moveIdeaStep(idea.id, -1))}
          disabled={first}
          aria-label="上へ"
          title="1つ上へ"
          data-testid="idea-up"
        >
          <UpIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => attempt(() => actions.moveIdeaStep(idea.id, 1))}
          disabled={last}
          aria-label="下へ"
          title="1つ下へ"
          data-testid="idea-down"
        >
          <DownIcon />
        </button>
        <time className="idea-card-time" dateTime={new Date(idea.updatedAt).toISOString()} title={`更新: ${formatDateTime(idea.updatedAt)}`}>
          {formatRelative(idea.updatedAt)}
        </time>
        <span className="grow" />
        {unassigned ? (
          <button type="button" className="btn btn-sm btn-ghost idea-card-make" onClick={() => void makeTitle()} data-testid="idea-make-title">
            <SparkIcon />
            この案でタイトルを作る
          </button>
        ) : null}
        <span className="idea-card-buttons">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMoving(true)} data-testid="idea-move">
            <MoveIcon />
            移動
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)} data-testid="idea-edit">
            <EditIcon />
            編集
          </button>
          <button
            type="button"
            className="icon-btn idea-card-delete"
            onClick={() => void remove()}
            aria-label="削除"
            title="削除"
            data-testid="idea-delete"
          >
            <TrashIcon />
          </button>
        </span>
      </div>

      {editing ? (
        <IdeaEditorModal
          mode="edit"
          sectionName={sectionName}
          initialHeading={idea.heading}
          initialBody={idea.body}
          onClose={() => setEditing(false)}
          onSave={(h, b) => {
            attempt(() => actions.updateIdea(idea.id, { heading: h, body: b }))
            setEditing(false)
          }}
        />
      ) : null}
      {moving ? <IdeaMoveDialog ideaId={idea.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
}
