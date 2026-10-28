// ホーム: 起動するとタイトル群とアイデア領域が表示される。
// 広い画面（721px〜）では左右に並べ、スマホでは上下に積む（タイトルを先に、その下にアイデア）。
// スマホでは上部の切り替えで、どちらの先頭へも1タップで移れる（どちらかを隠すことはしない）。
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../../store/appStore'
import { useDocumentTitle, useMediaQuery } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { BackupReminder } from './BackupReminder'
import { parseHomeView, type HomeView } from './homeLogic'
import { IdeaArea } from './IdeaArea'
import { useHomeScrollMemory } from './scrollMemory'
import { TitleGroup } from './TitleGroup'
import './home.css'

const AREAS: { id: HomeView; label: string }[] = [
  { id: 'titles', label: 'タイトル' },
  { id: 'ideas', label: 'アイデア' },
]

/** スマホの上下表示で、アイデア領域の先頭が画面のこの割合より上に来たら「アイデア」を表示中とみなす */
const SPY_RATIO = 0.5

export function HomePage() {
  useDocumentTitle(undefined)
  useHomeScrollMemory()
  const data = useData()
  const twoColumns = useMediaQuery('(min-width: 721px)')
  const [params, setParams] = useSearchParams()
  // ?view=ideas&focus=<titleId>（タイトルのアイデアタブの「すべてのアイデアを見る」から）は一度だけ使う
  const [focus, setFocus] = useState<string | null>(() => params.get('focus'))
  const [linkedView, setLinkedView] = useState<HomeView | null>(() => parseHomeView(params.get('view')))
  const [current, setCurrent] = useState<HomeView>('titles')
  const baseId = useId()
  const titleHeadingId = `${baseId}-titles-heading`
  const ideaHeadingId = `${baseId}-ideas-heading`
  const paneIds: Record<HomeView, string> = { titles: `${baseId}-pane-titles`, ideas: `${baseId}-pane-ideas` }
  const ideasPane = useRef<HTMLElement>(null)
  const titleCount = Object.keys(data.titles).length
  const ideaCount = useMemo(() => Object.keys(data.ideas).length, [data.ideas])
  const counts: Record<HomeView, number> = { titles: titleCount, ideas: ideaCount }

  // リンクの指定を反映したら URL からは消す（再読み込みや「戻る」で同じ場所へ飛ばし直さないように）
  useEffect(() => {
    if (!params.has('view') && !params.has('focus')) return
    setFocus(params.get('focus'))
    setLinkedView(parseHomeView(params.get('view')))
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])

  // ?view=ideas だけの時は、アイデア領域の先頭を見せる（仕切りの指定があればアイデア領域がその仕切りを見せる）
  useEffect(() => {
    if (linkedView !== 'ideas' || focus || twoColumns) return
    const raf = requestAnimationFrame(() => ideasPane.current?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(raf)
  }, [linkedView, focus, twoColumns])

  // 上下に積んでいる時、いまどちらの領域を見ているかを切り替えに表示する
  useEffect(() => {
    if (twoColumns) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // 一番上にいる時は「タイトル」。下へ進んでアイデア領域が画面の上半分に来たら（または最後まで来たら）「アイデア」
        const top = ideasPane.current?.getBoundingClientRect().top ?? Infinity
        const scrolled = window.scrollY > 0
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
        setCurrent(scrolled && (top <= window.innerHeight * SPY_RATIO || atBottom) ? 'ideas' : 'titles')
      })
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [twoColumns])

  const jumpTo = (area: HomeView) => {
    const pane = document.getElementById(paneIds[area])
    if (!pane) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    pane.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    // 読み上げ・キーボードでも移った先から続けられるように、領域の見出しへフォーカスを移す
    document.getElementById(area === 'titles' ? titleHeadingId : ideaHeadingId)?.focus({ preventScroll: true })
  }

  return (
    <>
      <AppHeader />
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

        <BackupReminder onDone={() => document.getElementById(titleHeadingId)?.focus({ preventScroll: true })} />

        <div className="home-grid">
          <section
            id={paneIds.titles}
            className="home-pane home-titles"
            aria-labelledby={titleHeadingId}
            data-area="titles"
            data-testid="title-group"
          >
            <TitleGroup headingId={titleHeadingId} />
          </section>
          <section
            ref={ideasPane}
            id={paneIds.ideas}
            className="home-pane home-ideas"
            aria-labelledby={ideaHeadingId}
            data-area="ideas"
            data-testid="idea-area"
          >
            <IdeaArea headingId={ideaHeadingId} focusSection={focus} />
          </section>
        </div>
      </main>
    </>
  )
}
