// 通し読みの縦書きのページ表示（ReadThroughPage の本文）。verticalPages.ts で組んだページ（タイトルの字数×行数）を、
// 本のように右から左へ並べる（次のページは左）。各ページの下にページ番号。章の見出しはページの外（ページの間）に出す。
// - ページの大きさ: 1マス = 文字の大きさ（［−］［＋］でページごと大きく・小さくなる。字数×行数は変わらない）。ただし本文の枠の
//   高さに収まる大きさまで（--pg-fit。usePageFit）。スマホでもページの高さは画面に収まり、横にスクロールして読む。
// - ルビ・傍点は字の右に小さく置き、マスを取らない（読みは親文字の外にはみ出してよい。行の長さは親文字だけ）。
// - 縦書きの字の送りが 1em でない書体（縦書き用の寸法を持たない書体）では、字を少し小さくして1字を1マスに収める（--pg-adv）。
// - 長編でも軽いよう、画面の近くに来たページだけ行を組む（nearViewport.ts）。遠いページには記号と読みを除いた文字だけを、
//   同じ行の送りで置く（ページ内検索で見つかる）。ページは大きさが決まっているので、画面の外のページは組版もしない
//   （content-visibility: auto）。話ごと・ページごとに React.memo（変わった話・ページだけを描き直す）。
import { Fragment, memo, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import type { ReadBlock } from '../../domain/readthrough'
import { parseRuby, stripRuby } from '../../domain/ruby'
import type { ID } from '../../domain/types'
import { paths } from '../../routes'
import { EditIcon } from '../../ui/icons'
import { useNearViewport } from '../../ui/nearViewport'
import { actAnchorId, pageAnchorId, pageFitCell, pieceAnchorId } from './readLogic'
import { readingAnchor, settleScrollTo } from './scrollAnchor'
import { Tcy } from './Tcy'
import type { Page, PageLine, VerticalPagesLayout } from './verticalPages'

/**
 * 本文の書体の、縦書きの字の送り（1em に対する割合）。縦書き用の寸法を持たない書体は、上下の高さで送るので 1 より大きい。
 * 測れない・ありえない値なら 1
 */
function glyphAdvance(doc: HTMLElement): number {
  const probe = document.createElement('span')
  probe.className = 'pg-probe'
  // かなで測る（本文にいちばん多い字。かなと漢字で書体が分かれる環境でも、多い方に合わせる）
  probe.textContent = 'あいうえおアイウエオ'
  doc.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  const r = h / 1000
  return r > 0.8 && r < 1.6 && Math.abs(r - 1) > 0.01 ? Math.round(r * 1000) / 1000 : 1
}

export interface PageFitOptions {
  /**
   * 読んでいる所を合わせ直している途中の処理をやめる関数（scrollAnchor.ts の settleScrollTo の戻り値）。通し読みの画面と
   * 共有する（目次から移動した時・表示を切り替えた時の合わせ直しと、ページの大きさが変わった時の合わせ直しが、互いに止め合う）
   */
  cancelSettle: MutableRefObject<(() => void) | null>
  /**
   * true の間は、枠の高さが変わってもページの大きさを変えない（スマホなどで目次を本文の上に開いている間。枠が一時的に
   * 低くなるだけなので、ページを読めない大きさまで縮めない。閉じれば同じ高さに戻る）。測り直す時に毎回呼ぶ
   */
  hold: () => boolean
}

/**
 * ページが本文の枠（ref）の高さに収まる1マスの大きさ（px）を測り、枠に --pg-fit として入れる（描く前に。ResizeObserver）。
 * 本文の書体の字の送りも測り、--pg-adv に入れる（書体 font が変わった時も測り直す）。
 * 枠の高さが変わってページの大きさが変わる時（画面の大きさ・向きを変えた、目次を開け閉めした）は、変える前に読んでいた所を
 * 変えた後も出す（ページはそのままの位置の px でなく、話の中の割合で合わせる）。
 * 戻り値は 1マスの大きさ（ツールバーの［＋］を押せるかに使う。測れない・enabled でない間は null）と、今すぐ測り直す関数
 * （スマホで目次を閉じて枠の高さが変わった直後に移動する時など。知らせを待つと、移動した後にページの大きさが変わるので）
 */
export function usePageFit(
  ref: RefObject<HTMLElement | null>,
  chars: number,
  enabled: boolean,
  font: string,
  options: PageFitOptions,
): [fit: number | null, refit: () => void] {
  const [fit, setFit] = useState<number | null>(null)
  const applyRef = useRef<((height: number) => void) | null>(null)
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    el.style.setProperty('--pg-adv', String(glyphAdvance(el)))
    return () => {
      el.style.removeProperty('--pg-adv')
    }
  }, [ref, enabled, font])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled || typeof ResizeObserver === 'undefined') return
    let last: number | null = null
    const apply = (height: number) => {
      const f = pageFitCell(height, chars)
      if (f === last) return
      const { cancelSettle, hold } = optionsRef.current
      if (last !== null && hold()) return
      // 変える前に読んでいた所（ResizeObserver の知らせの時は、ページはまだ前の大きさで、スクロールの位置も切り詰められていない）
      const anchor = last !== null ? readingAnchor(el, true) : null
      last = f
      if (f === null) el.style.removeProperty('--pg-fit')
      else el.style.setProperty('--pg-fit', `${f}px`)
      setFit(f)
      const target = anchor ? document.getElementById(anchor.id) : null
      if (anchor && target) {
        cancelSettle.current?.()
        cancelSettle.current = settleScrollTo(target, el, true, anchor.fraction)
      }
    }
    applyRef.current = apply
    // 内側（余白・スクロールバーを除く）の高さ
    const ro = new ResizeObserver((entries) => apply(entries[entries.length - 1].contentRect.height))
    ro.observe(el)
    return () => {
      ro.disconnect()
      applyRef.current = null
      el.style.removeProperty('--pg-fit')
    }
  }, [ref, chars, enabled])
  const [refit] = useState(() => () => {
    const el = ref.current
    const apply = applyRef.current
    if (!el || !apply) return
    const cs = getComputedStyle(el)
    apply(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
  })
  return [enabled ? fit : null, refit]
}

