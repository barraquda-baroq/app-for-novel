// 幕に分けた話の画面（フォルダ）: 幕の一覧（第1幕…と採用稿・文字数）、合計の文字数、セパレート解除。
// 話の本文は各幕の採用稿をつないだもので、ここでは編集しない（幕の画面で編集する）。
// 話自身の稿（分けた時の採用稿など）は、セパレートを解除するまで変えられないので、読み取り専用で見られるようにする。
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { missingActiveLabel } from '../../domain/entityOps'
import { titleProgress } from '../../domain/progress'
import { adoptedText, episodeNumbers, locatePiece, pieceFullLabel, pieceLabel } from '../../domain/structure'
import { bodyMetrics, formatCount } from '../../domain/text'
import type { Piece, Title, Version } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt } from '../../store/uiStore'
import { formatDateTime } from '../../ui/browser'
import { promptDialog } from '../../ui/dialogs'
import { useDocumentTitle } from '../../ui/hooks'
import { BookIcon, ChevronLeftIcon, ChevronRightIcon, EditIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { neighborPieces, versionDisplayName, versionsNewestFirst } from '../piece/logic'
import { ActRow } from '../title/story/ActRow'
import { RowMenuProvider } from '../title/story/RowMenu'
import { actRows } from '../title/story/storyLogic'
import { useStoryData } from '../title/story/useStoryData'
import '../title/story/story.css'
import '../title/title.css'
import '../chapter/chapter.css'
import { confirmUnseparate } from './actFlows'
import { ActsIcon, UnsplitIcon } from './actIcons'
import './acts.css'

export function EpisodeFolder({ title, piece }: { title: Title; piece: Piece }) {
  const navigate = useNavigate()
  const data = useData()
  // 一覧・集計は本編に関わるデータが変わった時だけ作り直す
  const story = useStoryData(title.id)
  const numbers = useMemo(() => episodeNumbers(story, title.id), [story, title.id])
  const progress = useMemo(() => titleProgress(story, title.id), [story, title.id])
  const acts = useMemo(() => actRows(story, piece, progress.get(piece.id), numbers), [story, piece, progress, numbers])
  const label = pieceLabel(story, piece, numbers)
  const fullLabel = pieceFullLabel(story, piece, numbers)
  const text = adoptedText(story, piece)
  const metrics = text ? bodyMetrics(text) : null
  const missing = acts.reduce((n, a) => n + (a.version ? 0 : 1), 0)
  const slot = useMemo(() => locatePiece(story, piece.id), [story, piece.id])
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const neighbors = useMemo(() => neighborPieces(story, title.id, piece.id), [story, title.id, piece.id])
  const own = useMemo(() => versionsNewestFirst(story, piece), [story, piece])
  useDocumentTitle(`${fullLabel}（${acts.length}幕） — ${title.name}`)

  const crumbs: Crumb[] = [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }]
  if (chapter) crumbs.push({ label: chapter.name || '（無題の章）', to: paths.chapter(title.id, chapter.id) })
  crumbs.push({ label })

  const rename = async () => {
    const next = await promptDialog({
      title: '話の題を変更',
      label: '話の題（すべての幕の見出し「第n話　題　第x幕」に入ります）',
      initial: piece.subtitle,
      confirmLabel: '変更',
      allowEmpty: true,
      selectOnOpen: true,
    })
    if (next === null) return
    attempt(() => actions.updatePiece(piece.id, { subtitle: next.trim() }))
  }

  const neighborLink = (id: string | null, dir: 'prev' | 'next') => {
    const p = id ? story.pieces[id] : undefined
    if (!p) return <span />
    return (
      <Link
        to={paths.piece(title.id, p.id)}
        className={`chpage-nav-link ${dir === 'prev' ? 'is-prev' : 'is-next'}`}
        data-testid={dir === 'prev' ? 'prev-piece' : 'next-piece'}
      >
        {dir === 'prev' ? <ChevronLeftIcon /> : null}
        <span>
          <span className="chpage-nav-hint">{dir === 'prev' ? '前の話' : '次の話'}</span>
          <span className="chpage-nav-name">{pieceFullLabel(story, p, numbers)}</span>
        </span>
        {dir === 'next' ? <ChevronRightIcon /> : null}
      </Link>
    )
  }

  return (
    <>
      <AppHeader
        crumbs={crumbs}
        actions={
          <Link
            to={paths.read(title.id)}
            className="icon-btn"
            aria-label="通し読み（採用原稿のみ）"
            title="通し読み（採用原稿のみ）"
          >
            <BookIcon />
          </Link>
        }
      />
      <main className="page page-narrow" data-testid="episode-folder">
        <header className="ef-head">
          <span className="ef-kicker">
            <ActsIcon />
            幕に分けた話
          </span>
          <h1 className="ef-title">
            <span className="ef-label" data-testid="folder-label">
              {label}
            </span>
            {piece.subtitle.trim() ? (
              <span className="ef-subtitle" data-testid="folder-subtitle">
                {piece.subtitle.trim()}
              </span>
            ) : (
              <span className="ef-subtitle is-empty">（題なし）</span>
            )}
          </h1>
          <ul className="tpage-stats" aria-label="この話の集計">
            <li className="tpage-chip" data-testid="folder-act-count">
              {acts.length}幕
            </li>
            <li className="tpage-chip" data-testid="folder-total">
              合計 {formatCount(metrics?.chars ?? 0)}字
              {metrics && metrics.chars > 0 ? (
                <span className="tpage-chip-sub">（原稿用紙 約{formatCount(metrics.manuscriptPages)}枚）</span>
              ) : null}
            </li>
            {missing > 0 ? (
              <li className="tpage-chip is-warn" data-testid="folder-missing">
                {missingActiveLabel(0, 0, missing)}
              </li>
            ) : null}
          </ul>
          <p className="ef-note">
            この話の本文は、各幕の採用稿を順につないだものです（文字数・通し読み・書き出しもつないだ本文）。編集は各幕の画面で行います。
          </p>
          <div className="ef-actions">
            <button type="button" className="btn btn-sm" onClick={() => void rename()} data-testid="folder-rename">
              <EditIcon />
              題を変更
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void confirmUnseparate(piece.id, { open: (id) => navigate(paths.piece(title.id, id)) })}
              title={missing > 0 ? '採用稿のない幕があると解除できません' : '各幕の採用稿をつないで、1つの話に戻す'}
              data-testid="unseparate-button"
            >
              <UnsplitIcon />
              セパレート解除
            </button>
          </div>
        </header>

        <section className="ef-section" aria-labelledby="ef-acts-heading">
          <h2 id="ef-acts-heading" className="ef-section-title">
            幕（{acts.length}）
          </h2>
          <RowMenuProvider>
            <ol className="story-acts ef-acts" data-testid="act-list">
              {acts.map((a) => (
                <ActRow key={a.act.id} {...a} />
              ))}
            </ol>
          </RowMenuProvider>
        </section>

        <section className="ef-section">
          <details className="ef-frozen" data-testid="folder-frozen">
            <summary>幕に分ける前の稿（{own.length}稿・読み取り専用）</summary>
            <div className="ef-frozen-body">
              <p className="ef-note">
                幕に分けている間、この話自身の稿は変えられません（採用も変えられません）。セパレートを解除すると、各幕をつないだ新しい稿が採用され、ここにある稿もまた使えるようになります。
              </p>
              {own.map((v) => (
                <FrozenVersion key={v.id} version={v} adopted={v.id === piece.activeVersionId} />
              ))}
            </div>
          </details>
        </section>

        <nav className="ef-nav chpage-nav" aria-label="前後の話">
          {neighborLink(neighbors.prev, 'prev')}
          {neighborLink(neighbors.next, 'next')}
        </nav>
      </main>
    </>
  )
}

/** 話自身の稿1つ（開いた時だけ本文を出す） */
function FrozenVersion({ version, adopted }: { version: Version; adopted: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="ef-version" onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="frozen-version">
      <summary>
        <span>{versionDisplayName(version)}</span>
        {adopted ? <span className="badge badge-accent">分けた時の採用稿</span> : null}
        <span className="ef-version-meta">
          {formatCount(bodyMetrics(version).chars)}字・{formatDateTime(version.updatedAt)}
        </span>
      </summary>
      {open ? (
        <textarea
          className="manuscript"
          value={version.body}
          readOnly
          aria-label={`${versionDisplayName(version)}の本文（読み取り専用）`}
        />
      ) : null}
    </details>
  )
}
