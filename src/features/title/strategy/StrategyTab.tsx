// 戦略タブ: 書籍化に向けた全体方針、現在の採用原稿の規模、コンテストへの応募計画（応募順）と結果・改稿/再応募方針。
import { useEffect, useMemo, useState } from 'react'
import { missingActiveLabel, submissionsOf } from '../../../domain/entityOps'
import { formatCount } from '../../../domain/text'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt } from '../../../store/uiStore'
import { promptDialog } from '../../../ui/dialogs'
import { PlusIcon, TargetIcon } from '../../../ui/icons'
import { GrowTextarea } from '../settings/GrowTextarea'
import { SubmissionCard } from './SubmissionCard'
import { manuscriptSummary, sortByDeadline } from './strategyLogic'
import { useToday } from './useToday'
import './strategy.css'

type SortMode = 'order' | 'deadline'

export function StrategyTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const title = data.titles[titleId]
  const summary = useMemo(() => manuscriptSummary(data, titleId), [data, titleId])
  const submissions = useMemo(() => submissionsOf(data, titleId), [data, titleId])
  const [sort, setSort] = useState<SortMode>('order')
  // 開いたまま日付が変わっても、締切・結果発表までの日数を更新する
  const today = useToday()
  const shown = useMemo(
    () => (sort === 'deadline' ? sortByDeadline(submissions, today) : submissions),
    [sort, submissions, today],
  )
  const current = useMemo(() => ({ chars: summary.chars, pages: summary.pages }), [summary])
  const [expanded, setExpanded] = useState<ReadonlySet<ID>>(() => new Set())
  const [reveal, setReveal] = useState<ID | null>(null)

  useEffect(() => {
    if (!reveal) return
    const el = document.querySelector(`[data-submission-id="${reveal}"]`)
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    setReveal(null)
  }, [reveal])

  if (!title) return null

  const toggle = (id: ID) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const add = async () => {
    const name = await promptDialog({
      title: '応募先を追加',
      label: 'コンテスト名',
      placeholder: '例：〇〇小説大賞、△△文庫新人賞',
      confirmLabel: '追加',
    })
    if (name === null) return
    const id = attempt(() => actions.addSubmission(titleId, name.trim()))
    if (!id) return
    if (sort === 'deadline' && getData().submissions[id]) setSort('order')
    setExpanded((prev) => new Set(prev).add(id))
    setReveal(id)
  }

  const positions = new Map(submissions.map((s, i) => [s.id, i + 1]))

  return (
    <div className="sg-tab" data-testid="strategy-tab">
      <div className="sg-top">
        <section className="card sg-panel sg-note" aria-labelledby="sg-note-heading">
          <div className="sg-panel-head">
            <h2 id="sg-note-heading" className="sg-panel-title">
              <TargetIcon />
              全体戦略
            </h2>
          </div>
          <GrowTextarea
            key={title.id}
            className="textarea sg-note-input"
            rows={5}
            value={title.strategyNote}
            onCommit={(v) => {
              if (getData().titles[titleId] && v !== getData().titles[titleId].strategyNote) {
                attempt(() => actions.updateTitle(titleId, { strategyNote: v }))
              }
            }}
            placeholder="狙うレーベル・ジャンル、応募の優先順位の考え方、書籍化までの道筋など"
            aria-label="全体戦略"
            data-testid="strategy-note"
          />
        </section>

        <section className="card sg-panel sg-current" aria-labelledby="sg-current-heading" data-testid="manuscript-summary">
          <div className="sg-panel-head">
            <h2 id="sg-current-heading" className="sg-panel-title">
              現在の原稿
            </h2>
            <span className="tiny faint">採用原稿のみ</span>
          </div>
          <dl className="sg-stats">
            <div className="sg-stat sg-stat-chars">
              <dt>総文字数</dt>
              <dd data-testid="summary-chars">
                {formatCount(summary.chars)}
                <small>字</small>
              </dd>
            </div>
            <div className="sg-stat">
              <dt>原稿用紙換算</dt>
              <dd data-testid="summary-pages">
                <small>約</small>
                {formatCount(summary.pages)}
                <small>枚</small>
              </dd>
            </div>
            <div className="sg-stat">
              <dt>話数</dt>
              <dd data-testid="summary-episodes">
                {summary.episodes}
                <small>話</small>
                {summary.specials > 0 ? <span className="sg-stat-sub">＋特殊 {summary.specials}</span> : null}
              </dd>
            </div>
          </dl>
          {summary.missingActive > 0 ? (
            <p className="sg-missing" data-testid="summary-missing">
              {missingActiveLabel(summary.missingEpisodes, summary.missingSpecials)}
              <span>（文字数に含まれていません）</span>
            </p>
          ) : null}
          <p className="tiny faint sg-current-note">
            文字数は空白・改行を除いて数えています。応募前の応募先の規定（文字数・枚数）との比較にも使います。
          </p>
        </section>
      </div>

      <section className="sg-plans" aria-labelledby="sg-plans-heading">
        <div className="sg-plans-head">
          <div className="sg-plans-title">
            <h2 id="sg-plans-heading">応募計画・結果</h2>
            <p className="small muted">応募する順に並べ、結果と次の一手を記録します。</p>
          </div>
          <span className="grow" />
          {submissions.length > 1 ? (
            <div className="segmented sg-sort" role="group" aria-label="表示順">
              <button type="button" aria-pressed={sort === 'order'} onClick={() => setSort('order')} data-testid="sort-order">
                応募順
              </button>
              <button
                type="button"
                aria-pressed={sort === 'deadline'}
                onClick={() => setSort('deadline')}
                data-testid="sort-deadline"
              >
                締切順
              </button>
            </div>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => void add()} data-testid="add-submission">
            <PlusIcon />
            応募先を追加
          </button>
        </div>

        {sort === 'deadline' && submissions.length > 1 ? (
          <p className="small muted sg-sort-note" data-testid="sort-note">
            応募前で締切が近いもの → 応募済み・選考中 → 結果が出たもの・締切を過ぎたもの
            の順に表示しています（番号は応募順のままです）。並べ替えるときは「応募順」に戻してください。
          </p>
        ) : null}

        {submissions.length === 0 ? (
          <div className="empty sg-empty" data-testid="submissions-empty">
            <p>まだ応募計画がありません。</p>
            <p className="small">
              応募したいコンテストを応募する順に追加し、締切・規定文字数・結果・改稿方針をまとめて管理できます。
            </p>
          </div>
        ) : (
          <ol className="sg-list" data-testid="submission-list">
            {shown.map((s) => {
              const position = positions.get(s.id) ?? 0
              return (
                <SubmissionCard
                  key={s.id}
                  submission={s}
                  position={position}
                  isFirst={position === 1}
                  isLast={position === submissions.length}
                  canReorder={sort === 'order'}
                  expanded={expanded.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  current={current}
                  today={today}
                />
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
