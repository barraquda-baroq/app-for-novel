// 通し読み: タイトル（または章）を、採用（アクティブ）原稿だけで最初から最後まで読む画面。
// 採用原稿がない話には「採用原稿がありません。」と表示する。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Link, useHref, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { buildReadThrough, NO_ACTIVE_MESSAGE, readThroughText } from '../../domain/readthrough'
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
import { VerticalTextIcon } from './readIcons'
import {
  clampFontSize,
  FONT_MAX,
  FONT_MIN,
  pieceAnchorId,
  readStats,
  resolveChapterScope,
  splitTcy,
  tocGroups,
  type PieceBlock,
} from './readLogic'
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
  const stats = useMemo(() => readStats(blocks), [blocks])
  const vertical = usePrefs((s) => s.verticalReading)
  const fontSize = clampFontSize(usePrefs((s) => s.editorFontSize))
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [tocOpen, setTocOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLElement>(null)

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

  const jumpTo = (e: MouseEvent<HTMLAnchorElement>, pieceId: ID) => {
    e.preventDefault()
    const target = document.getElementById(pieceAnchorId(pieceId))
    if (!target) return
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start', inline: 'start' })
    target.querySelector<HTMLElement>('[data-heading]')?.focus({ preventScroll: true })
    setTocOpen(false)
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
              onClick={() => setPrefs({ verticalReading: !vertical })}
              data-testid="vertical-toggle"
            >
              <VerticalTextIcon />
              縦書き
            </button>
            <div className="rt-size" role="group" aria-label="文字の大きさ">
              <button
                type="button"
                className="rt-size-btn"
                onClick={() => setPrefs({ editorFontSize: clampFontSize(fontSize - 1) })}
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
                onClick={() => setPrefs({ editorFontSize: clampFontSize(fontSize + 1) })}
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
            <nav className={`rt-toc${tocOpen ? ' is-open' : ''}`} aria-label="目次" data-testid="read-toc">
              <button
                type="button"
                className="rt-toc-toggle"
                aria-expanded={tocOpen}
                onClick={() => setTocOpen((v) => !v)}
                data-testid="toc-toggle"
              >
                <ListIcon />
                <span className="grow">目次</span>
                <span className="rt-toc-count">{pieceCount}</span>
                <ChevronRightIcon className="icon rt-toc-chevron" />
              </button>
              <h2 className="rt-toc-title">
                目次<span className="rt-toc-count">{pieceCount}</span>
              </h2>
              <div className="rt-toc-body">
                {groups.map((g, gi) => (
                  <div key={g.chapterId ?? `root-${gi}`} className="rt-toc-group">
                    {g.name ? <p className="rt-toc-chapter">{g.name}</p> : null}
                    <ol className="rt-toc-list">
                      {g.items.map((b) => (
                        <li key={b.pieceId}>
                          <a
                            href={selfHref}
                            className={`rt-toc-link${b.kind === 'special' ? ' is-special' : ''}`}
                            onClick={(e) => jumpTo(e, b.pieceId)}
                            data-testid="toc-link"
                          >
                            <span className="rt-toc-label">{b.label}</span>
                            {b.subtitle.trim() ? <span className="rt-toc-subtitle">{b.subtitle.trim()}</span> : null}
                            {b.body === null ? (
                              <span className="rt-toc-missing" title={NO_ACTIVE_MESSAGE}>
                                採用なし
                              </span>
                            ) : null}
                          </a>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </nav>

            <article
              ref={docRef}
              className="rt-doc"
              aria-label={chapter ? `${chapterName}の本文` : `${titleName}の本文`}
              tabIndex={vertical ? 0 : undefined}
              data-testid="read-body"
            >
              <header className="rt-doc-head">
                <h1 className="rt-doc-title">{titleName}</h1>
                {chapter ? <p className="rt-doc-sub">{chapterName}</p> : null}
              </header>
              {blocks.map((b) =>
                b.type === 'chapter' ? (
                  <h2 key={`ch-${b.chapterId}`} className="rt-chapter" data-testid="read-chapter">
                    <Tcy text={b.name.trim() || '無題の章'} />
                  </h2>
                ) : b.type === 'chapterEnd' ? (
                  // 章が終わり、どの章にも入っていない話が続く
                  <hr
                    key={`end-${b.chapterId}`}
                    className="rt-chapter-end"
                    aria-label="章の終わり"
                    data-testid="read-chapter-end"
                  />
                ) : (
                  <section
                    key={b.pieceId}
                    id={pieceAnchorId(b.pieceId)}
                    className={`rt-piece${b.kind === 'special' ? ' is-special' : ''}`}
                    data-testid="read-piece"
                    data-kind={b.kind}
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
                    ) : b.body.trim() === '' ? (
                      <p className="rt-blank">（本文はまだありません）</p>
                    ) : (
                      <div className="rt-text" data-testid="read-text">
                        {b.body}
                      </div>
                    )}
                  </section>
                ),
              )}
            </article>
          </div>
        )}
      </main>
    </div>
  )
}
