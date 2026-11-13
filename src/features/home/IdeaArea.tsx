// ホームのアイデア領域。タイトルの数だけ仕切りがあり、最後に「どのタイトルにも属さない」仕切りが必ずある。
// 仕切りが増えても目的の仕切りへすぐ行けるよう、先頭に仕切りの一覧（名前と件数）と「すべて折りたたむ／開く」を置く。
// 2.9: ホームの帯の1つ（見出しで開け閉め。閉じている間は中身を描かない）。すばやく追加は帯の中にあるので、
// 見出しの［＋ 書きとめる］で帯を開いて、すぐ書きとめられるようにする。仕切り・フォルダの開け閉めは帯とは別に覚えている。
import { useCallback, useEffect, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { ideaSections, type IdeaSection } from '../../domain/entityOps'
import type { ID } from '../../domain/types'
import { useData } from '../../store/appStore'
import { BookIcon, BulbIcon, PlusIcon } from '../../ui/icons'
import { InboxIcon } from '../ideas/ideaIcons'
import { sectionDisplayName, sectionKey } from '../ideas/ideaLogic'
import { IdeaSectionView } from '../ideas/IdeaSectionView'
import { QuickCapture } from '../ideas/QuickCapture'
import { IdeaSectionOpenContext, revealIdeaInTree } from '../ideas/reveal'
import { useCollapsedSections } from '../ideas/storage'
import { bandBodyId, HomeBandHead } from './HomeBandHead'
import { openBand, toggleBand } from './homeBands'

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/** 仕切りの見出しまでスクロールし、見出しのボタンにフォーカスする（描画が終わってから） */
function scrollToSection(key: string, smooth: boolean): number {
  return requestAnimationFrame(() => {
    const el = document.getElementById(`idea-section-${key}`)
    if (!el) return
    el.scrollIntoView({ block: 'start', behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' })
    el.querySelector<HTMLElement>('[data-testid="idea-section-toggle"]')?.focus({ preventScroll: true })
  })
}

export function IdeaArea({
  headingId,
  focusSection,
  open = true,
  onToggle = () => toggleBand('ideas'),
}: {
  headingId: string
  focusSection?: string | null
  /** 帯が開いているか（ホームが渡す。単独で描く時は開いている） */
  open?: boolean
  onToggle?: () => void
}) {
  const data = useData()
  const sections = useMemo(() => ideaSections(data), [data])
  const total = useMemo(() => sections.reduce((n, s) => n + s.ideas.length, 0), [sections])
  const { collapsed, toggle, expand: expandSection, setAll } = useCollapsedSections()
  const bodyId = bandBodyId(headingId)
  // 仕切りを開く時は、帯も開く（移した後・「表示」で、閉じた帯の中のカードを見せる時のため）
  const expand = useCallback(
    (key: string) => {
      openBand('ideas')
      expandSection(key)
    },
    [expandSection],
  )
  const keys = useMemo(() => sections.map((s) => sectionKey(s.titleId)), [sections])
  const allCollapsed = keys.every((k) => collapsed.has(k))
  const noneCollapsed = keys.every((k) => !collapsed.has(k))

  // タイトルのアイデアタブから来たときは、その仕切りを見せる
  useEffect(() => {
    if (!focusSection) return
    expand(focusSection)
    const raf = scrollToSection(focusSection, false)
    return () => cancelAnimationFrame(raf)
  }, [focusSection, expand])

  const jump = (key: string) => {
    expand(key)
    scrollToSection(key, true)
  }

  // すばやく追加の「表示」: 仕切りと、入っているフォルダ（2.9）を折りたたんでいれば開いてから、追加したカードを見せる
  const reveal = (ideaId: ID) => revealIdeaInTree(ideaId, expand)

  // 一覧では「どのタイトルにも属さない」（受け箱）を先頭に置く。仕切りの並びでは一番下にあって遠いため
  const indexSections = useMemo(() => {
    const unassigned = sections.filter((s) => s.titleId === null)
    return [...unassigned, ...sections.filter((s) => s.titleId !== null)]
  }, [sections])

  // 見出しの［＋ 書きとめる］: 帯を開いて（すばやく追加は帯の中）、書きとめる欄にフォーカスする
  const capture = () => {
    flushSync(() => openBand('ideas'))
    document.getElementById(bodyId)?.querySelector<HTMLElement>('[data-testid="quick-idea-input"]')?.focus()
  }

  return (
    <>
      <HomeBandHead
        area="ideas"
        headingId={headingId}
        bodyId={bodyId}
        open={open}
        onToggle={onToggle}
        icon={BulbIcon}
        label="アイデア"
        count={total}
        countTestId="idea-total"
        actions={
          <>
            <span className="home-pane-note small muted hide-mobile">
              タイトルごとに仕切られ、フォルダ（2段まで）に分けられます
            </span>
            <button
              type="button"
              className="btn btn-sm home-band-capture"
              onClick={capture}
              aria-label="書きとめる"
              title="アイデアをすばやく書きとめる"
              data-testid="idea-band-capture"
            >
              <PlusIcon />
              <span className="home-band-capture-label">書きとめる</span>
            </button>
          </>
        }
      />
      {open ? (
        <div id={bodyId} className="home-band-body">
          <QuickCapture sections={sections} draftKey="home" onReveal={reveal} />

          {sections.length > 1 ? (
            <nav className="home-index" aria-label="アイデアの仕切りの一覧" data-testid="idea-index">
              <div className="home-index-head">
                <span className="home-index-label">仕切りへ移動</span>
                <span className="grow" />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost home-index-all"
                  onClick={() => setAll(keys)}
                  disabled={allCollapsed}
                  data-testid="idea-collapse-all"
                >
                  すべて折りたたむ
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost home-index-all"
                  onClick={() => setAll([])}
                  disabled={noneCollapsed}
                  data-testid="idea-expand-all"
                >
                  すべて開く
                </button>
              </div>
              <ul className="home-index-list">
                {indexSections.map((s) => (
                  <IndexChip
                    key={sectionKey(s.titleId)}
                    section={s}
                    collapsed={collapsed.has(sectionKey(s.titleId))}
                    onJump={jump}
                  />
                ))}
              </ul>
            </nav>
          ) : null}

          {/* 移した後などに、移した先の仕切りを開けるように（IdeaMoveDialog・IdeaFolderMoveDialog） */}
          <IdeaSectionOpenContext.Provider value={expand}>
            <div className="idea-sections" data-testid="idea-sections">
              {sections.map((s) => {
                const key = sectionKey(s.titleId)
                return (
                  <IdeaSectionView
                    key={key}
                    section={s}
                    collapsible
                    collapsed={collapsed.has(key)}
                    onToggleCollapsed={() => toggle(key)}
                    showOpenLink
                  />
                )
              })}
            </div>
          </IdeaSectionOpenContext.Provider>
        </div>
      ) : null}
    </>
  )
}

function IndexChip({ section, collapsed, onJump }: { section: IdeaSection; collapsed: boolean; onJump: (key: string) => void }) {
  const key = sectionKey(section.titleId)
  const name = sectionDisplayName(section)
  const unassigned = section.titleId === null
  return (
    <li className={unassigned ? 'is-unassigned' : undefined}>
      <button
        type="button"
        className={`home-index-chip${unassigned ? ' is-unassigned' : ''}${collapsed ? ' is-collapsed' : ''}`}
        onClick={() => onJump(key)}
        title={collapsed ? `${name}（折りたたみ中。押すと開きます）` : name}
        data-testid="idea-index-chip"
        data-section={key}
      >
        <span className="home-index-icon" aria-hidden="true">
          {unassigned ? <InboxIcon /> : <BookIcon />}
        </span>
        <span className="home-index-name">{name}</span>
        <span className="home-index-count" data-count={section.ideas.length}>
          {section.ideas.length}
          <span className="visually-hidden">件</span>
        </span>
      </button>
    </li>
  )
}
