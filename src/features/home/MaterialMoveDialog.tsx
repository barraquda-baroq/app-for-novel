// 資料を位置を選んで移動するダイアログ（ホームの棚「資料」の並び）。相対比較の BenchMoveDialog と同じ作り。
import { useId, useMemo, useState } from 'react'
import { sortedMaterials } from '../../domain/materialOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { positionOptions } from '../ideas/ideaLogic'
import { materialName } from '../materials/materialLogic'

export function MaterialMoveDialog({ materialId, onClose }: { materialId: ID; onClose: () => void }) {
  const materials = useData().materials
  const formId = useId()
  const list = useMemo(() => sortedMaterials({ materials }), [materials])
  const currentIndex = list.findIndex((m) => m.id === materialId)
  const options = useMemo(
    () => positionOptions(list.filter((m) => m.id !== materialId).map((m) => materialName(m))),
    [list, materialId],
  )
  const [selected, setSelected] = useState(() => Math.max(0, currentIndex))
  const material = materials[materialId]
  if (!material) return null
  const unchanged = selected === currentIndex

  const submit = () => {
    if (unchanged) return
    if (attempt(() => (actions.moveMaterialTo(materialId, selected), true))) notify(`「${materialName(material)}」を移動しました`)
    onClose()
  }

  return (
    <Modal
      title={`「${materialName(material)}」を移動`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={unchanged} data-testid="material-move-submit">
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        data-testid="material-move-dialog"
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
            data-testid="material-move-target"
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
          {unchanged ? '現在の位置です。移動先を選んでください。' : '資料の棚の並びが変わります。'}
        </p>
      </form>
    </Modal>
  )
}
