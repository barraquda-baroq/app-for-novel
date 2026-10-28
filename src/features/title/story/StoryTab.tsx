// 本編タブ: 設定項目の帯・本編（章／第n話／特殊ブロック）・メモ（一番下）。
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { titleProgress } from '../../../domain/progress'
import { episodeTargets } from '../../../domain/storyOps'
import { effectiveNumbering, flatten, locatePiece, pieceFullLabel } from '../../../domain/structure'
import type { ID, NumberingMode } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { EditIcon, FolderIcon, PlusIcon } from '../../../ui/icons'
import { EpisodeExportDialog } from '../../episodeExport/EpisodeExportDialog'
import { FilesIcon } from '../../episodeExport/exportIcons'
import { AddDialog, type AddKind } from './AddDialog'
import { ChapterBlock } from './ChapterBlock'
import { NUMBERING_LABELS, changeNumbering, toggleChapters } from './chapterFlows'
import { MemoSection } from './MemoSection'
import { PieceRow } from './PieceRow'
import { SettingStrip } from './SettingStrip'
import { chapterName, chapterStepAvailability, deletePermissions, pieceRows, rowsFor, stepAvailability } from './storyLogic'
import { useCollapsedChapters } from './useCollapsed'
import { useStoryData } from './useStoryData'
import './story.css'

interface AddRequest {
  kind?: AddKind
  chapterId?: ID
}

export function StoryTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const title = data.titles[titleId]
  // 本編の一覧・集計は、本編に関わるデータが変わった時だけ作り直す（あらすじ等の入力では作り直さない）
  const story = useStoryData(titleId)
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState<AddRequest | null>(null)
  const [exporting, setExporting] = useState(false)
  const { collapsed, toggle: toggleCollapsed, expand } = useCollapsedChapters(titleId)

  const flat = useMemo(() => flatten(story, titleId), [story, titleId])
  // 各話の進捗は本編が変わった時だけ数える（編集モードの切り替えでは数え直さない）
  const progress = useMemo(() => titleProgress(story, titleId), [story, titleId])
  const rows = useMemo(
    () =>
      pieceRows(story, titleId, {
        steps: edit ? stepAvailability(story, titleId) : null,
        deletable: edit ? deletePermissions(story, titleId) : null,
        progress,
      }),
    [story, titleId, edit, progress],
  )
  const targetIds = useMemo(() => new Set(episodeTargets(story, titleId).map((t) => t.chapterId)), [story, titleId])

  // 行・章に渡す関数は同じものを渡し続ける（変わると全行が描き直される）
  const collapsedRef = useRef(collapsed)
  useLayoutEffect(() => {
    collapsedRef.current = collapsed
  })

  /** 折りたたんだ章に話を動かしたら、見えなくならないようにその章を開いて知らせる */
  const onPieceMoved = useCallback(
    (pieceId: ID, via: 'step' | 'dialog') => {
      const d = getData()
      const slot = locatePiece(d, pieceId)
      if (!d.titles[titleId]?.chaptersEnabled || !slot?.chapterId || !collapsedRef.current.has(slot.chapterId)) return
      expand(slot.chapterId)
      // 「移動…」はダイアログ側で知らせるので、↑↓ の時だけ
      if (via !== 'step') return
      const p = d.pieces[pieceId]
      notify(`「${p ? pieceFullLabel(d, p) : '話'}」を「${chapterName(d.chapters[slot.chapterId])}」へ移動しました`)
    },
    [titleId, expand],
  )
  const addEpisodeTo = useCallback((chapterId: ID) => setAdding({ kind: 'episode', chapterId }), [])

  if (!title) return null
  const chaptersOn = title.chaptersEnabled
  const perChapter = effectiveNumbering(title) === 'perChapter'
  const isEmpty = chaptersOn ? title.structure.length === 0 : flat.length === 0

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
            {!isEmpty ? (
              <button
                type="button"
                className="btn"
                onClick={() => setExporting(true)}
                title="採用原稿を1話1ファイルのテキストで書き出す"
                data-testid="episode-export-open"
              >
                <FilesIcon />
                <span>
                  <span className="hide-mobile">各話テキスト</span>書き出し
                </span>
              </button>
            ) : null}
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
          <>
            {/* 進捗の％の意味（達成率ではなく位置）。スマホではマウスを乗せた時の説明が出ないので、一覧の上に書いておく */}
            <p className="small muted story-progress-legend" data-testid="progress-legend">
              右の％は、その話の終わりがタイトル全体（採用原稿）のどこにあるかを示します（転機の位置を見るための目安）。
            </p>
            <ol className={`story-list${chaptersOn ? ' is-tree' : ''}`} data-testid="story-list">
              {chaptersOn
                ? title.structure.map((node) => {
                    if (node.type === 'piece') {
                      const row = rows[node.id]
                      if (!row) return null
                      return <PieceRow key={node.id} {...row} edit={edit} onMoved={onPieceMoved} />
                    }
                    const chapter = data.chapters[node.id]
                    if (!chapter) return null
                    const chStep = edit ? chapterStepAvailability(story, chapter.id) : null
                    return (
                      <ChapterBlock
                        key={chapter.id}
                        chapter={chapter}
                        rows={rowsFor(rows, chapter.pieceIds)}
                        edit={edit}
                        canUp={chStep?.up ?? false}
                        canDown={chStep?.down ?? false}
                        collapsed={collapsed.has(chapter.id)}
                        onToggleCollapsed={toggleCollapsed}
                        canAddEpisode={targetIds.has(chapter.id)}
                        onAddEpisode={addEpisodeTo}
                        onPieceMoved={onPieceMoved}
                      />
                    )
                  })
                : flat.map((f) => {
                    const row = rows[f.pieceId]
                    return row ? <PieceRow key={f.pieceId} {...row} edit={edit} onMoved={onPieceMoved} /> : null
                  })}
            </ol>
          </>
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
      {exporting ? <EpisodeExportDialog titleId={titleId} onClose={() => setExporting(false)} /> : null}
    </div>
  )
}
