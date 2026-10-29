// 戦略タブの戦略メモ: Claude が採用原稿をもとに考えた今後の戦略（狙うコンテストなど）のカード。新しい日付から並ぶ。
// ［全体戦略に追記］で「【Claude YYYY-MM-DD】見出し…」を全体戦略の末尾に足し、コンテストの候補は［応募計画にする］で応募計画にする。
import { memo, useMemo, useState } from 'react'
import { shortDate } from '../../../claude/dates'
import { strategyNotesOf } from '../../../claude/order'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../../claude/visibility'
import { trashNotice } from '../../../domain/trash'
import type { ID, StrategyContest, StrategyNote } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { formatDateTime } from '../../../ui/browser'
import { confirmDialog } from '../../../ui/dialogs'
import { ChevronRightIcon, LinkIcon, PlusIcon, TrashIcon } from '../../../ui/icons'
import { SparkIcon } from '../../claude/claudeIcons'
import { sourceLabel } from '../../claude/claudeUi'
import { Markdown } from '../../claude/Markdown'
import { formatYmd, limitRange } from './strategyLogic'

/** 閉じている時に見せる本文の長さ（これより長ければ「全文を表示」） */
const LONG_NOTE = 600

export interface StrategyNotesProps {
  titleId: ID
  headingId: string
  today: string
  /** 応募計画のカードを開いて見せる */
  onReveal: (submissionId: ID) => void
  /** 「Claude に頼む（手動）」「結果を貼り付け」 */
  actionsSlot?: React.ReactNode
}

export function StrategyNotes({ titleId, headingId, today, onReveal, actionsSlot }: StrategyNotesProps) {
  const data = useData()
  const notes = useMemo(() => strategyNotesOf(data, titleId), [data.strategyNotes, titleId]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="sx-section" aria-labelledby={headingId} id="sx-notes" data-testid="strategy-memos">
      <div className="sx-head">
        <div className="sx-title">
          <h2 id={headingId}>
            戦略メモ<span className="sx-count">{notes.length}</span>
          </h2>
          <p className="small muted">
            Claude が採用原稿から考えた戦略。全体戦略に追記したり、コンテストを応募計画にしたりできます。
          </p>
        </div>
        <span className="grow" />
        {actionsSlot}
      </div>
      {notes.length === 0 ? (
        <div className="empty sx-empty" data-testid="strategy-memos-empty">
          <p>まだ戦略メモがありません。</p>
          <p className="small">Claude のコネクタか「Claude に頼む（手動）」で、狙うコンテストなどの戦略を考えてもらえます。</p>
        </div>
      ) : (
        <ol className="sx-list">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} today={today} onReveal={onReveal} submissions={data.submissions} />
          ))}
        </ol>
      )}
    </section>
  )
}

