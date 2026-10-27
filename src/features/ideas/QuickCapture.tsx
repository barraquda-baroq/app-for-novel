// 思いついたことをすぐに書きとめる入力欄。追加先の仕切りを選べる（既定は「どのタイトルにも属さない」）。
// 書きかけの内容はこの端末に一時保存しておく。
import { useEffect, useId, useRef, useState } from 'react'
import type { IdeaSection } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt, notify } from '../../store/uiStore'
import { PlusIcon } from '../../ui/icons'
import { isSubmitShortcut, sectionDisplayName, sectionKey, submitShortcutLabel, titleIdFromKey, UNASSIGNED_KEY } from './ideaLogic'
import { readLocal, writeLocal } from './storage'
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
}

export function QuickCapture({ sections = [], fixedTitleId, fixedName, draftKey }: QuickCaptureProps) {
  const inputId = useId()
  const selectId = useId()
  const storageKey = `novel-studio:idea-draft:${draftKey}`
  const [text, setText] = useState(() => readLocal(storageKey) ?? '')
  const [target, setTarget] = useState<string>(UNASSIGNED_KEY)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fixed = fixedTitleId !== undefined

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
    notify(`「${targetName}」にアイデアを追加しました`)
    ref.current?.focus()
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
    </form>
  )
}
