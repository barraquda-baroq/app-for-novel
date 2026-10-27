// 章フォルダ（本編タブのツリー表示）。中に話を並べ、章ごとの操作を持つ。
import { Link } from 'react-router-dom'
import { formatCount } from '../../../domain/text'
import type { AppData, Chapter, ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { confirmDialog, promptDialog } from '../../../ui/dialogs'
import { ChevronRightIcon, DownIcon, EditIcon, FolderIcon, PlusIcon, UpIcon, XIcon } from '../../../ui/icons'
import { PieceRow } from './PieceRow'
import { chapterName, chapterStats, chapterStepAvailability } from './storyLogic'

export const CHAPTER_ADD_BLOCKED_REASON =
  '通し番号では、新しい話は必ず最新の話数になるため、最新話より前の章には話数追加できません。最新話のある章以降に追加してから、並べ替えで移動してください。'

export interface ChapterBlockProps {
  data: AppData
  chapter: Chapter
  numbers: Record<ID, number>
  edit: boolean
  steps: Record<ID, { up: boolean; down: boolean }>
  collapsed: boolean
  onToggleCollapsed: () => void
  /** この章に話数追加できるか（episodeTargets に含まれるか） */
  canAddEpisode: boolean
  onAddEpisode: (chapterId: ID) => void
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
  const ok = await confirmDialog({
    title: `「${name}」を解除しますか？`,
    message:
      (count > 0
        ? `中の話（${count}件）は削除されません。章があった位置に、そのままの並び順で章の外に置かれます。`
        : 'この章には話がありません。') + (chapter.note.trim() ? '\n\n章のメモは削除されます。' : ''),
    confirmLabel: '章を解除',
    danger: true,
  })
  if (!ok) return false
  attempt(() => actions.removeChapter(chapter.id))
  notify(`「${name}」を解除しました`)
  return true
}

export function ChapterBlock({
  data,
  chapter,
  numbers,
  edit,
  steps,
  collapsed,
  onToggleCollapsed,
  canAddEpisode,
  onAddEpisode,
}: ChapterBlockProps) {
  const stats = chapterStats(data, chapter.id)
  const chStep = chapterStepAvailability(data, chapter.id)
  const name = chapterName(chapter)
  const pieces = chapter.pieceIds.map((id) => data.pieces[id]).filter(Boolean)
  const bodyId = `chapter-body-${chapter.id}`

  return (
    <li className={`story-chapter${collapsed ? ' is-collapsed' : ''}`} data-testid="chapter-block" data-chapter-id={chapter.id}>
      <div className="story-chapter-head">
        <button
          type="button"
          className="icon-btn story-chapter-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? `${name}を開く` : `${name}を折りたたむ`}
          onClick={onToggleCollapsed}
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
            {stats.missingActive > 0 ? <span className="badge badge-missing">採用なし {stats.missingActive}</span> : null}
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
            名前変更
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => attempt(() => actions.moveChapterStep(chapter.id, -1))}
            disabled={!chStep.up}
            aria-label="章を上へ"
            title="章を1つ上へ"
            data-testid="chapter-up"
          >
            <UpIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => attempt(() => actions.moveChapterStep(chapter.id, 1))}
            disabled={!chStep.down}
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
            onClick={() => void releaseChapter(data, chapter)}
            data-testid="chapter-remove"
          >
            <XIcon />
            章を解除
          </button>
        </div>
      ) : null}

      <div id={bodyId} className="story-chapter-body" hidden={collapsed}>
        {pieces.length === 0 ? (
          <p className="story-chapter-empty">この章にはまだ話がありません。</p>
        ) : (
          <ol className="story-list story-chapter-list">
            {pieces.map((p) => (
              <PieceRow
                key={p.id}
                data={data}
                piece={p}
                numbers={numbers}
                edit={edit}
                canUp={steps[p.id]?.up ?? false}
                canDown={steps[p.id]?.down ?? false}
              />
            ))}
          </ol>
        )}
      </div>
    </li>
  )
}
