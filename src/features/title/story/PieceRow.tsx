// 本編の一覧の1行（第n話 / 特殊ブロック）。行全体が原稿画面へのリンク。
// 編集モードでは並べ替え・移動・削除のボタンが出る。
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { canDeletePiece, pieceFullLabel, pieceLabel } from '../../../domain/structure'
import { formatCount } from '../../../domain/text'
import type { AppData, ID, Piece } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { ChevronRightIcon, DownIcon, MoveIcon, TrashIcon, UpIcon } from '../../../ui/icons'
import { MoveDialog } from './MoveDialog'
import { pieceSummary } from './storyLogic'

export interface PieceRowProps {
  data: AppData
  piece: Piece
  numbers: Record<ID, number>
  edit: boolean
  canUp: boolean
  canDown: boolean
  /** 1つ上/下へ動かした後に呼ばれる（章ページで章の外へ出たことを知らせる等） */
  onStepped?: (pieceId: ID) => void
}

export function PieceRow({ data, piece, numbers, edit, canUp, canDown, onStepped }: PieceRowProps) {
  const [moving, setMoving] = useState(false)
  const summary = pieceSummary(data, piece)
  const label = pieceLabel(data, piece, numbers)
  const fullLabel = pieceFullLabel(data, piece, numbers)
  const special = piece.kind === 'special'
  const del = edit ? canDeletePiece(data, piece.id) : { ok: false }

  const step = (dir: -1 | 1) => {
    attempt(() => actions.movePieceStep(piece.id, dir))
    onStepped?.(piece.id)
  }

  const remove = async () => {
    if (!del.ok) {
      notifyError(del.reason ?? '削除できません')
      return
    }
    const ok = await confirmDialog({
      title: `「${fullLabel}」を削除しますか？`,
      message: `この話のすべての推敲バージョン（${summary.versionCount}稿）も削除されます。元に戻すことはできません。`,
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    attempt(() => actions.deletePiece(piece.id))
    notify(`「${fullLabel}」を削除しました`)
  }

  return (
    <li
      className={`story-row${special ? ' is-special' : ''}${summary.active ? '' : ' is-missing'}${edit ? ' is-editing' : ''}`}
      data-testid="piece-row"
      data-kind={piece.kind}
    >
      <Link to={paths.piece(piece.titleId, piece.id)} className="story-row-link">
        <span className="story-row-head">
          <span className="story-row-label" data-testid="piece-label">
            {label}
          </span>
          {special ? <span className="badge badge-special">特殊</span> : null}
          {piece.subtitle.trim() ? (
            <span className="story-row-subtitle" data-testid="piece-subtitle">
              {piece.subtitle.trim()}
            </span>
          ) : (
            <span className="story-row-subtitle is-empty">（題なし）</span>
          )}
        </span>
        <span className="story-row-meta">
          {summary.active ? (
            <span className="badge badge-active" data-testid="piece-adopted">
              採用: {summary.active.name}・{formatCount(summary.active.chars)}字
            </span>
          ) : (
            <span className="badge badge-missing" data-testid="piece-missing">
              採用原稿がありません
            </span>
          )}
          <span className="story-row-versions">全{summary.versionCount}稿</span>
        </span>
        {summary.excerpt ? <span className="story-row-excerpt">{summary.excerpt}</span> : null}
        <ChevronRightIcon className="icon story-row-chevron" />
      </Link>

      {edit ? (
        <div className="story-row-edit" role="group" aria-label={`${fullLabel}の操作`}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={!canUp}
            aria-label="上へ"
            title="1つ上へ"
            data-testid="piece-up"
          >
            <UpIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(1)}
            disabled={!canDown}
            aria-label="下へ"
            title="1つ下へ"
            data-testid="piece-down"
          >
            <DownIcon />
          </button>
          <span className="story-row-edit-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setMoving(true)} data-testid="piece-move">
            <MoveIcon />
            移動…
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-danger${del.ok ? '' : ' story-is-disabled'}`}
            onClick={() => void remove()}
            aria-disabled={!del.ok}
            title={del.ok ? '削除' : del.reason}
            data-testid="piece-delete"
          >
            <TrashIcon />
            削除
          </button>
        </div>
      ) : null}
      {moving ? <MoveDialog pieceId={piece.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
}
