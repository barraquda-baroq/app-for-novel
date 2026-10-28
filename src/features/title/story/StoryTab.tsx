// 本編タブ: 設定項目の帯・本編（章／第n話／特殊ブロック）・メモ（一番下）。
import { useMemo, useState } from 'react'
import { episodeTargets } from '../../../domain/storyOps'
import { effectiveNumbering, episodeNumbers, flatten, locatePiece, pieceFullLabel } from '../../../domain/structure'
import type { ID, NumberingMode } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { EditIcon, FolderIcon, PlusIcon } from '../../../ui/icons'
import { AddDialog, type AddKind } from './AddDialog'
import { ChapterBlock } from './ChapterBlock'
import { NUMBERING_LABELS, changeNumbering, toggleChapters } from './chapterFlows'
import { MemoSection } from './MemoSection'
import { PieceRow } from './PieceRow'
import { SettingStrip } from './SettingStrip'
import { chapterName, stepAvailability } from './storyLogic'
import { useCollapsedChapters } from './useCollapsed'
import './story.css'

interface AddRequest {
  kind?: AddKind
  chapterId?: ID
}

export function StoryTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const title = data.titles[titleId]
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState<AddRequest | null>(null)
  const { collapsed, toggle: toggleCollapsed, expand } = useCollapsedChapters(titleId)

  const numbers = useMemo(() => episodeNumbers(data, titleId), [data, titleId])
  const flat = useMemo(() => flatten(data, titleId), [data, titleId])
  const steps = useMemo(() => (edit ? stepAvailability(data, titleId) : {}), [edit, data, titleId])
  const targetIds = useMemo(() => new Set(episodeTargets(data, titleId).map((t) => t.chapterId)), [data, titleId])

  if (!title) return null
  const chaptersOn = title.chaptersEnabled
  const perChapter = effectiveNumbering(title) === 'perChapter'
  const isEmpty = chaptersOn ? title.structure.length === 0 : flat.length === 0

  /** 折りたたんだ章に話を動かしたら、見えなくならないようにその章を開いて知らせる */
  const onPieceMoved = (pieceId: ID, via: 'step' | 'dialog') => {
    const d = getData()
    const slot = locatePiece(d, pieceId)
    if (!d.titles[titleId]?.chaptersEnabled || !slot?.chapterId || !collapsed.has(slot.chapterId)) return
    expand(slot.chapterId)
    // 「移動…」はダイアログ側で知らせるので、↑↓ の時だけ
    if (via !== 'step') return
    const p = d.pieces[pieceId]
    notify(`「${p ? pieceFullLabel(d, p) : '話'}」を「${chapterName(d.chapters[slot.chapterId])}」へ移動しました`)
  }

  const addChapter = () => {
    const id = attempt(() => actions.addChapter(titleId))
    if (id) notify(`「${getData().chapters[id]?.name ?? '新しい章'}」を追加しました`)
  }

  return (
    <div className="story-tab">
      <SettingStrip titleId={titleId} />

      <section className="section story-main" aria-labelledby="story-main-heading">
        <div className="story-toolbar">
          <h2 id="story-main-heading" className="story-toolbar-title">
            本編
          </h2>
          <div className="story-toolbar-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAdding({})} data-testid="add-button">
              <PlusIcon />
              追加
            </button>
            <button
              type="button"
              className={`btn${edit ? ' story-toggle-on' : ''}`}
              aria-pressed={edit}
              onClick={() => setEdit((v) => !v)}
              data-testid="edit-toggle"
            >
              <EditIcon />
              {edit ? '編集を終える' : '編集'}
            </button>
          </div>
          <span className="grow" />
          <label className="switch story-chapter-switch" data-testid="chapters-switch">
            <input
              type="checkbox"
              role="switch"
              checked={chaptersOn}
              onChange={(e) => void toggleChapters(titleId, e.target.checked)}
            />
            <span className="track" aria-hidden="true" />
            <span className="story-chapter-switch-label">章で管理する</span>
          </label>
        </div>

        {chaptersOn ? (
          <div className="story-chapter-tools">
            <div className="story-numbering">
              <span className="story-numbering-label" id="story-numbering-label">
                話数
              </span>
              <div className="segmented" role="group" aria-labelledby="story-numbering-label">
                {(['continuous', 'perChapter'] as NumberingMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={title.numbering === mode}
                    onClick={() => void changeNumbering(titleId, mode)}
                    data-testid={`numbering-${mode}`}
                  >
                    {NUMBERING_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={addChapter} data-testid="add-chapter">
              <FolderIcon />
              章を追加
            </button>
          </div>
        ) : null}

        {edit ? (
          <div className="story-edit-help" role="note" data-testid="edit-help">
            <p>
              <strong>並べ替え:</strong> ↑↓
              で1つずつ、「移動…」で位置を選んで動かせます。並べ替えると話数は並び順どおりに振り直されます
              {chaptersOn ? '（章の先頭から↑で章の外へ、章の外から章の方へ動かすと章の端に入ります）' : ''}。
            </p>
            <p>
              <strong>削除:</strong> 話数が途中で抜けないように、削除できるのは{perChapter ? '各章の' : ''}
              <strong>最後の話だけ</strong>
              です。たとえば第1〜4話のうち第2話を消したいときは、第2話を並べ替えで最後（第4話）に移動してから削除します。特殊ブロックはいつでも削除できます。
            </p>
          </div>
        ) : null}

        {isEmpty ? (
          <div className="empty story-empty" data-testid="story-empty">
            まだ話がありません。「＋追加」から第1話を作成しましょう。
          </div>
        ) : (
          <ol className={`story-list${chaptersOn ? ' is-tree' : ''}`} data-testid="story-list">
            {chaptersOn
              ? title.structure.map((node) => {
                  if (node.type === 'piece') {
                    const piece = data.pieces[node.id]
                    if (!piece) return null
                    return (
                      <PieceRow
                        key={piece.id}
                        data={data}
                        piece={piece}
                        numbers={numbers}
                        edit={edit}
                        canUp={steps[piece.id]?.up ?? false}
                        canDown={steps[piece.id]?.down ?? false}
                        onMoved={onPieceMoved}
                      />
                    )
                  }
                  const chapter = data.chapters[node.id]
                  if (!chapter) return null
                  return (
                    <ChapterBlock
                      key={chapter.id}
                      data={data}
                      chapter={chapter}
                      numbers={numbers}
                      edit={edit}
                      steps={steps}
                      collapsed={collapsed.has(chapter.id)}
                      onToggleCollapsed={() => toggleCollapsed(chapter.id)}
                      canAddEpisode={targetIds.has(chapter.id)}
                      onAddEpisode={(chapterId) => setAdding({ kind: 'episode', chapterId })}
                      onPieceMoved={onPieceMoved}
                    />
                  )
                })
              : flat.map((f) => {
                  const piece = data.pieces[f.pieceId]
                  return (
                    <PieceRow
                      key={piece.id}
                      data={data}
                      piece={piece}
                      numbers={numbers}
                      edit={edit}
                      canUp={steps[piece.id]?.up ?? false}
                      canDown={steps[piece.id]?.down ?? false}
                    />
                  )
                })}
          </ol>
        )}

        {!isEmpty ? (
          <button type="button" className="story-add-more" onClick={() => setAdding({})} data-testid="add-button-bottom">
            <PlusIcon />
            追加（話数追加・特殊追加・メモ）
          </button>
        ) : null}
      </section>

      <MemoSection titleId={titleId} />

      {adding ? (
        <AddDialog titleId={titleId} presetKind={adding.kind} chapterId={adding.chapterId} onClose={() => setAdding(null)} />
      ) : null}
    </div>
  )
}
