// 章フォルダ（本編タブのツリー表示）。中に話を並べ、章ごとの操作を持つ。
import { memo } from 'react'
import { Link } from 'react-router-dom'
import { missingActiveLabel } from '../../../domain/entityOps'
import { formatCount } from '../../../domain/text'
import { trashNotice } from '../../../domain/trash'
import type { AppData, Chapter, ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { confirmDialog, promptDialog } from '../../../ui/dialogs'
import { ChevronRightIcon, DownIcon, EditIcon, FolderIcon, PlusIcon, UpIcon, XIcon } from '../../../ui/icons'
import { PieceRow } from './PieceRow'
import {
  chapterName,
  formatRenumbering,
  renumberingOnRelease,
  sameRows,
  shallowEqual,
  statsOf,
  type PieceRowData,
} from './storyLogic'
import { useKeepMovedInPlace } from './useKeepMovedInPlace'

export const CHAPTER_ADD_BLOCKED_REASON =
  '通し番号では、新しい話は必ず最新の話数になるため、最新話より前の章には話数追加できません。最新話のある章以降に追加してから、並べ替えで移動してください。'

export interface ChapterBlockProps {
  chapter: Chapter
  /** 章の中の話（並び順）。行ごとの値なので、変わった行だけが描き直される */
  rows: PieceRowData[]
  edit: boolean
  /** 章をタイトル直下の並びの中で上/下に動かせるか */
  canUp: boolean
  canDown: boolean
  collapsed: boolean
  onToggleCollapsed: (chapterId: ID) => void
  /** この章に話数追加できるか（episodeTargets に含まれるか） */
  canAddEpisode: boolean
  onAddEpisode: (chapterId: ID) => void
  /** 中の話を ↑↓・移動… で動かした後に呼ばれる */
  onPieceMoved?: (pieceId: ID, via: 'step' | 'dialog') => void
}

export async function renameChapter(chapter: Chapter): Promise<void> {
  const name = await promptDialog({ title: '章の名前を変更', label: '章の名前', initial: chapter.name, confirmLabel: '変更' })
  if (name === null) return
  attempt(() => actions.updateChapter(chapter.id, { name: name.trim() }))
}

/** 章を解除する（確認つき）。中の話は削除せず、章があった位置に章の外として並べる */
export async function releaseChapter(data: AppData, chapter: Chapter): Promise<boolean> {
  const count = chapter.pieceIds.filter((id) => data.pieces[id]).length
  const name = chapterName(chapter)
  // 章ごとに第1話から数えている時は、中の話（と後ろの章の外の話）の話数が変わる
  const renumbered = renumberingOnRelease(data, chapter.id)
  const ok = await confirmDialog({
    title: `「${name}」を解除しますか？`,
    message:
      (count > 0
        ? `中の話（${count}件）は削除されません。章があった位置に、そのままの並び順で章の外に置かれます。`
        : 'この章には話がありません。') +
      (renumbered.length > 0
        ? `\n\n話数を章ごとに数えているため、章の外の話として数え直され、話数が振り直されます（${formatRenumbering(renumbered)}）。`
        : '') +
      `\n\n${trashNotice(chapter.note.trim() ? '章（名前とメモ）を' : '章を')}`,
    confirmLabel: '章を解除',
    danger: true,
  })
  if (!ok) return false
  const removed = attempt(() => {
    actions.removeChapter(chapter.id)
    return true
  })
  if (!removed) return false
  notify(
    renumbered.length > 0
      ? `「${name}」を解除しました。話数を振り直しました（${formatRenumbering(renumbered, 2)}）`
      : `「${name}」を解除しました`,
  )
  return true
}

function ChapterBlockView({
  chapter,
  rows,
  edit,
  canUp,
  canDown,
  collapsed,
  onToggleCollapsed,
  canAddEpisode,
  onAddEpisode,
  onPieceMoved,
}: ChapterBlockProps) {
  const stats = statsOf(rows)
  const name = chapterName(chapter)
  const bodyId = `chapter-body-${chapter.id}`
  const { ref, move } = useKeepMovedInPlace<HTMLLIElement>(chapter.id)

  // 動かした章が押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="chapter-up"]' : '[data-testid="chapter-down"]'
    const other = dir < 0 ? '[data-testid="chapter-down"]' : '[data-testid="chapter-up"]'
    move(() => attempt(() => (actions.moveChapterStep(chapter.id, dir), true)), [same, other])
  }

  return (
    <li
      ref={ref}
      className={`story-chapter${collapsed ? ' is-collapsed' : ''}`}
      data-testid="chapter-block"
      data-chapter-id={chapter.id}
    >
      <div className="story-chapter-head">
        <button
          type="button"
          className="icon-btn story-chapter-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? `${name}を開く` : `${name}を折りたたむ`}
          onClick={() => onToggleCollapsed(chapter.id)}
          data-testid="chapter-collapse"
        >
          <ChevronRightIcon />
        </button>
        <FolderIcon className="icon story-chapter-folder" />
        <div className="story-chapter-title">
          <Link to={paths.chapter(chapter.titleId, chapter.id)} className="story-chapter-name" data-testid="chapter-name">
            {name}
          </Link>
          <span className="story-chapter-stats">
            <span>{stats.episodes}話</span>
            {stats.specials > 0 ? <span>特殊 {stats.specials}</span> : null}
            <span>{formatCount(stats.chars)}字</span>
            {stats.missingActive > 0 ? (
              <span className="badge badge-missing" data-testid="chapter-missing">
                {missingActiveLabel(stats.missingEpisodes, stats.missingSpecials)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="story-chapter-actions">
          <button
            type="button"
            className={`btn btn-sm${canAddEpisode ? '' : ' story-is-disabled'}`}
            aria-disabled={!canAddEpisode}
            title={canAddEpisode ? `${name}に話数追加` : CHAPTER_ADD_BLOCKED_REASON}
            onClick={() => (canAddEpisode ? onAddEpisode(chapter.id) : notifyError(CHAPTER_ADD_BLOCKED_REASON))}
            data-testid="chapter-add-episode"
          >
            <PlusIcon />
            話数追加
          </button>
        </div>
      </div>

      {edit ? (
        <div className="story-chapter-edit" role="group" aria-label={`${name}の操作`}>
          <button type="button" className="btn btn-sm" onClick={() => void renameChapter(chapter)} data-testid="chapter-rename">
            <EditIcon />
            名前を変更
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={!canUp}
            aria-label="章を上へ"
            title="章を1つ上へ"
            data-testid="chapter-up"
          >
            <UpIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(1)}
            disabled={!canDown}
            aria-label="章を下へ"
            title="章を1つ下へ"
            data-testid="chapter-down"
          >
            <DownIcon />
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => void releaseChapter(getData(), chapter)}
            data-testid="chapter-remove"
          >
            <XIcon />
            章を解除
          </button>
        </div>
      ) : null}

      <div id={bodyId} className="story-chapter-body" hidden={collapsed}>
        {rows.length === 0 ? (
          <p className="story-chapter-empty">この章にはまだ話がありません。</p>
        ) : (
          <ol className="story-list story-chapter-list">
            {rows.map((row) => (
              <PieceRow key={row.piece.id} {...row} edit={edit} onMoved={onPieceMoved} />
            ))}
          </ol>
        )}
      </div>
    </li>
  )
}

/** 章の中の行は要素ごとに比べ、ほかの値はそのまま比べる（変わった章だけを描き直す） */
function sameProps(a: ChapterBlockProps, b: ChapterBlockProps): boolean {
  const { rows: ra, ...restA } = a
  const { rows: rb, ...restB } = b
  return shallowEqual(restA, restB) && sameRows(ra, rb)
}

export const ChapterBlock = memo(ChapterBlockView, sameProps)
