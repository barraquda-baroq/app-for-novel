// ホームのアイデア領域。タイトルの数だけ仕切りがあり、最後に「どのタイトルにも属さない」仕切りが必ずある。
import { useEffect, useMemo } from 'react'
import { ideaSections } from '../../domain/entityOps'
import { useData } from '../../store/appStore'
import { BulbIcon } from '../../ui/icons'
import { sectionKey } from '../ideas/ideaLogic'
import { IdeaSectionView } from '../ideas/IdeaSectionView'
import { QuickCapture } from '../ideas/QuickCapture'
import { useCollapsedSections } from '../ideas/storage'

export function IdeaArea({ headingId, focusSection }: { headingId: string; focusSection?: string | null }) {
  const data = useData()
  const sections = useMemo(() => ideaSections(data), [data])
  const total = useMemo(() => sections.reduce((n, s) => n + s.ideas.length, 0), [sections])
  const [collapsed, toggleCollapsed, expandSection] = useCollapsedSections()

  // タイトルのアイデアタブから来たときは、その仕切りを見せる
  useEffect(() => {
    if (!focusSection) return
    expandSection(focusSection)
    const raf = requestAnimationFrame(() => {
      document.getElementById(`idea-section-${focusSection}`)?.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [focusSection, expandSection])

  return (
    <>
      <div className="home-pane-head">
        <BulbIcon className="icon home-pane-icon is-idea" />
        <h2 id={headingId}>アイデア</h2>
        <span className="home-pane-count" data-testid="idea-total">
          {total}
        </span>
        <span className="grow" />
        <span className="home-pane-note small muted hide-mobile">タイトルごとに仕切られています</span>
      </div>

      <QuickCapture sections={sections} draftKey="home" />

      <div className="idea-sections" data-testid="idea-sections">
        {sections.map((s) => {
          const key = sectionKey(s.titleId)
          return (
            <IdeaSectionView
              key={key}
              section={s}
              collapsible
              collapsed={collapsed.has(key)}
              onToggleCollapsed={() => toggleCollapsed(key)}
              showOpenLink
            />
          )
        })}
      </div>
    </>
  )
}
