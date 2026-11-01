// 通し読み: タイトル（または章）を、採用（アクティブ）原稿だけで最初から最後まで読む画面。
// 採用原稿がない話には「採用原稿がありません。」と表示する。
// 幕に分けた話は、話の見出しの下に幕の見出し（第1幕…）と各幕の採用稿を並べる（目次にも幕を出す）。
// 本文のルビ・傍点の記法は読むための表示にする（コピー・テキストの書き出しは記法のまま）。
// 長編（数百話・数百万字）でも軽く開けるよう、画面の外の話は組版せず、見積もった大きさで場所だけ取る（lineEstimate.ts）。
// 縦書きでは、タイトルの字数×行数（Title.pageSetup）のページに組んで本のように並べる（PagedBody.tsx・verticalPages.ts）。
// 話の画面の「この話を通し読み」からは、その話だけ（?piece=）。
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
import { pageSetupOf, samePageSetup } from '../../domain/pageSetup'
import { buildReadThrough, NO_ACTIVE_MESSAGE, readBlocksText, readThroughText, type ReadBlock } from '../../domain/readthrough'
import { strippedBody } from '../../domain/ruby'
import { chaptersOf, flatten } from '../../domain/structure'
import { formatCount } from '../../domain/text'
import type { ID, PageSetup } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt, usePrefs } from '../../store/uiStore'
import { saveTextFile } from '../../platform/saveFile'
import { copyText, safeFileName } from '../../ui/browser'
import { useDocumentTitle } from '../../ui/hooks'
import { BookIcon, ChevronRightIcon, CopyIcon, DownloadIcon, EditIcon, ListIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { NearViewportContext, useNearViewportWatcher } from '../../ui/nearViewport'
import { LazyRubyText } from '../../ui/RubyText'
import { EpisodeExportDialog } from '../episodeExport/EpisodeExportDialog'
import { FilesIcon } from '../episodeExport/exportIcons'
import { applyCharsPerLine, lineShape, lineShapeStyle, useCharsPerLine, type LineShape } from './lineEstimate'
import { PagedContent, usePageFit } from './PagedBody'
import { PageSetupControl } from './PageSetupControl'
import { VerticalTextIcon } from './readIcons'
import {
  actAnchorId,
  actVersion,
  clampFontSize,
  episodeBlocks,
  FONT_MAX,
  FONT_MIN,
  pageAnchorId,
  pagedFontSize,
  pieceAnchorId,
  pieceVersion,
  readMissingLabel,
  readStats,
  resolveChapterScope,
  resolvePieceScope,
  tocGroups,
  type PieceBlock,
  type TocGroup,
} from './readLogic'
import { readingAnchor, settleScrollTo, type ReadingAnchor } from './scrollAnchor'
import { Tcy } from './Tcy'
import { createPageCache, layoutVerticalPages } from './verticalPages'
import './read.css'

function fullLabel(b: PieceBlock): string {
  return b.subtitle.trim() ? `${b.label}　${b.subtitle.trim()}` : b.label
}

/** 1話分の、画面の外にある間に使うもの（稿ごとに覚えておいた値なので、開き直しても作り直さない） */
interface PieceLayout {
  shape: LineShape
  /** 記号とルビの読みを除いた本文（幕に分けた話は幕ごと: actPlain） */
  plain?: string
  actPlain?: Map<ID, string>
}

/** 範囲の選択欄で「1話だけ」を表す値（章の id と重ならない） */
const SCOPE_PIECE = ':piece'

/** 幕の見出しの分の見積もり（空行の数で数える） */
const ACT_HEAD_LINES = 3

/**
 * 目次が本文の上に縦に並ぶ画面（read.css: 1100px 未満の幅で、高さが 500px を超える時。広い画面は横の列、低い画面
 * （スマホの横置き）は本文の横に出す）。read.css の @media (min-width: 1100px)・(max-height: 500px) と合わせる
 */
const TOC_ABOVE_BODY = '(max-width: 1099.98px) and (min-height: 500.02px)'

/** 本文の字間（read.css の .rt-text の letter-spacing と合わせる） */
const TEXT_LETTER_SPACING = 0.02

/** 1話分。本文が変わらない限り描き直さない（文字の大きさ・縦書きの切り替えは CSS だけで反映する） */
const PieceSection = memo(function PieceSection({
  block: b,
  titleId,
  shape,
  plain,
  actPlain,
}: {
  block: PieceBlock
  titleId: ID
  /** 画面の外にある間の大きさの見積もり用（採用原稿がなければ null） */
  shape: LineShape | null
  /** 記号とルビの読みを除いた本文（画面から遠い間に置く。稿ごとに覚えておいたもの） */
  plain?: string
  /** 幕に分けた話: 幕ごとの plain */
  actPlain?: Map<ID, string>
}) {
  const state = b.acts ? 'text' : b.body === null ? 'missing' : b.body.trim() === '' ? 'blank' : 'text'
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
      data-split={b.acts ? 'true' : undefined}
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
      {b.acts ? (
        b.acts.map((a) => (
          <div key={a.pieceId} id={actAnchorId(a.pieceId)} className="rt-act" data-testid="read-act">
            <div className="rt-act-head">
              <h4 className="rt-act-title" tabIndex={-1} data-heading data-testid="read-act-label">
                <Tcy text={a.label} />
              </h4>
              <Link
                to={paths.piece(titleId, a.pieceId)}
                className="rt-edit"
                aria-label={`${fullLabel(b)}　${a.label}を編集`}
                title={a.versionName ? `採用中：${a.versionName}` : '幕を開く'}
                data-testid="read-act-edit"
              >
                <EditIcon />
                編集
              </Link>
            </div>
            {a.body === null ? (
              <p className="rt-missing" data-testid="no-active">
                {NO_ACTIVE_MESSAGE}
              </p>
            ) : a.body.trim() === '' ? (
              <p className="rt-blank">（本文はまだありません）</p>
            ) : (
              <div className="rt-text" data-testid="read-text">
                <LazyRubyText text={a.body} plain={actPlain?.get(a.pieceId)} watch={sectionRef} />
              </div>
            )}
          </div>
        ))
      ) : b.body === null ? (
        <p className="rt-missing" data-testid="no-active">
          {NO_ACTIVE_MESSAGE}
        </p>
      ) : state === 'blank' ? (
        <p className="rt-blank">（本文はまだありません）</p>
      ) : (
        <div className="rt-text" data-testid="read-text">
          <LazyRubyText text={b.body} plain={plain} watch={sectionRef} />
        </div>
      )}
    </section>
  )
})