const NoteCard = memo(function NoteCard({
  note,
  today,
  onReveal,
  submissions,
}: {
  note: StrategyNote
  today: string
  onReveal: (id: ID) => void
  submissions: Record<ID, unknown>
}) {
  const [full, setFull] = useState(false)
  const long = note.body.length > LONG_NOTE
  const badge = sourceLabel(note.source) ?? 'メモ'
  const heading = note.heading.trim() || '戦略メモ'

  const append = async () => {
    if (note.appliedAt) {
      const ok = await confirmDialog({
        title: 'もう一度追記しますか？',
        message: `このメモは ${formatDateTime(note.appliedAt)} に全体戦略へ追記済みです。もう一度、全体戦略の末尾に足しますか？`,
        confirmLabel: '追記する',
      })
      if (!ok) return
    }
    if (attempt(() => (actions.appendStrategyNoteToTitle(note.id), true))) notify('全体戦略の末尾に追記しました')
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${heading}」を削除しますか？`,
      message: trashNotice('戦略メモを'),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteStrategyNote(note.id), true))) notify('戦略メモをゴミ箱に移しました')
  }

  return (
    <li className="sx-card sn-card" data-testid="strategy-memo" data-note-id={note.id}>
      <div className="sn-head">
        <span className="badge cl-badge" data-testid="strategy-memo-source">
          <SparkIcon />
          {badge}
        </span>
        <span className="sn-date" data-testid="strategy-memo-date">
          {shortDate(note.runDate, today)}
        </span>
        {isNewerRecord(note) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
        {note.model ? <span className="tiny faint">{note.model}</span> : null}
      </div>
      <h3 className="sn-heading">{heading}</h3>
      {note.body.trim() ? (
        <div className={`sn-body${long && !full ? ' is-clamped' : ''}`}>
          <Markdown text={note.body} testId="strategy-memo-body" />
        </div>
      ) : null}
      {long ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm sn-more"
          aria-expanded={full}
          onClick={() => setFull((v) => !v)}
          data-testid="strategy-memo-more"
        >
          <ChevronRightIcon className="icon sx-chevron" />
          {full ? '折りたたむ' : '全文を表示'}
        </button>
      ) : null}
      {note.contests.length ? (
        <div className="sn-contests">
          <h4 className="sn-contests-title">コンテストの候補</h4>
          <ul className="sn-contest-list">
            {note.contests.map((c) => (
              <ContestRow
                key={c.id}
                noteId={note.id}
                contest={c}
                planned={c.submissionId !== null && Boolean(submissions[c.submissionId])}
                onReveal={onReveal}
              />
            ))}
          </ul>
        </div>
      ) : null}
      <div className="sx-card-actions">
        <button type="button" className="btn btn-sm" onClick={() => void append()} data-testid="strategy-memo-append">
          <PlusIcon />
          全体戦略に追記
        </button>
        {note.appliedAt ? (
          <span className="tiny faint" data-testid="strategy-memo-applied">
            追記済み（{formatDateTime(note.appliedAt)}）
          </span>
        ) : null}
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          onClick={() => void remove()}
          aria-label={`「${heading}」を削除`}
          title="削除（ゴミ箱へ）"
          data-testid="strategy-memo-delete"
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  )
})

function ContestRow({
  noteId,
  contest: c,
  planned,
  onReveal,
}: {
  noteId: ID
  contest: StrategyContest
  planned: boolean
  onReveal: (id: ID) => void
}) {
  const limit = limitRange(c.minChars, c.maxChars, c.limitUnit)
  const deadline = formatYmd(c.deadline)
  const toPlan = () => {
    const id = attempt(() => actions.contestToSubmission(noteId, c.id))
    if (!id) return
    notify(`応募計画に「${c.name.trim() || 'コンテスト'}」を追加しました`)
    if (getData().submissions[id]) onReveal(id)
  }
  return (
    <li className="sn-contest" data-testid="strategy-contest">
      <div className="sn-contest-name">
        <strong>{c.name.trim() || '（名前なし）'}</strong>
        {c.organizer.trim() ? <span className="sn-contest-org">{c.organizer}</span> : null}
      </div>
      {deadline || limit || c.url ? (
        <div className="sn-contest-meta">
          {deadline ? <span>締切 {deadline}</span> : null}
          {limit ? <span>規定 {limit}</span> : null}
          {c.url ? (
            <a href={c.url} target="_blank" rel="noopener noreferrer" className="sn-contest-link">
              <LinkIcon />
              公式ページ
            </a>
          ) : null}
        </div>
      ) : null}
      {c.fit.trim() ? (
        <p className="sn-contest-text">
          <span className="sn-contest-label">相性</span>
          {c.fit}
        </p>
      ) : null}
      {c.plan.trim() ? (
        <p className="sn-contest-text">
          <span className="sn-contest-label">方針</span>
          {c.plan}
        </p>
      ) : null}
      <div className="sn-contest-actions">
        {planned && c.submissionId ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onReveal(c.submissionId!)}
            data-testid="strategy-contest-open"
          >
            応募計画にしました（開く）
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={toPlan} data-testid="strategy-contest-plan">
            応募計画にする
          </button>
        )}
      </div>
    </li>
  )
}
