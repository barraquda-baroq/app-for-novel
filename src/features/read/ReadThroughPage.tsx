// 通し読み: タイトル（または章）を、採用（アクティブ）原稿だけで最初から最後まで読む画面。
// 採用原稿がない話には「採用原稿がありません。」と表示する。
// 本文のルビ・傍点の記法は読むための表示にする（コピー・テキストの書き出しは記法のまま）。
// 長編（数百話・数百万字）でも軽く開けるよう、画面の外の話は組版せず、見積もった大きさで場所だけ取る（lineEstimate.ts）。
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import { flushSync } from 'react-dom'
import { Link, useHref, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { buildReadThrough, NO_ACTIVE_MESSAGE, readThroughText, type ReadBlock } from '../../domain/readthrough'
import { chaptersOf } from '../../domain/structure'
import { formatCount } from '../../domain/text'
import type { ID } from '../../domain/types'
import { paths } from '../../routes'
import { getData, useData } from '../../store/appStore'
import { usePrefs } from '../../store/uiStore'
import { copyText, downloadFile, safeFileName } from '../../ui/browser'
import { useDocumentTitle } from '../../ui/hooks'
import { BookIcon, ChevronRightIcon, CopyIcon, DownloadIcon, EditIcon, ListIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { NearViewportContext, useNearViewportWatcher } from '../../ui/nearViewport'
import { LazyRubyText } from '../../ui/RubyText'
import { EpisodeExportDialog } from '../episodeExport/EpisodeExportDialog'
import { FilesIcon } from '../episodeExport/exportIcons'
import { lineShape, lineShapeStyle, useCharsPerLine, type LineShape } from './lineEstimate'
import { VerticalTextIcon } from './readIcons'
import {
  clampFontSize,
  FONT_MAX,
  FONT_MIN,
  pieceAnchorId,
  pieceVersion,
  readStats,
  resolveChapterScope,
  splitTcy,
  tocGroups,
  type PieceBlock,
  type TocGroup,
} from './readLogic'
import { readingAnchor, settleScrollTo, type ReadingAnchor } from './scrollAnchor'
import './read.css'

function Tcy({ text }: { text: string }) {
  return (
    <>
      {splitTcy(text).map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <span key={i} className="rt-tcy">
            {part.tcy}
          </span>
        ),
      )}
    </>
  )
}

function fullLabel(b: PieceBlock): string {
  return b.subtitle.trim() ? `${b.label}　${b.subtitle.trim()}` : b.label
}

/** 本文の字間（read.css の .rt-text の letter-spacing と合わせる） */
const TEXT_LETTER_SPACING = 0.02

/** 1話分。本文が変わらない限り描き直さない（文字の大きさ・縦書きの切り替えは CSS だけで反映する） */
const PieceSection = memo(function PieceSection({
  block: b,
  titleId,
  shape,
}: {
  block: PieceBlock
  titleId: ID
  /** 画面の外にある間の大きさの見積もり用（採用原稿がなければ null） */
  shape: LineShape | null
}) {
  const state = b.body === null ? 'missing' : b.body.trim() === '' ? 'blank' : 'text'
  // ルビ・傍点の要素は、この話が画面の近くに来てから作る（ルビの多い長編でも軽く開けるように）
  const sectionRef = useRef<HTMLElement>(null)
  return (
    <section
      ref={sectionRef}
      id={pieceAnchorId(b.pieceId)}
      className={`rt-piece${b.kind === 'special' ? ' is-special' : ''}`}
      style={shape && state === 'text' ? lineShapeStyle(shape) : undefined}
      data-testid="read-piece"
      data-kind={b.kind}
      data-state={state}
      aria-label={fullLabel(b)}
    >
      <div className="rt-piece-head">
        <h3 className="rt-piece-title" tabIndex={-1} data-heading>
          <span className="rt-piece-label" data-testid="read-piece-label">
            <Tcy text={b.label} />
          </span>
          {b.subtitle.trim() ? (
            <span className="rt-piece-subtitle">
              <Tcy text={b.subtitle.trim()} />
            </span>
          ) : null}
        </h3>
        <Link
          to={paths.piece(titleId, b.pieceId)}
          className="rt-edit"
          aria-label={`${fullLabel(b)}を編集`}
          title={b.versionName ? `採用中：${b.versionName}` : '原稿を開く'}
          data-testid="read-edit"
        >
          <EditIcon />
          編集
        </Link>
      </div>
      {b.body === null ? (
        <p className="rt-missing" data-testid="no-active">
          {NO_ACTIVE_MESSAGE}
        </p>
      ) : state === 'blank' ? (
        <p className="rt-blank">（本文はまだありません）</p>
      ) : (
        <div className="rt-text" data-testid="read-text">
          <LazyRubyText text={b.body} watch={sectionRef} />
        </div>
      )}
    </section>
  )
})

