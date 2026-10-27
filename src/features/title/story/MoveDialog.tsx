// 話を位置を選んで移動するダイアログ。移動後は並び順どおりに話数が書き換わる。
import { useId, useMemo, useState } from 'react'
import { insertOptions } from '../../../domain/storyOps'
import { locatePiece, pieceFullLabel } from '../../../domain/structure'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { Modal } from '../../../ui/Modal'
import { findSlotIndex, previewMoveLabel } from './storyLogic'

export function MoveDialog({ pieceId, onClose }: { pieceId: ID; onClose: () => void }) {
  const data = useData()
  const formId = useId()
  const piece = data.pieces[pieceId]
  const options = useMemo(() => (piece ? insertOptions(data, piece.titleId, piece.id) : []), [data, piece])
  const currentIndex = useMemo(() => findSlotIndex(options, locatePiece(data, pieceId)), [data, options, pieceId])
  const [selected, setSelected] = useState(() => Math.max(0, currentIndex))
  const option = options[selected]
  const afterLabel = useMemo(
    () => (option && piece ? previewMoveLabel(data, piece.id, option.slot) : null),
    [data, option, piece],
  )

  if (!piece) return null
  const name = pieceFullLabel(data, piece)
  const unchanged = selected === currentIndex

  const submit = () => {
    if (!option || unchanged) return
    attempt(() => actions.movePiece(piece.id, option.slot))
    notify(piece.kind === 'episode' && afterLabel ? `移動しました（${afterLabel}になりました）` : '移動しました')
    onClose()
  }

  return (
    <Modal
      title={`「${name}」を移動`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!option || unchanged} data-testid="move-submit">
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        data-testid="move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span>移動先</span>
          <select className="select" value={selected} onChange={(e) => setSelected(Number(e.target.value))} data-testid="move-target">
            {options.map((o, i) => (
              <option key={i} value={i}>
                {o.label}
                {i === currentIndex ? '（現在の位置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted" style={{ margin: 0 }} role="status">
          {unchanged
            ? '現在の位置です。移動先を選んでください。'
            : piece.kind === 'episode'
              ? `移動すると、この話は「${afterLabel ?? '?'}」になります。ほかの話の話数も並び順どおりに振り直されます。`
              : '特殊ブロックは話数に数えないので、ほかの話の話数は変わりません。'}
        </p>
      </form>
    </Modal>
  )
}
