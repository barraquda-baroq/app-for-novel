// 本編の一覧の1行（第n話 / 特殊ブロック）。行全体が原稿画面へのリンク。
// 編集モードでは並べ替え・移動・削除のボタンが出る。
// 長編でも1か所の変更で全行を描き直さないよう、行ごとの値（PieceRowData）だけを受け取って React.memo で包む。
// 行には進捗（この話の終わりがタイトル全体の何 % の位置か）を出す。抜粋のルビ・傍点は読むための表示にする。
import { memo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCount } from '../../../domain/text'
import { trashNotice } from '../../../domain/trash'
import type { ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { ChevronRightIcon, DownIcon, MoveIcon, TrashIcon, UpIcon } from '../../../ui/icons'
import { RubySegments } from '../../../ui/RubyText'
import { MoveDialog } from './MoveDialog'
import { progressDescription, progressLabel, summarize, type PieceRowData } from './storyLogic'
import { useKeepMovedInPlace } from './useKeepMovedInPlace'

export interface PieceRowProps extends PieceRowData {
  edit: boolean
  /**
   * ↑↓（step）または「移動…」（dialog）で動かした後に呼ばれる
   * （章ページで章の外へ出たことを知らせる・折りたたんだ章に入ったら開く等）。
   * 行を描き直さずに済むよう、親は同じ関数を渡し続けること
   */
  onMoved?: (pieceId: ID, via: 'step' | 'dialog') => void
}

const UP = '[data-testid="piece-up"]'
const DOWN = '[data-testid="piece-down"]'

function PieceRowView({
  piece,
  version,
  versionCount,
  label,
  fullLabel,
  edit,
  canUp,
  canDown,
  canDelete,
  deleteReason,
  progress,
  onMoved,
}: PieceRowProps) {
  const [moving, setMoving] = useState(false)
  const special = piece.kind === 'special'
  const pieceId = piece.id
  const { ref, move } = useKeepMovedInPlace<HTMLLIElement>(pieceId)

  // 動かした行が押した指の下に残るように（続けて押すとそのまま動かし続けられる）。
  // 端に着いて押せなくなったら反対向きのボタンにフォーカスする
  const step = (dir: -1 | 1) => {
    move(
      () => {
        if (!attempt(() => (actions.movePieceStep(pieceId, dir), true))) return false
        onMoved?.(pieceId, 'step')
        return true
      },
      dir < 0 ? [UP, DOWN] : [DOWN, UP],
    )
  }

  const remove = async () => {
    if (!canDelete) {
      notifyError(deleteReason ?? '削除できません')
      return
    }
    const ok = await confirmDialog({
      title: `「${fullLabel}」を削除しますか？`,
      message: trashNotice(`この話のすべての推敲バージョン（${versionCount}稿）もいっしょに`),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deletePiece(pieceId), true))) notify(`「${fullLabel}」をゴミ箱に移しました`)
  }

  return (
    <li
      ref={ref}
      className={`story-row${special ? ' is-special' : ''}${version ? '' : ' is-missing'}${edit ? ' is-editing' : ''}`}
      data-testid="piece-row"
      data-kind={piece.kind}
      data-piece-id={pieceId}
    >
      <PieceRowLink piece={piece} version={version} versionCount={versionCount} label={label} progress={progress} />

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
            className={`btn btn-sm btn-danger${canDelete ? '' : ' story-is-disabled'}`}
            onClick={() => void remove()}
            aria-disabled={!canDelete}
            title={canDelete ? '削除' : deleteReason}
            data-testid="piece-delete"
          >
            <TrashIcon />
            削除
          </button>
        </div>
      ) : null}
      {moving ? (
        <MoveDialog pieceId={pieceId} onClose={() => setMoving(false)} onMoved={() => onMoved?.(pieceId, 'dialog')} />
      ) : null}
    </li>
  )
}

export const PieceRow = memo(PieceRowView)

/** 進捗の細い棒と「34%」。説明は読み上げとマウスを乗せた時に出す */
function ProgressMeter({ percent, hasActive }: { percent: number | null; hasActive: boolean }) {
  const description = progressDescription(percent, hasActive)
  return (
    <span
      className="story-row-progress"
      role="img"
      aria-label={description}
      title={description}
      data-testid="piece-progress"
      data-progress={percent ?? ''}
    >
      <span className="story-row-progress-bar" aria-hidden="true">
        <span className="story-row-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="story-row-progress-value" aria-hidden="true">
        {progressLabel(percent)}
      </span>
    </span>
  )
}

/** 行のリンク部分（見出し・採用中の稿・進捗・抜粋）。編集モードの切り替えでは描き直さない */
const PieceRowLink = memo(function PieceRowLink({
  piece,
  version,
  versionCount,
  label,
  progress,
}: Pick<PieceRowData, 'piece' | 'version' | 'versionCount' | 'label' | 'progress'>) {
  const { active, excerpt } = summarize(version, versionCount)
  const special = piece.kind === 'special'
  return (
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
        {active ? (
          <span className="badge badge-active" data-testid="piece-adopted">
            採用: {active.name}・{formatCount(active.chars)}字
          </span>
        ) : (
          <span className="badge badge-missing" data-testid="piece-missing">
            採用原稿なし
          </span>
        )}
        <span className="story-row-versions">全{versionCount}稿</span>
        <ProgressMeter percent={progress} hasActive={version !== null} />
      </span>
      {excerpt.length > 0 ? (
        <span className="story-row-excerpt" data-testid="piece-excerpt">
          <RubySegments segments={excerpt} />
        </span>
      ) : null}
      <ChevronRightIcon className="icon story-row-chevron" />
    </Link>
  )
})
