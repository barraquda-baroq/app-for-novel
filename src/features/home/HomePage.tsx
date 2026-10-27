// ホーム: 起動するとタイトル群とアイデア領域が表示される。
// 広い画面では左右に並べ、スマホでは上部の切り替え（タイトル／アイデア）でどちらも1タップで行き来できる。
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../../store/appStore'
import { useDocumentTitle, useMediaQuery } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { readLocal, writeLocal } from '../ideas/storage'
import { HOME_VIEW_KEY, parseHomeView, type HomeView } from './homeLogic'
import { IdeaArea } from './IdeaArea'
import { useScrollTopOnMount } from './scroll'
import { TitleGroup } from './TitleGroup'
import './home.css'

const VIEWS: { id: HomeView; label: string }[] = [
  { id: 'titles', label: 'タイトル' },
  { id: 'ideas', label: 'アイデア' },
]

export function HomePage() {
  useDocumentTitle(undefined)
  const data = useData()
  const wide = useMediaQuery('(min-width: 900px)')
  const [params, setParams] = useSearchParams()
  // ?view=ideas&focus=<titleId>（タイトルのアイデアタブの「すべてのアイデアを見る」から）は一度だけ使う
  const [focus, setFocus] = useState<string | null>(() => params.get('focus'))
  const [view, setViewState] = useState<HomeView>(() => {
    const linked = parseHomeView(params.get('view'))
    if (linked) {
      writeLocal(HOME_VIEW_KEY, linked)
      return linked
    }
    return parseHomeView(readLocal(HOME_VIEW_KEY)) ?? 'titles'
  })
  useScrollTopOnMount(Boolean(focus))
  const baseId = useId()
  const titleHeadingId = `${baseId}-titles-heading`
  const ideaHeadingId = `${baseId}-ideas-heading`
  const titleCount = Object.keys(data.titles).length
  const ideaCount = useMemo(() => Object.keys(data.ideas).length, [data.ideas])

  const setView = (next: HomeView) => {
    setViewState(next)
    writeLocal(HOME_VIEW_KEY, next)
  }

  // リンクの指定を反映したら URL からは消す（再読み込みで前回の表示に戻れるように）
  useEffect(() => {
    if (!params.has('view') && !params.has('focus')) return
    const linked = parseHomeView(params.get('view'))
    if (linked) {
      setViewState(linked)
      writeLocal(HOME_VIEW_KEY, linked)
    }
    setFocus(params.get('focus'))
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const next: HomeView = e.key === 'Home' ? 'titles' : e.key === 'End' ? 'ideas' : view === 'titles' ? 'ideas' : 'titles'
    setView(next)
    document.getElementById(`${baseId}-tab-${next}`)?.focus()
  }

  const counts: Record<HomeView, number> = { titles: titleCount, ideas: ideaCount }

  return (
    <>
      <AppHeader />
      <main className="page home-page" data-testid="home">
        {!wide ? (
          <div className="home-switch" data-testid="home-switch">
            <div className="segmented home-switch-seg" role="tablist" aria-label="表示する内容">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  id={`${baseId}-tab-${v.id}`}
                  type="button"
                  role="tab"
                  aria-selected={view === v.id}
                  aria-controls={`${baseId}-pane-${v.id}`}
                  tabIndex={view === v.id ? 0 : -1}
                  onClick={() => setView(v.id)}
                  onKeyDown={onTabKey}
                  data-testid={`home-tab-${v.id}`}
                >
                  {v.label}
                  <span className="home-switch-count">{counts[v.id]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="home-grid">
          <section
            id={`${baseId}-pane-titles`}
            className="home-pane home-titles"
            aria-labelledby={wide ? titleHeadingId : `${baseId}-tab-titles`}
            role={wide ? undefined : 'tabpanel'}
            hidden={!wide && view !== 'titles'}
            data-testid="title-group"
          >
            <TitleGroup headingId={titleHeadingId} />
          </section>
          <section
            id={`${baseId}-pane-ideas`}
            className="home-pane home-ideas"
            aria-labelledby={wide ? ideaHeadingId : `${baseId}-tab-ideas`}
            role={wide ? undefined : 'tabpanel'}
            hidden={!wide && view !== 'ideas'}
            data-testid="idea-area"
          >
            <IdeaArea headingId={ideaHeadingId} focusSection={focus} />
          </section>
        </div>
      </main>
    </>
  )
}
