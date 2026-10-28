// タイトルを位置を選んで移動するダイアログ（アイデアの仕切りの並びも同じ順になる）。
import { useId, useMemo, useState } from 'react'
import { sortedTitles } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { positionOptions } from '../ideas/ideaLogic'

const displayName = (name: string) => name.trim() || '無題のタイトル'

export function TitleMoveDialog({ titleId, onClose }: { titleId: ID; onClose: () => void }) {
  const data = useData()
  const formId = useId()
  const titles = useMemo(() => sortedTitles(data), [data])
  const currentIndex = titles.findIndex((t) => t.id === titleId)
  const options = useMemo(() => positionOptions(titles.filter((t) => t.id !== titleId).map((t) => displayName(t.name))), [titles, titleId])
  const [selected, setSelected] = useState(() => Math.max(0, currentIndex))
  const title = data.titles[titleId]
  if (!title) return null
  const unchanged = selected === currentIndex

  const submit = () => {
    if (unchanged) return
    if (attempt(() => (actions.moveTitleTo(titleId, selected), true))) notify(`「${displayName(title.name)}」を移動しました`)
    onClose()
  }

  return (
    <Modal
      title={`「${displayName(title.name)}」を移動`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={unchanged} data-testid="title-move-submit">
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        data-testid="title-move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span>移動先</span>
          <select className="select" value={selected} onChange={(e) => setSelected(Number(e.target.value))} data-testid="title-move-target">
            {options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
                {o.index === currentIndex ? '（現在の位置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted" style={{ margin: 0 }} role="status">
          {unchanged ? '現在の位置です。移動先を選んでください。' : 'アイデアの仕切りもタイトルと同じ順に並びます。'}
        </p>
      </form>
    </Modal>
  )
}
