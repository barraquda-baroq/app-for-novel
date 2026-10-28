// ゴミ箱: 削除したものを新しい順（削除した日ごと）に並べ、元の場所に戻す・完全に削除する。
// 30日たったものは自動で完全に削除される（App の TrashPurge）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { listTrash } from '../../domain/trash'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useApp } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { useDocumentTitle } from '../../ui/hooks'
import { TrashIcon, UndoIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { CONFLICT_HELP, TRASH_LEAD, daysLeftLabel, restoredMessage, trashDays, type TrashRow } from './trashLogic'
import './trash.css'

/** 残り日数の表示を進めるため、ときどき今の時刻を取り直す */
function useNow(intervalMs: number): number {
  const [nowTs, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return nowTs
}

export function TrashPage() {
  useDocumentTitle('ゴミ箱')
  const entries = useApp((s) => s.data.trashEntries)
  const records = useApp((s) => s.data.trashRecords)
  const nowTs = useNow(60_000)
  const sorted = useMemo(() => listTrash(entries), [entries])
  const days = useMemo(() => trashDays(sorted, records, nowTs), [sorted, records, nowTs])
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 行が消えても続けて操作できるよう、次の行（なければ前の行、それもなければ見出し）の「元に戻す」へフォーカスを移す
  const focusAfter = (id: ID) => {
    const ids = sorted.map((e) => e.id)
    const i = ids.indexOf(id)
    const nextId = ids[i + 1] ?? ids[i - 1]
    requestAnimationFrame(() => {
      const next = nextId
        ? listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(nextId)}"] [data-testid="trash-restore"]`)
        : null
      ;(next ?? headingRef.current)?.focus()
    })
  }

  const restore = (row: TrashRow) => {
    const result = attempt(() => actions.restoreTrashEntry(row.id))
    if (!result) return
    notify(restoredMessage(result))
    focusAfter(row.id)
  }

  const remove = async (row: TrashRow) => {
    const ok = await confirmDialog({
      title: `「${row.label}」を完全に削除しますか？`,
      message: 'ゴミ箱から消して、元に戻せなくなります。この操作は取り消せません。',
      danger: true,
      confirmLabel: '完全に削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteTrashEntry(row.id), true))) {
      notify(`「${row.label}」を完全に削除しました`)
      focusAfter(row.id)
    }
  }

  const emptyAll = async () => {
    const count = sorted.length
    const ok = await confirmDialog({
      title: 'ゴミ箱を空にしますか？',
      message: `ゴミ箱の${count.toLocaleString('ja-JP')}件をすべて完全に削除します。元に戻せなくなります。この操作は取り消せません。`,
      danger: true,
      confirmLabel: '空にする',
    })
    if (!ok) return
    if (attempt(() => (actions.emptyTrash(), true))) {
      notify('ゴミ箱を空にしました')
      requestAnimationFrame(() => headingRef.current?.focus())
    }
  }

  return (
    <>
      <AppHeader crumbs={[{ label: 'ゴミ箱' }]} />
      <main className="page page-narrow trash-page" data-testid="trash-page">
        <div className="trash-head">
          <div className="trash-head-text">
            <h1 ref={headingRef} tabIndex={-1} className="trash-title">
              ゴミ箱
              <span className="trash-count" data-testid="trash-count" aria-label={`${sorted.length}件`}>
                {sorted.length}
              </span>
            </h1>
            <p className="trash-lead">{TRASH_LEAD}</p>
          </div>
          <button
            type="button"
            className="btn btn-danger trash-empty-all"
            onClick={() => void emptyAll()}
            disabled={sorted.length === 0}
            data-testid="trash-empty-all"
          >
            <TrashIcon />
            ゴミ箱を空にする
          </button>
        </div>

        {sorted.length === 0 ? (
          <div className="empty" data-testid="trash-empty">
            ゴミ箱は空です。
          </div>
        ) : (
          <div ref={listRef} className="trash-days">
            {days.map((day) => (
              <section key={day.key} className="trash-day" aria-labelledby={`trash-day-${day.key}`} data-testid="trash-day">
                <h2 id={`trash-day-${day.key}`} className="trash-day-head" data-testid="trash-day-label">
                  {day.label}
                </h2>
                <ul className="list trash-list">
                  {day.rows.map((row) => (
                    <TrashRowView key={row.id} row={row} onRestore={restore} onDelete={remove} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  )
}

function TrashRowView({
  row,
  onRestore,
  onDelete,
}: {
  row: TrashRow
  onRestore: (row: TrashRow) => void
  onDelete: (row: TrashRow) => Promise<void>
}) {
  const at = row.entry.deletedAt
  return (
    <li
      className={`card trash-row${row.conflict ? ' is-conflict' : ''}`}
      data-testid="trash-row"
      data-entry-id={row.id}
      data-kind={row.entry.kind}
    >
      <div className="trash-row-main">
        <div className="trash-row-tags">
          <span className="badge badge-accent" data-testid="trash-kind">
            {row.kind}
          </span>
          {row.conflict ? (
            <span className="badge badge-missing" title={CONFLICT_HELP} data-testid="trash-conflict">
              同期の競合で残した内容
            </span>
          ) : null}
        </div>
        <p className="trash-row-label" data-testid="trash-label">
          {row.label}
        </p>
        {row.place ? (
          <p className="trash-row-place" data-testid="trash-place">
            {row.place}
          </p>
        ) : null}
        <p className="trash-row-meta">
          <time
            dateTime={Number.isFinite(at) ? new Date(at).toISOString() : undefined}
            title={formatDateTime(at)}
            data-testid="trash-time"
          >
            {row.time}に削除
          </time>
          <span aria-hidden="true">・</span>
          <span className={row.daysLeft <= 3 ? 'trash-soon' : undefined} data-testid="trash-days-left">
            {daysLeftLabel(row.daysLeft)}
          </span>
        </p>
        {row.conflict ? <p className="trash-row-note">{CONFLICT_HELP}</p> : null}
      </div>
      <div className="trash-row-actions" role="group" aria-label={`「${row.label}」の操作`}>
        <button type="button" className="btn btn-sm" onClick={() => onRestore(row)} data-testid="trash-restore">
          <UndoIcon />
          元に戻す
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => void onDelete(row)} data-testid="trash-delete">
          完全に削除
        </button>
      </div>
    </li>
  )
}
