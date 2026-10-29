// 戦略タブの改稿案: 案ごとのチェックボックス（実装済み・ボツでチェックすると斜線＋グレーで下へ沈む）。文字数の制限はない
// （ワンシーン丸ごとの案もある）。手で足す・書き直す・並べ替える（チェックしていない案だけ）・削除（ゴミ箱）、関係する話のチップから話を開く。
// Claude（コネクタ・手動連携の貼り付け）が足した案も、ふつうの案として扱う。
import { memo, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { revisionIdeasOf } from '../../../claude/order'
import { readingOrder } from '../../../claude/refs'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../../claude/visibility'
import { episodeNumbers } from '../../../domain/structure'
import { trashNotice } from '../../../domain/trash'
import type { ID, RevisionIdea } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { DraftInput } from '../../../ui/DraftField'
import { ChevronRightIcon, PlusIcon, TrashIcon, XIcon } from '../../../ui/icons'
import { useKeepInPlace } from '../../../ui/keepInPlace'
import { SparkIcon } from '../../claude/claudeIcons'
import { sourceLabel } from '../../claude/claudeUi'
import { GrowTextarea } from '../settings/GrowTextarea'
import { linkedPieces, previewText } from './proofLogic'
import { ArrowDownIcon, ArrowUpIcon } from './strategyIcons'

interface PieceOption {
  id: ID
  label: string
}

export function RevisionIdeas({ titleId, headingId }: { titleId: ID; headingId: string }) {
  const data = useData()
  // 改稿案と話の並びが変わった時だけ作り直す
  const ideas = useMemo(() => revisionIdeasOf(data, titleId), [data.revisionIdeas, titleId]) // eslint-disable-line react-hooks/exhaustive-deps
  const numbers = useMemo(
    () => episodeNumbers(data, titleId),
    [data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const options = useMemo<PieceOption[]>(
    () => readingOrder(data, titleId).map((o) => ({ id: o.piece.id, label: `#${o.index} ${o.fullLabel}` })),
    [data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [expanded, setExpanded] = useState<ReadonlySet<ID>>(() => new Set())
  const [focusId, setFocusId] = useState<ID | null>(null)
  const open = ideas.filter((i) => !i.checked)
  const checkedCount = ideas.length - open.length

  const toggle = useCallback(
    (id: ID) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )

  const add = () => {
    const id = attempt(() => actions.addRevisionIdea(titleId))
    if (!id) return
    setExpanded((prev) => new Set(prev).add(id))
    setFocusId(id)
  }

  return (
    <section className="sx-section" aria-labelledby={headingId} id="sx-revision" data-testid="revision-ideas">
      <div className="sx-head">
        <div className="sx-title">
          <h2 id={headingId}>
            改稿案<span className="sx-count">{open.length}</span>
          </h2>
          <p className="small muted">実装した・ボツにした案はチェックすると、斜線とグレーで下へ沈みます。</p>
        </div>
        <span className="grow" />
        <button type="button" className="btn btn-primary" onClick={add} data-testid="add-revision-idea">
          <PlusIcon />
          改稿案を追加
        </button>
      </div>
      {ideas.length === 0 ? (
        <div className="empty sx-empty" data-testid="revision-ideas-empty">
          <p>まだ改稿案がありません。</p>
          <p className="small">直したい場面・入れ替えたい展開などを書いておけます。Claude の戦略の提案からも入ります。</p>
        </div>
      ) : (
        <ol className="sx-list" data-testid="revision-idea-list">
          {ideas.map((idea) => {
            const openIndex = idea.checked ? -1 : open.findIndex((x) => x.id === idea.id)
            return (
              <IdeaCard
                key={idea.id}
                idea={idea}
                expanded={expanded.has(idea.id)}
                onToggle={toggle}
                first={openIndex === 0}
                last={openIndex === open.length - 1}
                titleId={titleId}
                chips={linkedPieces(data, titleId, idea.pieceIds, numbers)}
                options={options}
                autoFocus={focusId === idea.id}
                onFocused={() => setFocusId(null)}
              />
            )
          })}
        </ol>
      )}
      {checkedCount > 0 ? (
        <p className="tiny faint sx-foot" data-testid="revision-checked-count">
          チェック済み {checkedCount}件（下にあります）
        </p>
      ) : null}
    </section>
  )
}

interface IdeaCardProps {
  idea: RevisionIdea
  expanded: boolean
  onToggle: (id: ID) => void
  first: boolean
  last: boolean
  titleId: ID
  chips: { id: ID; label: string }[]
  options: PieceOption[]
  autoFocus: boolean
  onFocused: () => void
}

const ORDER_FOCUS = { up: '[data-testid="revision-up"]', down: '[data-testid="revision-down"]' }

const IdeaCard = memo(function IdeaCard({
  idea,
  expanded,
  onToggle,
  first,
  last,
  titleId,
  chips,
  options,
  autoFocus,
  onFocused,
}: IdeaCardProps) {
  const { ref, move } = useKeepInPlace<HTMLLIElement>()
  const heading = idea.heading.trim()
  const badge = sourceLabel(idea.source)
  const bodyId = `sx-ri-${idea.id}`

  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? ORDER_FOCUS.up : ORDER_FOCUS.down
    const other = dir < 0 ? ORDER_FOCUS.down : ORDER_FOCUS.up
    move(() => attempt(() => (actions.moveRevisionIdeaStep(idea.id, dir), true)), [same, other])
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${heading || previewText(idea.body, 20) || '無題の改稿案'}」を削除しますか？`,
      message: trashNotice(),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteRevisionIdea(idea.id), true))) notify('改稿案をゴミ箱に移しました')
  }

  const commit = (patch: Partial<Pick<RevisionIdea, 'heading' | 'body' | 'pieceIds'>>) => {
    const cur = getData().revisionIdeas[idea.id]
    if (!cur) return
    if (patch.heading !== undefined && patch.heading === cur.heading) return
    if (patch.body !== undefined && patch.body === cur.body) return
    attempt(() => actions.updateRevisionIdea(idea.id, patch))
  }

  const linkPiece = (pieceId: string) => {
    if (!pieceId) return
    const cur = getData().revisionIdeas[idea.id]
    if (!cur || cur.pieceIds.includes(pieceId)) return
    attempt(() => actions.updateRevisionIdea(idea.id, { pieceIds: [...cur.pieceIds, pieceId] }))
  }
  const unlinkPiece = (pieceId: string) => {
    const cur = getData().revisionIdeas[idea.id]
    if (!cur) return
    attempt(() => actions.updateRevisionIdea(idea.id, { pieceIds: cur.pieceIds.filter((x) => x !== pieceId) }))
  }

  return (
    <li
      ref={ref}
      className={`sx-card ri-card${idea.checked ? ' is-checked' : ''}${expanded ? ' is-open' : ''}`}
      data-testid="revision-idea"
      data-idea-id={idea.id}
      data-checked={idea.checked}
    >
      <div className="sx-card-head">
        <label className="sx-check" title={idea.checked ? 'チェックを外す（未対応に戻す）' : '実装済み・ボツにする'}>
          <input
            type="checkbox"
            checked={idea.checked}
            onChange={(e) => attempt(() => actions.setRevisionIdeaChecked(idea.id, e.target.checked))}
            aria-label={`「${heading || '無題の改稿案'}」を実装済み・ボツにする`}
            data-testid="revision-check"
          />
        </label>
        <button
          type="button"
          className="sx-card-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          onClick={() => onToggle(idea.id)}
          data-testid="revision-toggle"
        >
          <span className="sx-card-text">
            <span className={`sx-card-name${heading ? '' : ' is-empty'}`} data-testid="revision-heading">
              {heading || '無題の改稿案'}
            </span>
            {!expanded && idea.body.trim() ? <span className="sx-card-preview">{previewText(idea.body)}</span> : null}
          </span>
          <ChevronRightIcon className="icon sx-chevron" />
        </button>
        {!idea.checked ? (
          <span className="sx-order">
            <button
              type="button"
              className="icon-btn"
              onClick={() => step(-1)}
              disabled={first}
              aria-label="1つ上へ"
              title="1つ上へ"
              data-testid="revision-up"
            >
              <ArrowUpIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => step(1)}
              disabled={last}
              aria-label="1つ下へ"
              title="1つ下へ"
              data-testid="revision-down"
            >
              <ArrowDownIcon />
            </button>
          </span>
        ) : null}
      </div>
      {(chips.length || badge || isNewerRecord(idea)) && !expanded ? (
        <div className="sx-card-meta">
          {badge ? (
            <span className="badge cl-badge" data-testid="revision-source">
              <SparkIcon />
              {badge}
            </span>
          ) : null}
          {isNewerRecord(idea) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
          {chips.map((c) => (
            <Link key={c.id} to={paths.piece(titleId, c.id)} className="sx-chip" data-testid="revision-piece-chip">
              {c.label}
            </Link>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="sx-card-body" id={bodyId}>
          <label className="field">
            <span>見出し</span>
            <DraftInput
              key={`${idea.id}:heading`}
              className="input"
              value={idea.heading}
              onCommit={(v) => commit({ heading: v })}
              placeholder="例：第3章の山場を前倒しにする"
              autoFocus={autoFocus}
              onFocus={autoFocus ? onFocused : undefined}
              data-testid="revision-heading-input"
            />
          </label>
          <label className="field">
            <span>中身（長さの制限はありません。場面を丸ごと書いても構いません）</span>
            <GrowTextarea
              key={`${idea.id}:body`}
              className="textarea sx-body-input"
              rows={4}
              value={idea.body}
              onCommit={(v) => commit({ body: v })}
              placeholder="何をどう変えるか、理由、書き直した場面など"
              data-testid="revision-body-input"
            />
          </label>
          <div className="field">
            <span>関係する話</span>
            <div className="sx-chips">
              {chips.map((c) => (
                <span key={c.id} className="sx-chip-edit">
                  <Link to={paths.piece(titleId, c.id)} className="sx-chip" data-testid="revision-piece-chip">
                    {c.label}
                  </Link>
                  <button
                    type="button"
                    className="icon-btn sm"
                    onClick={() => unlinkPiece(c.id)}
                    aria-label={`${c.label}を外す`}
                    title="外す"
                    data-testid="revision-piece-remove"
                  >
                    <XIcon />
                  </button>
                </span>
              ))}
              {options.length ? (
                <select
                  className="select sx-piece-select"
                  value=""
                  onChange={(e) => linkPiece(e.target.value)}
                  aria-label="関係する話を足す"
                  data-testid="revision-piece-add"
                >
                  <option value="">＋ 話を足す…</option>
                  {options
                    .filter((o) => !idea.pieceIds.includes(o.id))
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                </select>
              ) : null}
            </div>
          </div>
          <div className="sx-card-actions">
            {badge ? (
              <span className="badge cl-badge">
                <SparkIcon />
                {badge}
              </span>
            ) : null}
            <span className="grow" />
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()} data-testid="revision-delete">
              <TrashIcon />
              削除
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
})
