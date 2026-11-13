// ホーム: 起動するとタイトル群とアイデア領域が表示される。その後に、比べるために読む既存の作品の棚「相対比較」（2.5。内部名は bench）と、
// 創作のために読む資料の棚「資料」（2.6。内部名は materials）。
// 広い画面（721px〜）では左右に並べ（左にタイトルとその下の相対比較・資料、右にアイデア）、スマホでは上下に積む
// （タイトル → アイデア → 相対比較 → 資料）。スマホでは上部の切り替えで、どの先頭へも1タップで移れる（どれかを隠すことはしない）。
// 2.9: 4つの領域は帯で、起動した時・読み込み直した時は4つとも閉じている（homeBands.ts。見出しに件数を出し、押すと開け閉め）。
// 切り替えとリンク（?view=）は、その帯を開いてから移る。
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../../store/appStore'
import { TrashLink } from '../trash/TrashLink'
import { useDocumentTitle, useMediaQuery } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { BackupReminder } from './BackupReminder'
import { openBand, toggleBand, useOpenBands } from './homeBands'
import { parseHomeView, type HomeView } from './homeLogic'
import { BenchShelf } from './BenchShelf'
import { IdeaArea } from './IdeaArea'
import { MaterialShelf } from './MaterialShelf'
import { useHomeScrollMemory } from './scrollMemory'
import { TitleGroup } from './TitleGroup'
import './home.css'

const AREAS: { id: HomeView; label: string }[] = [
  { id: 'titles', label: 'タイトル' },
  { id: 'ideas', label: 'アイデア' },
  { id: 'bench', label: '相対比較' },
  { id: 'materials', label: '資料' },
]

/** スマホの上下表示で、領域の先頭が画面のこの割合より上に来たら、その領域を表示中とみなす */
const SPY_RATIO = 0.5