/** 本文（タイトル・章見出し・各話）。データが変わらない限り描き直さない */
const DocContent = memo(function DocContent({
  blocks,
  layouts,
  titleId,
  titleName,
  chapterName,
}: {
  blocks: ReadBlock[]
  layouts: Map<ID, PieceLayout>
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
          <PieceSection
            key={b.pieceId}
            block={b}
            titleId={titleId}
            shape={layouts.get(b.pieceId)?.shape ?? null}
            plain={layouts.get(b.pieceId)?.plain}
            actPlain={layouts.get(b.pieceId)?.actPlain}
          />
        ),
      )}
    </>
  )
})

/**
 * 目次から移動する（anchorId は話・幕の見出しの要素の id）。page は縦書きのページ表示で幕の見出しのあるページ
 * （幕の見出しは、そのページが画面の近くに来るまで作らないので、ページへ移動する）
 */
type JumpHandler = (e: MouseEvent<HTMLAnchorElement>, anchorId: string, page?: number) => void

/** 目次（スマホでは開閉できる） */
function ReadToc({
  groups,
  pieceCount,
  open,
  onToggle,
  onJump,
  href,
  pages,
}: {
  groups: TocGroup[]
  pieceCount: number
  open: boolean
  onToggle: () => void
  onJump: JumpHandler
  href: string
  /** 縦書きのページ表示: 話・幕の最初のページの番号（横書きでは null） */
  pages: ReadonlyMap<ID, number> | null
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
      <TocBody groups={groups} onJump={onJump} href={href} pages={pages} />
    </nav>
  )
}

