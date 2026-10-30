// ベンチ作品を位置を選んで移動するダイアログ（ホームの棚の並び）。
import { useId, useMemo, useState } from 'react'
import { sortedBenchWorks } from '../../domain/benchOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { workName } from '../bench/benchLogic'
import { positionOptions } from '../ideas/ideaLogic'

export function BenchMoveDialog({ workId, onClose }: { workId: ID; onClose: () => void }) {
  const benchWorks = useData().benchWorks
  const formId = useId()
  const works = useMemo(() => sortedBenchWorks({ benchWorks }), [benchWorks])
  const currentIndex = works.findIndex((w) => w.id === workId)
  const options = useMemo(() => positionOptions(works.filter((w) => w.id !== workId).map((w) => workName(w))), [works, workId])
  const [selected, setSelected] = useState(() => Math.max(0, currentIndex))
  const work = benchWorks[workId]
  if (!work) return null
  const unchanged = selected === currentIndex

  const submit = () => {
    if (unchanged) return
    if (attempt(() => (actions.moveBenchWorkTo(workId, selected), true))) notify(`「${workName(work)}」を移動しました`)
    onClose()
  }

  return (
    <Modal
      title={`「${workName(work)}」を移動`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={unchanged} data-testid="bench-move-submit">
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        data-testid="bench-move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span>移動先</span>
          <select
            className="select"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            data-testid="bench-move-target"
          >
            {options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
                {o.index === currentIndex ? '（現在の位置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted" style={{ margin: 0 }} role="status">
          {unchanged ? '現在の位置です。移動先を選んでください。' : 'ホームの棚の並びが変わります。'}
        </p>
      </form>
    </Modal>
  )
}