/** ページの中の本文の1行。ルビの読みは親文字の右に小さく（マスを取らない）、傍点は黒ゴマ */
const PageRubyText = memo(function PageRubyText({ text }: { text: string }) {
  const segments = parseRuby(text)
  if (segments.length === 0) return null
  if (segments.length === 1 && segments[0].type === 'text') return <>{segments[0].text}</>
  return (
    <>
      {segments.map((s, i) =>
        s.type === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.type === 'ruby' ? (
          <span key={i} className="pg-ruby">
            {s.base}
            <span className="pg-rt">{s.reading}</span>
          </span>
        ) : (
          <em key={i} className="rb-bouten">
            {s.text}
          </em>
        ),
      )}
    </>
  )
})

function lineClass(l: PageLine): string {
  return `pg-line is-${l.kind}`
}

/**
 * 1ページの行。見出しの行は見出しの要素にまとめる（話の最初のページの見出しは目次から移動した時にフォーカスする）。
 * 幕の見出しの要素の id は通し読みの幕の id（actAnchorId）
 */
const PageLines = memo(function PageLines({ lines, first }: { lines: Page; first: boolean }) {
  const out: ReactNode[] = []
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]
    if (l.kind === 'heading' || l.kind === 'act') {
      let j = i + 1
      while (j < lines.length && lines[j].kind === l.kind && lines[j].actId === l.actId) j++
      const group = lines.slice(i, j).map((x, k) => (
        <span key={k} className={lineClass(x)}>
          <Tcy text={x.text} />
        </span>
      ))
      if (l.kind === 'act' && l.actId) {
        out.push(
          <h4
            key={i}
            id={actAnchorId(l.actId)}
            className="pg-heading is-act"
            tabIndex={-1}
            data-heading
            data-testid="read-act-label"
          >
            {group}
          </h4>,
        )
      } else if (l.kind === 'heading' && first && i === 0) {
        out.push(
          <h3 key={i} className="pg-heading" tabIndex={-1} data-heading data-testid="page-heading">
            {group}
          </h3>,
        )
      } else {
        // 長い見出しの続き（次のページ）
        out.push(
          <div key={i} className="pg-heading">
            {group}
          </div>,
        )
      }
      i = j
      continue
    }
    out.push(
      <span key={i} className={lineClass(l)} data-testid={l.kind === 'missing' ? 'no-active' : undefined}>
        {l.kind === 'text' ? <PageRubyText text={l.text} /> : l.text}
      </span>,
    )
    i++
  }
  return <>{out}</>
})