/** 目次の中身。開閉や表示の切り替えでは描き直さない（数百話あっても目次を開く・閉じるのを軽くする） */
const TocBody = memo(function TocBody({
  groups,
  onJump,
  href,
  pages,
}: {
  groups: TocGroup[]
  onJump: JumpHandler
  href: string
  pages: ReadonlyMap<ID, number> | null
}) {
  const pageOf = (id: ID) => {
    const n = pages?.get(id)
    return n === undefined ? null : (
      <span className="rt-toc-page" aria-label={`${n}ページ`} data-testid="toc-page">
        p.{n}
      </span>
    )
  }
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
                  onClick={(e) => onJump(e, pieceAnchorId(b.pieceId))}
                  data-testid="toc-link"
                >
                  <span className="rt-toc-label">{b.label}</span>
                  {b.subtitle.trim() ? <span className="rt-toc-subtitle">{b.subtitle.trim()}</span> : null}
                  {b.body === null && !b.acts ? (
                    <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE} data-testid="toc-missing">
                      採用原稿なし
                    </span>
                  ) : null}
                  {pageOf(b.pieceId)}
                </a>
                {b.acts ? (
                  <ol className="rt-toc-acts" aria-label={`${b.label}の幕`}>
                    {b.acts.map((a) => (
                      <li key={a.pieceId}>
                        <a
                          href={href}
                          className="rt-toc-link rt-toc-act"
                          onClick={(e) => onJump(e, actAnchorId(a.pieceId), pages?.get(a.pieceId))}
                          data-testid="toc-act-link"
                        >
                          <span className="rt-toc-label">{a.label}</span>
                          {a.body === null ? (
                            <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE} data-testid="toc-missing">
                              採用原稿なし
                            </span>
                          ) : null}
                          {pageOf(a.pieceId)}
                        </a>
                      </li>
                    ))}
                  </ol>
                ) : null}
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
  // 1話だけ（話の画面の「この話を通し読み」。?piece=）。その間は章の範囲を使わない
  const pieceScope = useMemo(() => resolvePieceScope(data, titleId, params.get('piece')), [data, titleId, params])
  const chapterId = useMemo(
    () => (pieceScope ? undefined : resolveChapterScope(data, titleId, params.get('chapter'))),
    [data, titleId, params, pieceScope],
  )
  const chapters = useMemo(() => chaptersOf(data, titleId), [data, titleId])
  const blocks = useMemo(
    () => (pieceScope ? episodeBlocks(buildReadThrough(data, titleId), pieceScope) : buildReadThrough(data, titleId, chapterId)),
    [data, titleId, chapterId, pieceScope],
  )
  const groups = useMemo(() => tocGroups(blocks), [blocks])
  const stats = useMemo(() => readStats(data, blocks), [data, blocks])
  // 各話テキスト書き出しは範囲に関係なくタイトル全体を書き出すので、タイトル全体に話があるかで判断する
  const titleHasPieces = useMemo(() => flatten(data, titleId).length > 0, [data, titleId])
  // 画面の外にある話の大きさの見積もりに使う段落の形と、遠くの話に置く記号と読みを除いた本文（どちらも稿ごとに1回だけ作る）
  const layouts = useMemo(() => {
    const out = new Map<ID, PieceLayout>()
    for (const b of blocks) {
      if (b.type !== 'piece') continue
      if (b.acts) {
        // 幕に分けた話: 各幕の段落の形を足し、幕の見出しの分を空行として足す
        const shape: LineShape = { chars: 0, paras: 0, blank: 0 }
        const actPlain = new Map<ID, string>()
        for (const a of b.acts) {
          shape.blank += ACT_HEAD_LINES
          const v = a.body === null ? null : actVersion(data, a.pieceId)
          if (!v) continue
          const s = lineShape(v)
          shape.chars += s.chars
          shape.paras += s.paras
          shape.blank += s.blank
          actPlain.set(a.pieceId, strippedBody(v))
        }
        out.set(b.pieceId, { shape, actPlain })
        continue
      }
      if (b.body === null) continue
      const v = pieceVersion(data, b.pieceId)
      if (v) out.set(b.pieceId, { shape: lineShape(v), plain: strippedBody(v) })
    }
    return out
  }, [data, blocks])
  const vertical = usePrefs((s) => s.verticalReading)
  const fontSize = clampFontSize(usePrefs((s) => s.editorFontSize))
  const setPrefs = usePrefs((s) => s.setPrefs)
  // 縦書きのページ表示: タイトルの字数×行数のページに組む（話ごとの覚えで、本文・字数が変わらない話は組み直さない）
  const setup = pageSetupOf(title)
  const [pageCache] = useState(createPageCache)
  const layout = useMemo(
    () => (vertical ? layoutVerticalPages(blocks, { chars: setup.chars, lines: setup.lines }, pageCache) : null),
    [vertical, blocks, setup.chars, setup.lines, pageCache],
  )
  // 目次のページ番号（話・幕の最初のページ）
  const tocPages = useMemo(() => {
    if (!layout) return null
    const m = new Map<ID, number>()
    for (const ep of layout.episodes) {
      m.set(ep.pieceId, ep.startPage)
      for (const a of ep.acts ?? []) m.set(a.pieceId, a.page)
    }
    return m
  }, [layout])
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
  // 1話だけの時の話（見出し・パンくず）
  const scopeBlock = pieceScope ? blocks.find((b): b is PieceBlock => b.type === 'piece') : undefined
  const scopeLabel = scopeBlock ? fullLabel(scopeBlock) : ''
  const scopeChapter = title?.chaptersEnabled && scopeBlock?.chapterId ? data.chapters[scopeBlock.chapterId] : undefined
  useDocumentTitle(
    title
      ? `通し読み: ${scopeBlock ? `${scopeLabel}（${titleName}）` : chapter ? `${chapterName}（${titleName}）` : titleName}`
      : undefined,
  )

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

  // 開いた時・範囲を変えた時は先頭から読めるようにする（前の画面のスクロール位置を引き継がない）。
  // 描く前に戻しておく（先頭の話のルビ・傍点を、最初の描画から出せるように）
  useLayoutEffect(() => {
    window.scrollTo?.(0, 0)
    if (docRef.current) docRef.current.scrollLeft = 0
  }, [titleId, chapterId, pieceScope])

  // 1行（縦書きでは1列）に入る字数。画面の外の話の大きさの見積もりに使う
  useCharsPerLine(docRef, TEXT_LETTER_SPACING, [vertical, fontSize, stats.pieces === 0])

  // 画面の近くに来た話だけルビ・傍点を表示する見張り役。縦書きでは本文の枠の中を横にスクロールするので、枠を基準にする
  const near = useNearViewportWatcher(() => (vertical ? docRef.current : null), [vertical, stats.pieces === 0])
  const { check: checkNear, scheduleCheck: scheduleNearCheck } = near

  // 縦書きのページ表示: ページが本文の枠の高さに収まる1マスの大きさ（文字の大きさはそれより大きくしない）
  const editorFont = usePrefs((s) => s.editorFont)
  // 目次を本文の上に開いている間（スマホ・狭い画面の縦置き）は、ページを縮めない（閉じればまた同じ高さ）。
  // 目次を本文の横に出す画面（広い画面・スマホの横置き）では、開いたまま読むこともあるので、いつも合わせる
  const tocOpenRef = useRef(tocOpen)
  useLayoutEffect(() => {
    tocOpenRef.current = tocOpen
  }, [tocOpen])
  const [pageFitOptions] = useState(() => ({
    cancelSettle,
    hold: () => tocOpenRef.current && Boolean(window.matchMedia?.(TOC_ABOVE_BODY).matches),
  }))
  const [pageFit, refitPages] = usePageFit(docRef, setup.chars, vertical && stats.pieces > 0, editorFont, pageFitOptions)
  const shownSize = vertical ? pagedFontSize(fontSize, pageFit) : fontSize
  const pageFull = vertical && pageFit !== null && shownSize + 1 > pageFit

  // 縦書き・文字の大きさ・字数×行数を切り替えたら、切り替える前に読んでいた所を出す
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    if (!anchor) return
    const target = document.getElementById(anchor.id)
    if (!target) return
    // 横書き（話の大きさは見積もり）では、1行の字数を先に合わせてから移動する
    if (!vertical && docRef.current) applyCharsPerLine(docRef.current, TEXT_LETTER_SPACING)
    cancelSettle.current?.()
    cancelSettle.current = settleScrollTo(target, docRef.current, vertical, anchor.fraction)
    // 出した所の近くの話は、描く前にルビ・傍点の表示にする（コミットの途中なので、終わってから）
    scheduleNearCheck()
  }, [vertical, fontSize, setup.chars, setup.lines, scheduleNearCheck])

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
  const jumpTo = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, anchorId: string, page?: number) => {
      e.preventDefault()
      // スマホでは目次を先に閉じる（閉じて本文の位置が動いてから移動する。縦書きのページは、広がった枠に合わせてから）
      flushSync(() => setTocOpen(false))
      if (verticalRef.current) refitPages()
      // 縦書きのページ表示の幕は、幕の見出しのあるページへ（見出しはページが画面の近くに来てから作る）
      const target =
        (page !== undefined && verticalRef.current ? document.getElementById(pageAnchorId(page)) : null) ??
        document.getElementById(anchorId)
      if (!target) return
      // 途中の話はまだ組んでいない（見積もりの大きさ）ので、すぐに移動し、組み上がってずれたら合わせ直す
      cancelSettle.current?.()
      cancelSettle.current = settleScrollTo(target, docRef.current, verticalRef.current, 0)
      // 移動した先とその近くの話は、描く前にルビ・傍点の表示にする（読みが後から現れないように）
      checkNear()
      const anchor = document.getElementById(anchorId)
      const heading = anchor?.matches('[data-heading]') ? anchor : anchor?.querySelector<HTMLElement>('[data-heading]')
      heading?.focus({ preventScroll: true })
    },
    [checkNear, refitPages],
  )

  if (!title) return <NotFound message="タイトルが見つかりません。" />

  const crumbs: Crumb[] = [{ label: titleName, to: paths.title(titleId) }]
  if (scopeBlock) {
    if (scopeChapter) crumbs.push({ label: scopeChapter.name.trim() || '無題の章', to: paths.chapter(titleId, scopeChapter.id) })
    crumbs.push({ label: scopeLabel, to: paths.piece(titleId, scopeBlock.pieceId) })
  } else if (chapter) crumbs.push({ label: chapterName, to: paths.chapter(titleId, chapter.id) })
  crumbs.push({ label: '通し読み' })

  const setScope = (next: string) => {
    if (next === SCOPE_PIECE) return
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        // 1話だけの通し読みから全体・章へ広げる
        p.delete('piece')
        if (next) p.set('chapter', next)
        else p.delete('chapter')
        return p
      },
      { replace: true },
    )
  }

  const text = () => {
    if (!pieceScope) return readThroughText(getData(), titleId, chapterId)
    return readBlocksText(episodeBlocks(buildReadThrough(getData(), titleId), pieceScope))
  }
  const fileName = scopeBlock
    ? `${safeFileName(`${titleName}_${scopeLabel}`)}.txt`
    : chapter
      ? `${safeFileName(`${titleName}_${chapterName}`)}.txt`
      : `${safeFileName(title.name)}.txt`

  /** 今読んでいる所を覚えておく（表示を切り替えた後に同じ所を出す） */
  const keepPlace = () => {
    const doc = docRef.current
    anchorRef.current = doc ? readingAnchor(doc, vertical) : null
  }
  /** 表示の切り替え。今読んでいる所を覚えておき、切り替えた後に同じ所を出す */
  const changeView = (patch: { verticalReading?: boolean; editorFontSize?: number }) => {
    keepPlace()
    setPrefs(patch)
  }
  /** 縦書きのページの字数×行数（タイトルの設定。同期する） */
  const changeSetup = (next: PageSetup) => {
    if (!samePageSetup(next, setup)) keepPlace()
    attempt(() => actions.setTitlePageSetup(titleId, next))
  }

  const pieceCount = stats.pieces
  const isEmpty = pieceCount === 0
  const style = { '--rt-size': `${fontSize}px` } as CSSProperties
  const docStyle = layout
    ? ({ '--pg-font': `${fontSize}px`, '--pg-chars': setup.chars, '--pg-lines': setup.lines } as CSSProperties)
    : undefined
  const showScope = scopeBlock !== undefined || (title.chaptersEnabled && chapters.length > 0)

  return (
    <div ref={rootRef} className={`rt-root${vertical ? ' is-vertical' : ''}`} style={style} data-testid="read-page">
      <AppHeader crumbs={crumbs} />

      <div className="rt-toolbar" ref={toolbarRef} data-testid="read-toolbar">
        <div className="rt-toolbar-inner">
          <div className="rt-tools">
            {showScope ? (
              <label className="rt-scope">
                <span className="rt-tool-label">範囲</span>
                <select
                  className="select rt-scope-select"
                  value={scopeBlock ? SCOPE_PIECE : (chapterId ?? '')}
                  onChange={(e) => setScope(e.target.value)}
                  data-testid="read-scope"
                >
                  <option value="">全体</option>
                  {title.chaptersEnabled
                    ? chapters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name.trim() || '無題の章'}
                        </option>
                      ))
                    : null}
                  {scopeBlock ? <option value={SCOPE_PIECE}>{scopeLabel}</option> : null}
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
                onClick={() => changeView({ editorFontSize: clampFontSize(shownSize - 1) })}
                disabled={shownSize <= FONT_MIN}
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
                {shownSize}
                <span className="visually-hidden">ピクセル</span>
              </span>
              <button
                type="button"
                className="rt-size-btn"
                onClick={() => changeView({ editorFontSize: clampFontSize(shownSize + 1) })}
                disabled={fontSize >= FONT_MAX || pageFull}
                aria-label="文字を大きく"
                title={pageFull ? 'ページが本文の枠の高さいっぱいです' : '文字を大きく'}
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
            {layout ? <PageSetupControl setup={setup} onChange={changeSetup} /> : null}
          </div>

          <div className="rt-summary">
            <span className="rt-counts">
              <span className="rt-total" data-testid="read-total">
                採用原稿 <strong>{formatCount(stats.chars)}</strong>字
              </span>
              {layout && !isEmpty ? (
                <span className="rt-pages" data-testid="read-pages">
                  ・全<strong>{formatCount(layout.totalPages)}</strong>ページ<span className="rt-pages-note">（目安）</span>
                </span>
              ) : null}
            </span>
            {stats.missing + stats.missingActs > 0 ? (
              <span className="badge badge-missing" data-testid="read-missing">
                {readMissingLabel(stats)}
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
              onClick={() => void saveTextFile(fileName, text())}
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
              disabled={!titleHasPieces}
              aria-label="各話テキスト書き出し"
              title="タイトル全体の採用原稿を、1話1ファイルのテキストで書き出す"
              data-testid="episode-export-open"
            >
              <FilesIcon />
              <span className="hide-mobile">各話テキスト書き出し</span>
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
              pages={tocPages}
            />

            <article
              ref={docRef}
              className={`rt-doc${layout ? ' is-paged' : ''}`}
              style={docStyle}
              aria-label={scopeBlock ? `${scopeLabel}の本文` : chapter ? `${chapterName}の本文` : `${titleName}の本文`}
              tabIndex={vertical ? 0 : undefined}
              data-testid="read-body"
              data-pages={layout ? layout.totalPages : undefined}
            >
              <NearViewportContext.Provider value={near.register}>
                {layout ? (
                  <PagedContent
                    blocks={blocks}
                    layout={layout}
                    titleId={titleId}
                    titleName={titleName}
                    chapterName={chapter ? chapterName : null}
                  />
                ) : (
                  <DocContent
                    blocks={blocks}
                    layouts={layouts}
                    titleId={titleId}
                    titleName={titleName}
                    chapterName={chapter ? chapterName : null}
                  />
                )}
              </NearViewportContext.Provider>
            </article>
          </div>
        )}
      </main>
      {exportingEpisodes ? (
        <EpisodeExportDialog
          titleId={titleId}
          scopedToChapter={chapter !== undefined || scopeBlock !== undefined}
          onClose={() => setExportingEpisodes(false)}
        />
      ) : null}
    </div>
  )
}
