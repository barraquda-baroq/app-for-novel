// 章ページ: タイトル → 章 → 第n話 の真ん中の階層。章の名前・メモ・中の話の一覧。
import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { missingActiveLabel } from '../../domain/entityOps'
import { titleProgress } from '../../domain/progress'
import { episodeTargets } from '../../domain/storyOps'
import { chaptersOf, locatePiece, pieceFullLabel } from '../../domain/structure'
import { formatCount } from '../../domain/text'
import type { ID } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { DraftInput, DraftTextarea } from '../../ui/DraftField'
import { useDocumentTitle } from '../../ui/hooks'
import { BookIcon, ChevronLeftIcon, ChevronRightIcon, EditIcon, FolderIcon, PlusIcon, StarIcon, XIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { NearViewportContext, useNearViewportWatcher } from '../../ui/nearViewport'
import { NotFound } from '../../ui/NotFound'
import { AddDialog, type AddKind } from '../title/story/AddDialog'
import { CHAPTER_ADD_BLOCKED_REASON, releaseChapter } from '../title/story/ChapterBlock'
import { toggleChapters } from '../title/story/chapterFlows'
import { PieceRow } from '../title/story/PieceRow'
import { RowMenuProvider } from '../title/story/RowMenu'
import { chapterName, deletePermissions, pieceRows, rowsFor, statsOf, stepAvailability } from '../title/story/storyLogic'
import { useStoryData } from '../title/story/useStoryData'
import '../title/story/story.css'
import '../title/title.css'
import './chapter.css'

export function ChapterPage() {
  const { titleId = '', chapterId = '' } = useParams()
  const data = useData()
  const navigate = useNavigate()
  const title = data.titles[titleId]
  const chapter = data.chapters[chapterId]
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState<AddKind | null>(null)

  // 一覧・集計は本編に関わるデータが変わった時だけ作り直す（章のメモの入力などでは数え直さない）
  const story = useStoryData(titleId)
  // 進捗はタイトル全体（採用原稿）の中の位置。本編が変わった時だけ数える
  const progress = useMemo(() => titleProgress(story, titleId), [story, titleId])
  const allRows = useMemo(
    () =>
      pieceRows(story, titleId, {
        steps: edit ? stepAvailability(story, titleId) : null,
        deletable: edit ? deletePermissions(story, titleId) : null,
        progress,
      }),
    [story, titleId, edit, progress],
  )
  const pieceIds = chapter?.pieceIds
  const rows = useMemo(() => rowsFor(allRows, pieceIds ?? []), [allRows, pieceIds])
  const stats = useMemo(() => statsOf(rows), [rows])
  const canAddEpisode = useMemo(
    () => episodeTargets(story, titleId).some((t) => t.chapterId === chapterId),
    [story, titleId, chapterId],
  )
  const siblings = useMemo(() => chaptersOf(story, titleId), [story, titleId])
  // 抜粋のルビ・傍点は、画面の近くに来た行だけに作る（スクロールは画面全体）
  const { register: registerNear } = useNearViewportWatcher(() => null, [])

  /** ↑↓ で章の外へ出たら知らせる */
  const onMoved = useCallback(
    (pieceId: ID, via: 'step' | 'dialog') => {
      if (via !== 'step') return
      const d = getData()
      const slot = locatePiece(d, pieceId)
      if (slot && slot.chapterId !== chapterId) {
        const p = d.pieces[pieceId]
        const where = slot.chapterId ? `「${chapterName(d.chapters[slot.chapterId])}」` : '章の外（タイトル直下）'
        notify(`「${p ? pieceFullLabel(d, p) : '話'}」を${where}へ移動しました`)
      }
    },
    [chapterId],
  )
  useDocumentTitle(chapter ? `${chapterName(chapter)}（${title?.name.trim() || '無題のタイトル'}）` : undefined)

  if (!title || !chapter || chapter.titleId !== titleId) return <NotFound message="章が見つかりません。" />

  const titleName = title.name.trim() || '無題のタイトル'
  const name = chapterName(chapter)
  const crumbs = [{ label: titleName, to: paths.title(titleId) }, { label: name }]

  if (!title.chaptersEnabled) {
    return (
      <>
        <AppHeader crumbs={crumbs} />
        <main className="page page-narrow chpage">
          <div className="card card-pad stack chpage-off" data-testid="chapters-off-notice">
            <h1 className="chpage-off-title">
              <FolderIcon />
              {name}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              このタイトルは今、章で管理していません。章の構成は保存されているので、章管理をオンにするとこの章がそのまま表示されます。
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void toggleChapters(titleId, true)}
                data-testid="enable-chapters"
              >
                章で管理する
              </button>
              <Link to={paths.title(titleId)} className="btn">
                タイトルへ戻る
              </Link>
            </div>
          </div>
        </main>
      </>
    )
  }

  const index = siblings.findIndex((c) => c.id === chapter.id)
  const prev = index > 0 ? siblings[index - 1] : null
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null

  const release = async () => {
    if (await releaseChapter(data, chapter)) navigate(paths.title(titleId), { replace: true })
  }

  return (
    <>
      <AppHeader
        crumbs={crumbs}
        actions={
          <Link to={paths.read(titleId, chapter.id)} className="btn btn-sm tpage-header-btn" data-testid="chapter-read-link">
            <BookIcon />
            章を通し読み
          </Link>
        }
      />
      <main className="page chpage" data-testid="chapter-page">
        <header className="chpage-head">
          <span className="chpage-kicker">
            <FolderIcon />章
          </span>
          <DraftInput
            key={chapter.id}
            className="input-bare chpage-name"
            value={chapter.name}
            onCommit={(v) => attempt(() => actions.updateChapter(chapter.id, { name: v }))}
            placeholder="無題の章"
            aria-label="章の名前"
            data-testid="chapter-name-input"
          />
          <ul className="tpage-stats chpage-stats" aria-label="この章の集計">
            <li className="tpage-chip">
              {stats.episodes}話{stats.specials > 0 ? <span className="tpage-chip-sub">＋特殊 {stats.specials}</span> : null}
            </li>
            <li className="tpage-chip">
              採用原稿 {formatCount(stats.chars)}字
              {stats.chars > 0 ? <span className="tpage-chip-sub">（原稿用紙 約{formatCount(stats.pages)}枚）</span> : null}
            </li>
            {stats.missingActive > 0 ? (
              <li className="tpage-chip is-warn" data-testid="chapter-stat-missing">
                {missingActiveLabel(stats.missingEpisodes, stats.missingSpecials, stats.missingActs)}
              </li>
            ) : null}
          </ul>
          <label className="field chpage-note">
            <span>章のメモ</span>
            <DraftTextarea
              key={chapter.id}
              className="textarea"
              value={chapter.note}
              onCommit={(v) => attempt(() => actions.updateChapter(chapter.id, { note: v }))}
              rows={3}
              placeholder="この章の狙い・あらすじ・書くべきことなど"
              data-testid="chapter-note"
            />
          </label>
        </header>

        <section className="section" aria-labelledby="chpage-pieces-heading">
          <div className="story-toolbar">
            <h2 id="chpage-pieces-heading" className="story-toolbar-title">
              この章の話
            </h2>
            <div className="story-toolbar-actions">
              <button
                type="button"
                className={`btn btn-primary${canAddEpisode ? '' : ' story-is-disabled'}`}
                aria-disabled={!canAddEpisode}
                title={canAddEpisode ? undefined : CHAPTER_ADD_BLOCKED_REASON}
                onClick={() => (canAddEpisode ? setAdding('episode') : notifyError(CHAPTER_ADD_BLOCKED_REASON))}
                data-testid="chapter-page-add-episode"
              >
                <PlusIcon />
                話数追加
              </button>
              <button type="button" className="btn" onClick={() => setAdding('special')} data-testid="chapter-page-add-special">
                <StarIcon />
                <span>
                  特殊追加<span className="hide-mobile">（この章の中）</span>
                </span>
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
          </div>
          {!canAddEpisode ? <p className="small muted chpage-blocked">{CHAPTER_ADD_BLOCKED_REASON}</p> : null}

          {edit ? (
            <div className="story-edit-help" role="note">
              <p>
                ↑↓
                で1つずつ並べ替えられます。章の先頭から↑、末尾から↓で章の外へ出ます。並べ替えると話数は並び順どおりに振り直されます。
              </p>
              <p>
                削除できるのは{title.numbering === 'perChapter' ? 'この章の' : 'タイトル全体の'}
                <strong>最後の話だけ</strong>
                です（途中の話数を抜けさせないため）。特殊ブロックはいつでも削除できます。
              </p>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <div className="empty" data-testid="chapter-empty">
              この章にはまだ話がありません。{canAddEpisode ? '「＋話数追加」から話を追加しましょう。' : ''}
            </div>
          ) : (
            <>
              {/* 進捗の％は章の中ではなくタイトル全体での位置（スマホではマウスを乗せた時の説明が出ないので書いておく） */}
              <p className="small muted story-progress-legend" data-testid="progress-legend">
                右の％は、その話の終わりがタイトル全体（採用原稿）のどこにあるかです（章の中での割合ではありません）。
              </p>
              <RowMenuProvider onPieceMoved={onMoved}>
                <NearViewportContext.Provider value={registerNear}>
                  <ol className="story-list" data-testid="story-list">
                    {rows.map((row) => (
                      <PieceRow key={row.piece.id} {...row} edit={edit} onMoved={onMoved} />
                    ))}
                  </ol>
                </NearViewportContext.Provider>
              </RowMenuProvider>
            </>
          )}

          {edit ? (
            <div className="chpage-danger">
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void release()}
                data-testid="chapter-page-remove"
              >
                <XIcon />
                この章を解除
              </button>
              <span className="small muted">中の話は削除されず、章があった位置に章の外として並びます。</span>
            </div>
          ) : null}
        </section>

        <nav className="chpage-nav" aria-label="ほかの章">
          {prev ? (
            <Link to={paths.chapter(titleId, prev.id)} className="chpage-nav-link is-prev" data-testid="chapter-prev">
              <ChevronLeftIcon />
              <span>
                <span className="chpage-nav-hint">前の章</span>
                <span className="chpage-nav-name">{chapterName(prev)}</span>
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={paths.chapter(titleId, next.id)} className="chpage-nav-link is-next" data-testid="chapter-next">
              <span>
                <span className="chpage-nav-hint">次の章</span>
                <span className="chpage-nav-name">{chapterName(next)}</span>
              </span>
              <ChevronRightIcon />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </main>

      {adding ? <AddDialog titleId={titleId} presetKind={adding} chapterId={chapter.id} onClose={() => setAdding(null)} /> : null}
    </>
  )
}