export function HomePage() {
  useDocumentTitle(undefined)
  useHomeScrollMemory()
  const data = useData()
  const twoColumns = useMediaQuery('(min-width: 721px)')
  const [params, setParams] = useSearchParams()
  // ?view=ideas&focus=<titleId>（タイトルのアイデアタブの「すべてのアイデアを見る」から）は一度だけ使う
  const [focus, setFocus] = useState<string | null>(() => params.get('focus'))
  const [linkedView, setLinkedView] = useState<HomeView | null>(() => {
    const view = parseHomeView(params.get('view'))
    // リンクで指した帯は、中身を描く前に開いておく（アイデア欄が ?focus= の仕切りを見つけられるように）
    if (view) openBand(view)
    return view
  })
  const bands = useOpenBands()
  const [current, setCurrent] = useState<HomeView>('titles')
  const baseId = useId()
  const headingIds: Record<HomeView, string> = {
    titles: `${baseId}-titles-heading`,
    ideas: `${baseId}-ideas-heading`,
    bench: `${baseId}-bench-heading`,
    materials: `${baseId}-materials-heading`,
  }
  const titleHeadingId = headingIds.titles
  const ideaHeadingId = headingIds.ideas
  /** 帯の見出しのボタン（切り替え・リンクで移った時のフォーカスの先） */
  const toggleOf = (area: HomeView) => document.getElementById(`${headingIds[area]}-toggle`)
  const paneIds: Record<HomeView, string> = {
    titles: `${baseId}-pane-titles`,
    ideas: `${baseId}-pane-ideas`,
    bench: `${baseId}-pane-bench`,
    materials: `${baseId}-pane-materials`,
  }
  const ideasPane = useRef<HTMLElement>(null)
  const benchPane = useRef<HTMLElement>(null)
  const materialsPane = useRef<HTMLElement>(null)
  // 切り替え（またはリンク）で移った領域。自分でスクロールし始めるまでは、位置ではなくこれを表示中とする
  const pinned = useRef<HomeView | null>(null)
  const titleCount = Object.keys(data.titles).length
  const ideaCount = useMemo(() => Object.keys(data.ideas).length, [data.ideas])
  const benchCount = Object.keys(data.benchWorks).length
  const materialCount = Object.keys(data.materials).length
  const counts: Record<HomeView, number> = {
    titles: titleCount,
    ideas: ideaCount,
    bench: benchCount,
    materials: materialCount,
  }

  // リンクの指定を反映したら URL からは消す（再読み込みや「戻る」で同じ場所へ飛ばし直さないように）
  useEffect(() => {
    if (!params.has('view') && !params.has('focus')) return
    const view = parseHomeView(params.get('view'))
    if (view) openBand(view)
    setFocus(params.get('focus'))
    setLinkedView(view)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])

  // ?view=ideas だけの時は、アイデアの帯（初めの描画の前に開いてある）の見出しのボタンにフォーカスし、上下に積んでいる時は
  // その先頭を見せる（仕切りの指定 ?focus= があれば、アイデア領域がその仕切りを見せる）
  useEffect(() => {
    if (linkedView !== 'ideas' || focus) return
    const raf = requestAnimationFrame(() => toggleOf('ideas')?.focus({ preventScroll: true }))
    if (twoColumns) return () => cancelAnimationFrame(raf)
    pinned.current = 'ideas'
    setCurrent('ideas')
    const scroll = requestAnimationFrame(() => ideasPane.current?.scrollIntoView({ block: 'start' }))
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(scroll)
    }
  }, [linkedView, focus, twoColumns]) // eslint-disable-line react-hooks/exhaustive-deps

  // ?view=titles・?view=bench（相対比較の作品の画面のパンくずから）・?view=materials（資料の画面のパンくずから）: 帯を開いて
  // （初めの描画の前に開いてある）先頭を見せ、見出しのボタンにフォーカスを移す（どの幅でも）。上下に積んでいる時は、その帯を
  // 表示中にする（相対比較の下に資料の棚があるので、位置から決めると、短い相対比較の棚へ移った時に「資料」になってしまう）
  useEffect(() => {
    if (linkedView !== 'titles' && linkedView !== 'bench' && linkedView !== 'materials') return
    const view = linkedView
    if (!twoColumns) {
      pinned.current = view
      setCurrent(view)
    }
    const raf = requestAnimationFrame(() => {
      document.getElementById(paneIds[view])?.scrollIntoView({ block: 'start' })
      toggleOf(view)?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [linkedView]) // eslint-disable-line react-hooks/exhaustive-deps

  // 上下に積んでいる時、いまどちらの領域を見ているかを切り替えに表示する
  useEffect(() => {
    if (twoColumns) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // 切り替えで移った直後は、押した領域を表示中のままにする（下が短くて最後で止まっても、押した方を示す）
        if (pinned.current) {
          setCurrent(pinned.current)
          return
        }
        // 一番上にいる時は「タイトル」。下へ進んでアイデア領域が画面の上半分に来たら「アイデア」、相対比較の棚が来たら
        // 「相対比較」、資料の棚が来たら（または最後まで来たら）「資料」
        const line = window.innerHeight * SPY_RATIO
        const ideasTop = ideasPane.current?.getBoundingClientRect().top ?? Infinity
        const benchTop = benchPane.current?.getBoundingClientRect().top ?? Infinity
        const materialsTop = materialsPane.current?.getBoundingClientRect().top ?? Infinity
        const scrolled = window.scrollY > 0
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
        setCurrent(
          !scrolled
            ? 'titles'
            : materialsTop <= line || atBottom
              ? 'materials'
              : benchTop <= line
                ? 'bench'
                : ideasTop <= line
                  ? 'ideas'
                  : 'titles',
        )
      })
    }
    // 自分でスクロールし始めたら、また位置から決める（切り替えのボタンでも pointerdown・keydown が click より先に来るので、
    // 前の固定が外れてから、押した領域が新しく固定される）
    const release = () => {
      pinned.current = null
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    window.addEventListener('wheel', release, { passive: true })
    window.addEventListener('pointerdown', release, { passive: true })
    window.addEventListener('keydown', release)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('wheel', release)
      window.removeEventListener('pointerdown', release)
      window.removeEventListener('keydown', release)
    }
    // 帯を開け閉めすると領域の位置が変わるので、その時にも決め直す
  }, [twoColumns, bands])

  const jumpTo = (area: HomeView) => {
    // 閉じている帯は開いてから移る（開いている帯は閉じない）。開いた中身を描き終えてから位置を決める
    flushSync(() => openBand(area))
    const pane = document.getElementById(paneIds[area])
    if (!pane) return
    pinned.current = area
    setCurrent(area)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    pane.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    // 読み上げ・キーボードでも移った先から続けられるように、帯の見出しのボタンへフォーカスを移す
    toggleOf(area)?.focus({ preventScroll: true })
  }

  return (
    <>
      <AppHeader actions={<TrashLink />} />
      <main className="page home-page" data-testid="home">
        {!twoColumns ? (
          <nav className="home-jump" aria-label="ホームの領域へ移動" data-testid="home-jump">
            <div className="segmented home-jump-seg">
              {AREAS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-current={current === a.id ? 'true' : undefined}
                  aria-controls={paneIds[a.id]}
                  onClick={() => jumpTo(a.id)}
                  data-area={a.id}
                  data-testid={`home-jump-${a.id}`}
                >
                  {a.label}
                  <span className="home-jump-count">{counts[a.id]}</span>
                </button>
              ))}
            </div>
          </nav>
        ) : null}

        <BackupReminder onDone={() => toggleOf('titles')?.focus({ preventScroll: true })} />

        <div className="home-grid">
          <section
            id={paneIds.titles}
            className="home-pane home-titles"
            aria-labelledby={`${titleHeadingId}-name`}
            data-area="titles"
            data-testid="title-group"
          >
            <TitleGroup headingId={titleHeadingId} open={bands.has('titles')} onToggle={() => toggleBand('titles')} />
          </section>
          <section
            ref={ideasPane}
            id={paneIds.ideas}
            className="home-pane home-ideas"
            aria-labelledby={`${ideaHeadingId}-name`}
            data-area="ideas"
            data-testid="idea-area"
          >
            <IdeaArea
              headingId={ideaHeadingId}
              focusSection={focus}
              open={bands.has('ideas')}
              onToggle={() => toggleBand('ideas')}
            />
          </section>
          <section
            ref={benchPane}
            id={paneIds.bench}
            className="home-pane home-bench"
            aria-labelledby={`${headingIds.bench}-name`}
            data-area="bench"
            data-testid="bench-shelf"
          >
            <BenchShelf headingId={headingIds.bench} open={bands.has('bench')} onToggle={() => toggleBand('bench')} />
          </section>
          <section
            ref={materialsPane}
            id={paneIds.materials}
            className="home-pane home-materials"
            aria-labelledby={`${headingIds.materials}-name`}
            data-area="materials"
            data-testid="material-shelf"
          >
            <MaterialShelf
              headingId={headingIds.materials}
              open={bands.has('materials')}
              onToggle={() => toggleBand('materials')}
            />
          </section>
        </div>
      </main>
    </>
  )
}