/** 遠いページに置く文字（記号と読みを除き、行ごとに改行。同じ行の送りで並ぶ） */
function plainText(lines: Page): string {
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text
    if (i > 0) out += '\n'
    out += lines[i].kind === 'text' && t.indexOf('《') >= 0 ? stripRuby(t) : t
  }
  return out
}

/** 1ページ。画面の近くに来てから行を組む（一度組んだら戻さない） */
const PageSheet = memo(function PageSheet({ lines, number, first }: { lines: Page; number: number; first: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearViewport(ref, true)
  return (
    <div
      ref={ref}
      id={pageAnchorId(number)}
      className="pg-page"
      role="group"
      aria-label={`${number}ページ`}
      data-testid="read-page-sheet"
      data-page={number}
      data-near={near ? 'true' : undefined}
    >
      {near ? <PageLines lines={lines} first={first} /> : <span className="pg-plain">{plainText(lines)}</span>}
      <span className="pg-num" aria-hidden="true" data-testid="page-number">
        {number}
      </span>
    </div>
  )
})

/** 1話分のページ。本文・字数×行数・最初のページの番号が変わらない限り描き直さない */
const PagedEpisode = memo(function PagedEpisode({
  pieceId,
  kind,
  label,
  editTitle,
  titleId,
  pages,
  startPage,
}: {
  pieceId: ID
  kind: 'episode' | 'special'
  /** 「第3話　題」 */
  label: string
  editTitle: string
  titleId: ID
  pages: readonly Page[]
  startPage: number
}) {
  return (
    <section
      id={pieceAnchorId(pieceId)}
      className={`pg-episode${kind === 'special' ? ' is-special' : ''}`}
      aria-label={label}
      data-testid="read-piece"
      data-kind={kind}
      data-start-page={startPage}
      data-page-count={pages.length}
    >
      <div className="pg-tab">
        <Link
          to={paths.piece(titleId, pieceId)}
          className="rt-edit"
          aria-label={`${label}を編集`}
          title={editTitle}
          data-testid="read-edit"
        >
          <EditIcon />
          編集
        </Link>
      </div>
      {pages.map((lines, i) => (
        <PageSheet key={i} lines={lines} number={startPage + i} first={i === 0} />
      ))}
    </section>
  )
})

/** 縦書きのページ表示の本文（タイトル・章の見出し・話ごとのページ）。データ・字数×行数が変わらない限り描き直さない */
export const PagedContent = memo(function PagedContent({
  blocks,
  layout,
  titleId,
  titleName,
  chapterName,
}: {
  blocks: readonly ReadBlock[]
  layout: VerticalPagesLayout
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
      {blocks.map((b) => {
        if (b.type === 'chapter') {
          return (
            <h2 key={`ch-${b.chapterId}`} className="rt-chapter" data-testid="read-chapter">
              <Tcy text={b.name.trim() || '無題の章'} />
            </h2>
          )
        }
        if (b.type === 'chapterEnd') {
          return (
            <hr key={`end-${b.chapterId}`} className="rt-chapter-end" aria-label="章の終わり" data-testid="read-chapter-end" />
          )
        }
        const ep = layout.byPiece.get(b.pieceId)
        if (!ep) return null
        return (
          <PagedEpisode
            key={b.pieceId}
            pieceId={b.pieceId}
            kind={b.kind}
            label={ep.heading}
            editTitle={b.versionName ? `採用中：${b.versionName}` : b.acts ? '幕の一覧を開く' : '原稿を開く'}
            titleId={titleId}
            pages={ep.pages}
            startPage={ep.startPage}
          />
        )
      })}
    </>
  )
})