/** 本文（タイトル・章見出し・各話）。データが変わらない限り描き直さない */
const DocContent = memo(function DocContent({
  blocks,
  shapes,
  titleId,
  titleName,
  chapterName,
}: {
  blocks: ReadBlock[]
  shapes: Map<ID, LineShape>
  titleId: ID
  titleName: string
  chapterName: string | null
}) {
  return (
    <>
      <header className="rt-doc-head">
        <h1 className="rt-doc-title">{titleName}</h1>
        {chapterName !== null ? <p className="rt-doc-sub">{chapterName}</p> : null}
      </header>
      {blocks.map((b) =>
        b.type === 'chapter' ? (
          <h2 key={`ch-${b.chapterId}`} className="rt-chapter" data-testid="read-chapter">
            <Tcy text={b.name.trim() || '無題の章'} />
          </h2>
        ) : b.type === 'chapterEnd' ? (
          // 章が終わり、どの章にも入っていない話が続く
          <hr key={`end-${b.chapterId}`} className="rt-chapter-end" aria-label="章の終わり" data-testid="read-chapter-end" />
        ) : (
          <PieceSection key={b.pieceId} block={b} titleId={titleId} shape={shapes.get(b.pieceId) ?? null} />
        ),
      )}
    </>
  )
})

type JumpHandler = (e: MouseEvent<HTMLAnchorElement>, pieceId: ID) => void

/** 目次（スマホでは開閉できる） */
function ReadToc({
  groups,
  pieceCount,
  open,
  onToggle,
  onJump,
  href,
}: {
  groups: TocGroup[]
  pieceCount: number
  open: boolean
  onToggle: () => void
  onJump: JumpHandler
  href: string
}) {
  return (
    <nav className={`rt-toc${open ? ' is-open' : ''}`} aria-label="目次" data-testid="read-toc">
      <button type="button" className="rt-toc-toggle" aria-expanded={open} onClick={onToggle} data-testid="toc-toggle">
        <ListIcon />
        <span className="grow">目次</span>
        <span className="rt-toc-count">{pieceCount}</span>
        <ChevronRightIcon className="icon rt-toc-chevron" />
      </button>
      <h2 className="rt-toc-title">
        目次<span className="rt-toc-count">{pieceCount}</span>
      </h2>
      <TocBody groups={groups} onJump={onJump} href={href} />
    </nav>
  )
}

