// 思いついたことをすぐに書きとめる入力欄。追加先の仕切りを選べる（既定は「どのタイトルにも属さない」）。
// 書きかけの内容はこの端末に一時保存しておく。追加すると「表示」で追加したカードへ移れる（入力欄はそのまま使い続けられる）。
import { useEffect, useId, useRef, useState } from 'react'
import type { IdeaSection } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt } from '../../store/uiStore'
import { CheckIcon, PlusIcon } from '../../ui/icons'
import { isSubmitShortcut, sectionDisplayName, sectionKey, submitShortcutLabel, titleIdFromKey, UNASSIGNED_KEY } from './ideaLogic'
import { revealIdea } from './reveal'
import { readLocal, writeLocal } from './storage'

/** 追加したことの表示を出しておく時間（ミリ秒） */
const ADDED_NOTICE_MS = 10000
import './ideas.css'

export interface QuickCaptureProps {
  /** 選べる仕切り。fixedTitleId を指定した場合は使わない */
  sections?: IdeaSection[]
  /** 追加先を固定する（タイトルのアイデアタブ）。undefined なら選べる */
  fixedTitleId?: ID | null
  /** 固定した追加先の名前 */
  fixedName?: string
  /** 書きかけを保存するキー（画面ごとに分ける） */
  draftKey: string
  /** 「表示」を押した時（折りたたんだ仕切りを開くなど）。省略時はカードまでスクロールする */
  onReveal?: (ideaId: ID, titleId: ID | null) => void
}

export function QuickCapture({ sections = [], fixedTitleId, fixedName, draftKey, onReveal }: QuickCaptureProps) {
  const inputId = useId()
  const selectId = useId()
  const storageKey = `novel-studio:idea-draft:${draftKey}`
  const [text, setText] = useState(() => readLocal(storageKey) ?? '')
  const [target, setTarget] = useState<string>(UNASSIGNED_KEY)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fixed = fixedTitleId !== undefined
  const [added, setAdded] = useState<{ id: ID; titleId: ID | null; name: string; seq: number } | null>(null)

  useEffect(() => {
    if (!added) return
    const timer = setTimeout(() => setAdded(null), ADDED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [added])

  // 選んでいたタイトルが削除されたら「どのタイトルにも属さない」に戻す
  const validTarget = fixed || sections.some((s) => sectionKey(s.titleId) === target) ? target : UNASSIGNED_KEY

  useEffect(() => {
    writeLocal(storageKey, text ? text : null)
  }, [storageKey, text])

  const titleId = fixed ? (fixedTitleId ?? null) : titleIdFromKey(validTarget)
  const targetName = fixed
    ? (fixedName ?? '')
    : sectionDisplayName(sections.find((s) => sectionKey(s.titleId) === validTarget) ?? { titleId: null, name: '' })
  const canAdd = text.trim().length > 0

  const add = () => {
    if (!canAdd) return
    const id = attempt(() => actions.addIdea(titleId, '', text.replace(/\s+$/u, '')))
    if (!id) return
    setText('')
    setAdded((prev) => ({ id, titleId, name: targetName, seq: (prev?.seq ?? 0) + 1 }))
    // 追加したカードが見えていれば少しの間目立たせる（スクロールはしない）
    revealIdea(id, false)
    ref.current?.focus({ preventScroll: true })
  }

  const show = () => {
    if (!added) return
    if (onReveal) onReveal(added.id, added.titleId)
    else revealIdea(added.id, true)
    setAdded(null)
  }

  return (
    <form
      className="idea-capture"
      data-testid="quick-capture"
      onSubmit={(e) => {
        e.preventDefault()
        add()
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        アイデアをすばやく追加
      </label>
      <textarea
        ref={ref}
        id={inputId}
        className="textarea idea-capture-input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitShortcut({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })) {
            e.preventDefault()
            add()
          }
        }}
        placeholder="思いついたことを書きとめる…"
        data-testid="quick-idea-input"
      />
      <div className="idea-capture-row">
        {fixed ? (
          <span className="idea-capture-fixed small muted">
            追加先: <strong>{targetName}</strong>
          </span>
        ) : (
          <span className="idea-capture-target">
            <label htmlFor={selectId} className="idea-capture-target-label">
              追加先
            </label>
            <select
              id={selectId}
              className="select idea-capture-select"
              value={validTarget}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="quick-idea-target"
            >
              {sections.map((s) => (
                <option key={sectionKey(s.titleId)} value={sectionKey(s.titleId)}>
                  {sectionDisplayName(s)}
                </option>
              ))}
            </select>
          </span>
        )}
        {fixed ? null : <span className="grow" />}
        <span className="idea-capture-hint hide-mobile">{submitShortcutLabel()}</span>
        <button type="submit" className="btn btn-primary idea-capture-add" disabled={!canAdd} data-testid="quick-idea-add">
          <PlusIcon />
          追加
        </button>
      </div>
      <div className="idea-capture-status" role="status" data-testid="quick-idea-status">
        {added ? (
          <p key={added.seq} className="idea-capture-added">
            <CheckIcon />
            <span className="idea-capture-added-text">「{added.name}」に追加しました</span>
            <button type="button" className="btn btn-sm btn-ghost idea-capture-show" onClick={show} data-testid="quick-idea-show">
              表示
            </button>
          </p>
        ) : null}
      </div>
    </form>
  )
}
