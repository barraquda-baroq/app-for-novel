// アイデアを別の仕切り（タイトル／どのタイトルにも属さない）へ、または同じ仕切りの中の別の位置へ移すダイアログ。
// 位置は移動先の仕切りの、済みでないアイデアの中で選べる（既定は末尾）。済みのアイデアは位置を選ばない（移動先でも下にまとまる）。
import { useId, useMemo, useState } from 'react'
import { ideaSections, isIdeaChecked } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { BookIcon, CheckIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { ideaShortLabel, moveTargets, positionOptions, sectionKey, titleIdFromKey } from './ideaLogic'
import { InboxIcon } from './ideaIcons'

export function IdeaMoveDialog({ ideaId, onClose }: { ideaId: ID; onClose: () => void }) {
  const data = useData()
  const formId = useId()
  const idea = data.ideas[ideaId]
  const sections = useMemo(() => ideaSections(data), [data])
  const targets = useMemo(
    () => (idea ? moveTargets(sections, idea, (id) => Boolean(data.titles[id])) : []),
    [sections, idea, data.titles],
  )
  // 既定はほかの仕切りの先頭（今の仕切りの中で動かす時は「現在の場所」を選ぶ）
  const [target, setTarget] = useState<string>(() => {
    const first = targets.find((t) => !t.current) ?? targets[0]
    return first ? sectionKey(first.titleId) : sectionKey(null)
  })
  /** 移動後の位置。null = 末尾 */
  const [position, setPosition] = useState<number | null>(null)

  const chosen = targets.find((t) => sectionKey(t.titleId) === target) ?? null
  const section = sections.find((s) => sectionKey(s.titleId) === target)
  const checked = idea ? isIdeaChecked(idea) : false
  // 位置は済みでないアイデアの中で数える（済みのものは済みにした順で下にまとまる）
  const open = useMemo(() => (section ? section.ideas.filter((i) => !isIdeaChecked(i)) : []), [section])
  const others = useMemo(() => open.filter((i) => i.id !== ideaId), [open, ideaId])
  const options = useMemo(() => positionOptions(others.map((i) => ideaShortLabel(i))), [others])
  const currentIndex = chosen?.current ? open.findIndex((i) => i.id === ideaId) : -1
  const index = position === null ? others.length : Math.min(position, others.length)
  const option = options.find((o) => o.index === index)

  if (!idea || !chosen) return null
  const label = ideaShortLabel(idea)
  const unchanged = chosen.current && (checked || index === currentIndex)

  const choose = (key: string) => {
    setTarget(key)
    setPosition(null)
  }

  const submit = () => {
    if (unchanged) return
    const ok = attempt(() => (actions.moveIdeaTo(idea.id, titleIdFromKey(target), index), true))
    if (ok) notify(chosen.current ? '並び順を変えました' : `「${chosen.name}」へ移動しました`)
    onClose()
  }

  return (
    <Modal
      title="アイデアを移動"
      onClose={onClose}
      initialFocus="input[type=radio]:checked"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={unchanged} data-testid="idea-move-submit">
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="idea-move"
        data-testid="idea-move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="idea-move-lead small muted">
          {checked ? `「${label}」の移動先を選んでください。` : `「${label}」の移動先と、その中の位置を選んでください。`}
        </p>
        <fieldset className="idea-move-fieldset">
          <legend className="idea-move-legend">移動先</legend>
          <ul className="idea-move-list">
            {targets.map((t) => {
              const key = sectionKey(t.titleId)
              const selected = key === target
              return (
                <li key={key}>
                  <label
                    className={`idea-move-option${selected ? ' is-selected' : ''}${t.current ? ' is-current' : ''}${t.titleId === null ? ' is-unassigned' : ''}`}
                    data-testid="idea-move-option"
                    data-section={key}
                  >
                    <input
                      type="radio"
                      className="visually-hidden"
                      name={`${formId}-target`}
                      value={key}
                      checked={selected}
                      onChange={() => choose(key)}
                    />
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
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
        {checked ? null : (
          <label className="field idea-move-position">
            <span>位置</span>
            <select
              className="select"
              value={index}
              onChange={(e) => setPosition(Number(e.target.value))}
              data-testid="idea-move-position"
            >
              {options.map((o) => (
                <option key={o.index} value={o.index}>
                  {o.label}
                  {o.index === currentIndex ? '（現在の位置）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="idea-move-summary small muted" role="status" data-testid="idea-move-summary">
          {checked
            ? unchanged
              ? '現在の場所です。移動先を選んでください。'
              : `「${chosen.name}」に移ります。済みのまま、済みのアイデアと一緒に下にまとまります。`
            : unchanged
              ? '現在の位置です。移動先か位置を選んでください。'
              : `「${chosen.name}」の${option ? option.label.replace(/（\d+番目）$/u, '') : '末尾'}に入ります。`}
        </p>
      </form>
    </Modal>
  )
}