/** 目次の中身。開閉や表示の切り替えでは描き直さない（数百話あっても目次を開く・閉じるのを軽くする） */
const TocBody = memo(function TocBody({ groups, onJump, href }: { groups: TocGroup[]; onJump: JumpHandler; href: string }) {
  return (
    <div className="rt-toc-body">
      {groups.map((g, gi) => (
        <div key={g.chapterId ?? `root-${gi}`} className="rt-toc-group">
          {g.name ? <p className="rt-toc-chapter">{g.name}</p> : null}
          <ol className="rt-toc-list">
            {g.items.map((b) => (
              <li key={b.pieceId}>
                <a
                  href={href}
                  className={`rt-toc-link${b.kind === 'special' ? ' is-special' : ''}`}
                  onClick={(e) => onJump(e, b.pieceId)}
                  data-testid="toc-link"
                >
                  <span className="rt-toc-label">{b.label}</span>
                  {b.subtitle.trim() ? <span className="rt-toc-subtitle">{b.subtitle.trim()}</span> : null}
                  {b.body === null ? (
                    <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE} data-testid="toc-missing">
                      採用原稿なし
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
})

export function ReadThroughPage() {
  const { titleId = '' } = useParams()
  const data = useData()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const selfHref = useHref(location)
  const title = data.titles[titleId]
  const chapterId = useMemo(() => resolveChapterScope(data, titleId, params.get('chapter')), [data, titleId, params])
  const chapters = useMemo(() => chaptersOf(data, titleId), [data, titleId])
  const blocks = useMemo(() => buildReadThrough(data, titleId, chapterId), [data, titleId, chapterId])
  const groups = useMemo(() => tocGroups(blocks), [blocks])
  const stats = useMemo(() => readStats(data, blocks), [data, blocks])
  // 画面の外にある話の大きさの見積もりに使う、段落の形（稿ごとに1回だけ数える）
  const shapes = useMemo(() => {
    const out = new Map<ID, LineShape>()
    for (const b of blocks) {
      if (b.type !== 'piece' || b.body === null) continue
      const v = pieceVersion(data, b.pieceId)
      if (v) out.set(b.pieceId, lineShape(v))
    }
    return out
  }, [data, blocks])
  const vertical = usePrefs((s) => s.verticalReading)
  const fontSize = clampFontSize(usePrefs((s) => s.editorFontSize))
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [tocOpen, setTocOpen] = useState(false)
  const [exportingEpisodes, setExportingEpisodes] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLElement>(null)
  /** 縦書き・文字の大きさを切り替える前に読んでいた所（切り替えた後に同じ所を出す） */
  const anchorRef = useRef<ReadingAnchor | null>(null)
  const cancelSettle = useRef<(() => void) | null>(null)

  const titleName = title ? title.name.trim() || '無題のタイトル' : ''
  const chapter = chapterId ? data.chapters[chapterId] : undefined
  const chapterName = chapter ? chapter.name.trim() || '無題の章' : ''
  useDocumentTitle(title ? `通し読み: ${chapter ? `${chapterName}（${titleName}）` : titleName}` : undefined)

  // 見出しへ移動した時にヘッダー・ツールバーの下に隠れないよう、ツールバーの高さを CSS 変数に入れる
  useLayoutEffect(() => {
    const bar = toolbarRef.current
    const root = rootRef.current
    if (!bar || !root) return
    const apply = () => root.style.setProperty('--rt-toolbar-h', `${bar.offsetHeight}px`)
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [title])

  // 開いた時・範囲を変えた時は先頭から読めるようにする（前の画面のスクロール位置を引き継がない）
  useEffect(() => {
    window.scrollTo?.(0, 0)
    if (docRef.current) docRef.current.scrollLeft = 0
  }, [titleId, chapterId])

  // 1行（縦書きでは1列）に入る字数。画面の外の話の大きさの見積もりに使う
  useCharsPerLine(docRef, TEXT_LETTER_SPACING, [vertical, fontSize, stats.pieces === 0])

  // 画面の近くに来た話だけルビ・傍点を表示する見張り役。縦書きでは本文の枠の中を横にスクロールするので、枠を基準にする
  const registerNear = useNearViewportWatcher(() => (vertical ? docRef.current : null), [vertical, stats.pieces === 0])

  // 縦書き・文字の大きさを切り替えたら、切り替える前に読んでいた所を出す
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    if (!anchor) return
    const target = document.getElementById(anchor.id)
    if (!target) return
    cancelSettle.current?.()
    cancelSettle.current = settleScrollTo(target, docRef.current, vertical, anchor.fraction)
  }, [vertical, fontSize])

  useEffect(() => () => cancelSettle.current?.(), [])

  // 縦書きでは、マウスホイールの縦回転で横（読み進める方向）にスクロールする
  useEffect(() => {
    const el = docRef.current
    if (!el || !vertical) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      // vertical-rl では scrollLeft は 0（先頭・右端）から負の方向に進む
      const before = el.scrollLeft
      el.scrollLeft = before - e.deltaY
      if (el.scrollLeft !== before) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [vertical, blocks.length])

  // 目次は描き直さずに済むよう、操作は同じ関数のまま最新の表示方向を参照する
  const verticalRef = useRef(vertical)
  useLayoutEffect(() => {
    verticalRef.current = vertical
  }, [vertical])
  const toggleToc = useCallback(() => setTocOpen((v) => !v), [])
  const jumpTo = useCallback((e: MouseEvent<HTMLAnchorElement>, pieceId: ID) => {
    e.preventDefault()
    // スマホでは目次を先に閉じる（閉じて本文の位置が動いてから移動する）
    flushSync(() => setTocOpen(false))
    const target = document.getElementById(pieceAnchorId(pieceId))
    if (!target) return
    // 途中の話はまだ組んでいない（見積もりの大きさ）ので、すぐに移動し、組み上がってずれたら合わせ直す
    cancelSettle.current?.()
    cancelSettle.current = settleScrollTo(target, docRef.current, verticalRef.current, 0)
    target.querySelector<HTMLElement>('[data-heading]')?.focus({ preventScroll: true })
  }, [])

  if (!title) return <NotFound message="タイトルが見つかりません。" />

  const crumbs: Crumb[] = [{ label: titleName, to: paths.title(titleId) }]
  if (chapter) crumbs.push({ label: chapterName, to: paths.chapter(titleId, chapter.id) })
  crumbs.push({ label: '通し読み' })

  const setScope = (next: string) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next) p.set('chapter', next)
        else p.delete('chapter')
        return p
      },
      { replace: true },
    )
  }

  const text = () => readThroughText(getData(), titleId, chapterId)
  const fileName = chapter ? `${safeFileName(`${titleName}_${chapterName}`)}.txt` : `${safeFileName(title.name)}.txt`

  /** 表示の切り替え。今読んでいる所を覚えておき、切り替えた後に同じ所を出す */
  const changeView = (patch: { verticalReading?: boolean; editorFontSize?: number }) => {
    const doc = docRef.current
    anchorRef.current = doc ? readingAnchor(doc, vertical) : null
    setPrefs(patch)
  }

  const pieceCount = stats.pieces
  const isEmpty = pieceCount === 0
  const style = { '--rt-size': `${fontSize}px` } as CSSProperties

  return (
    <div ref={rootRef} className={`rt-root${vertical ? ' is-vertical' : ''}`} style={style} data-testid="read-page">
      <AppHeader crumbs={crumbs} />

      <div className="rt-toolbar" ref={toolbarRef} data-testid="read-toolbar">
        <div className="rt-toolbar-inner">
          <div className="rt-tools">
            {title.chaptersEnabled && chapters.length > 0 ? (
              <label className="rt-scope">
                <span className="rt-tool-label">範囲</span>
                <select
                  className="select rt-scope-select"
                  value={chapterId ?? ''}
                  onChange={(e) => setScope(e.target.value)}
                  data-testid="read-scope"
                >
                  <option value="">全体</option>
                  {chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name.trim() || '無題の章'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className={`btn btn-sm rt-toggle${vertical ? ' is-on' : ''}`}
              aria-pressed={vertical}
              onClick={() => changeView({ verticalReading: !vertical })}
              data-testid="vertical-toggle"
            >
              <VerticalTextIcon />
              縦書き
            </button>
            <div className="rt-size" role="group" aria-label="文字の大きさ">
              <button
                type="button"
                className="rt-size-btn"
                onClick={() => changeView({ editorFontSize: clampFontSize(fontSize - 1) })}
                disabled={fontSize <= FONT_MIN}
                aria-label="文字を小さく"
                title="文字を小さく"
                data-testid="font-smaller"
              >
                <span aria-hidden="true">A</span>
                <span className="rt-size-sign" aria-hidden="true">
                  −
                </span>
              </button>
              <span className="rt-size-value" aria-live="polite" data-testid="font-size">
                {fontSize}
                <span className="visually-hidden">ピクセル</span>
              </span>
              <button
                type="button"
                className="rt-size-btn"
                onClick={() => changeView({ editorFontSize: clampFontSize(fontSize + 1) })}
                disabled={fontSize >= FONT_MAX}
                aria-label="文字を大きく"
                title="文字を大きく"
                data-testid="font-larger"
              >
                <span aria-hidden="true" className="rt-size-big">
                  A
                </span>
                <span className="rt-size-sign" aria-hidden="true">
                  ＋
                </span>
              </button>
            </div>
          </div>

          <div className="rt-summary">
            <span className="rt-total" data-testid="read-total">
              採用原稿 <strong>{formatCount(stats.chars)}</strong>字
            </span>
            {stats.missing > 0 ? (
              <span className="badge badge-missing" data-testid="read-missing">
                採用原稿なし {stats.missing}話
              </span>
            ) : null}
          </div>

          <div className="rt-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copyText(text(), '全文をコピーしました')}
              disabled={isEmpty}
              aria-label="全文コピー"
              title="採用原稿の全文をクリップボードにコピー"
              data-testid="copy-all"
            >
              <CopyIcon />
              <span className="hide-mobile">全文コピー</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => downloadFile(fileName, text())}
              disabled={isEmpty}
              aria-label="テキストで書き出し"
              title="採用原稿をテキストファイル（.txt）で保存"
              data-testid="export-text"
            >
              <DownloadIcon />
              <span className="hide-mobile">テキストで書き出し</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setExportingEpisodes(true)}
              disabled={isEmpty}
              aria-label="各話テキスト書き出し"
              title="タイトル全体の採用原稿を、1話1ファイルのテキストで書き出す"
              data-testid="episode-export-open"
            >
              <FilesIcon />
              <span className="hide-mobile">各話ごとに書き出し</span>
            </button>
          </div>
        </div>
      </div>

      <main className="rt-main">
        {isEmpty ? (
          <div className="empty rt-empty" data-testid="read-empty">
            <BookIcon />
            <p>{chapter ? 'この章にはまだ話がありません。' : 'まだ話がありません。'}</p>
            <Link className="btn btn-sm" to={chapter ? paths.chapter(titleId, chapter.id) : paths.title(titleId)}>
              {chapter ? '章へ戻る' : 'タイトルへ戻る'}
            </Link>
          </div>
        ) : (
          <div className="rt-layout">
            <ReadToc
              groups={groups}
              pieceCount={pieceCount}
              open={tocOpen}
              onToggle={toggleToc}
              onJump={jumpTo}
              href={selfHref}
            />

            <article
              ref={docRef}
              className="rt-doc"
              aria-label={chapter ? `${chapterName}の本文` : `${titleName}の本文`}
              tabIndex={vertical ? 0 : undefined}
              data-testid="read-body"
            >
              <NearViewportContext.Provider value={registerNear}>
                <DocContent
                  blocks={blocks}
                  shapes={shapes}
                  titleId={titleId}
                  titleName={titleName}
                  chapterName={chapter ? chapterName : null}
                />
              </NearViewportContext.Provider>
            </article>
          </div>
        )}
      </main>
      {exportingEpisodes ? <EpisodeExportDialog titleId={titleId} onClose={() => setExportingEpisodes(false)} /> : null}
    </div>
  )
}
