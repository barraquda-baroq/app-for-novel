// タイトル画面: タイトル名・あらすじ・集計と、本編／設定項目／戦略／アイデアのタブ。
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { missingActiveLabel } from '../../domain/entityOps'
import { formatCount } from '../../domain/text'
import { paths, type TitleTab } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt } from '../../store/uiStore'
import { DraftInput, DraftTextarea } from '../../ui/DraftField'
import { useDocumentTitle } from '../../ui/hooks'
import { BookIcon, ChevronRightIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { TitleIdeasTab } from './ideas/TitleIdeasTab'
import { SettingsTab } from './settings/SettingsTab'
import { StoryTab } from './story/StoryTab'
import { titleStats } from './story/storyLogic'
import { useStoryData } from './story/useStoryData'
import { StrategyTab } from './strategy/StrategyTab'
import './title.css'

const TABS: { id: TitleTab; label: string }[] = [
  { id: 'story', label: '本編' },
  { id: 'settings', label: '設定項目' },
  { id: 'strategy', label: '戦略' },
  { id: 'ideas', label: 'アイデア' },
]

function isTab(v: string | null): v is TitleTab {
  return TABS.some((t) => t.id === v)
}

export function TitlePage() {
  const { titleId = '' } = useParams()
  const data = useData()
  const title = data.titles[titleId]
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const tab: TitleTab = isTab(rawTab) ? rawTab : 'story'
  // 集計は本編に関わるデータが変わった時だけ数え直す（あらすじ・設定項目・戦略の入力では数え直さない）
  const story = useStoryData(titleId)
  const stats = useMemo(() => titleStats(story, titleId), [story, titleId])
  const [synopsisOpen, setSynopsisOpen] = useState(false)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const baseId = useId()
  useDocumentTitle(title ? title.name.trim() || '無題のタイトル' : undefined)

  if (!title) return <NotFound message="タイトルが見つかりません。" />

  const name = title.name.trim() || '無題のタイトル'
  const synopsis = title.synopsis.trim()

  const selectTab = (next: TitleTab) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === 'story') p.delete('tab')
        else p.set('tab', next)
        return p
      },
      { replace: true },
    )
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab)
    let j = -1
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = TABS.length - 1
    if (j < 0) return
    e.preventDefault()
    selectTab(TABS[j].id)
    tabRefs.current[TABS[j].id]?.focus()
  }

  return (
    <>
      <AppHeader
        crumbs={[{ label: name }]}
        actions={
          <Link to={paths.read(titleId)} className="btn btn-sm tpage-header-btn" data-testid="read-through-link">
            <BookIcon />
            通し読み
          </Link>
        }
      />
      <main className="page tpage">
        <header className="tpage-head">
          <DraftInput
            key={title.id}
            className="input-bare tpage-name"
            value={title.name}
            onCommit={(v) => attempt(() => actions.updateTitle(title.id, { name: v }))}
            placeholder="無題のタイトル"
            aria-label="タイトル名"
            data-testid="title-name"
          />

          <ul className="tpage-stats" aria-label="このタイトルの集計">
            <li className="tpage-chip" data-testid="stat-episodes">
              全{stats.episodes}話{stats.specials > 0 ? <span className="tpage-chip-sub">＋特殊 {stats.specials}</span> : null}
            </li>
            <li className="tpage-chip" data-testid="stat-chars">
              採用原稿 {formatCount(stats.chars)}字
              {stats.chars > 0 ? <span className="tpage-chip-sub">（原稿用紙 約{formatCount(stats.pages)}枚）</span> : null}
            </li>
            {stats.missingActive > 0 ? (
              <li className="tpage-chip is-warn" data-testid="stat-missing">
                {missingActiveLabel(stats.missingEpisodes, stats.missingSpecials, stats.missingActs)}
              </li>
            ) : null}
            {title.chaptersEnabled ? (
              <li className="tpage-chip is-accent" data-testid="stat-chapters">
                章あり
              </li>
            ) : null}
          </ul>

          <div className={`tpage-synopsis${synopsisOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="tpage-synopsis-toggle"
              aria-expanded={synopsisOpen}
              aria-controls={`${baseId}-synopsis`}
              onClick={() => setSynopsisOpen((v) => !v)}
              data-testid="synopsis-toggle"
            >
              <ChevronRightIcon className="icon tpage-synopsis-chevron" />
              <span className="tpage-synopsis-label">あらすじ</span>
              {!synopsisOpen ? (
                <span className={`tpage-synopsis-preview${synopsis ? '' : ' is-empty'}`}>
                  {synopsis ? synopsis.replace(/\s+/gu, ' ') : '未記入（押して書く）'}
                </span>
              ) : null}
            </button>
            {synopsisOpen ? (
              <DraftTextarea
                key={title.id}
                id={`${baseId}-synopsis`}
                className="textarea tpage-synopsis-input"
                value={title.synopsis}
                onCommit={(v) => attempt(() => actions.updateTitle(title.id, { synopsis: v }))}
                rows={4}
                placeholder="物語の概要・あらすじを書いておけます"
                aria-label="あらすじ"
                data-testid="synopsis"
                autoFocus={!synopsis}
              />
            ) : null}
          </div>
        </header>

        {/* タブは領域ごとに色分けする（data-area。色は styles.css の --area-*） */}
        <div className="tabs tpage-tabs" role="tablist" aria-label="タイトルの内容" data-area={tab}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => selectTab(t.id)}
              onKeyDown={onTabKey}
              data-area={t.id}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${tab}`}
          className="tpage-panel"
          data-area={tab}
        >
          {tab === 'story' ? <StoryTab titleId={titleId} /> : null}
          {tab === 'settings' ? <SettingsTab titleId={titleId} /> : null}
          {tab === 'strategy' ? <StrategyTab titleId={titleId} /> : null}
          {tab === 'ideas' ? <TitleIdeasTab titleId={titleId} /> : null}
        </div>
      </main>
    </>
  )
}
