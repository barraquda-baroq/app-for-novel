// 戦略タブの改稿案: 案ごとのチェックボックス（実装済み・ボツでチェックすると斜線＋グレーで下へ沈む）。文字数の制限はない
// （ワンシーン丸ごとの案もある）。手で足す・書き直す・並べ替える（チェックしていない案だけ）・削除（ゴミ箱）、関係する話のチップから話を開く。
// 開いた案は中身を Markdown で表示し（長ければ頭だけ。「全文を表示」）、［直す］で見出し・中身・関係する話の入力欄にする
// （［閉じる］で表示に戻る。入力はフォーカスを外した時に保存）。新しく足した案は入力欄で開く。
// Claude（コネクタ・手動連携の貼り付け）が足した案も、ふつうの案として扱う。
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { ChevronRightIcon, EditIcon, PlusIcon, TrashIcon, XIcon } from '../../../ui/icons'
import { scrollByInstant, useKeepInPlace } from '../../../ui/keepInPlace'
import { SparkIcon } from '../../claude/claudeIcons'
import { sourceLabel } from '../../claude/claudeUi'
import { Markdown } from '../../claude/Markdown'
import { GrowTextarea } from '../settings/GrowTextarea'
import { linkedPieces, markdownPreview } from './proofLogic'
import { ArrowDownIcon, ArrowUpIcon } from './strategyIcons'

/** 開いた案で、これより長ければ頭だけを出して「全文を表示」（閉じている間は頭だけを変換する。Markdown.tsx） */
const LONG_IDEA = 600

interface PieceOption {
  id: ID
  label: string
}

interface PieceChip {
  id: ID
  label: string
}

/** id を足した（外した）集合。変わらなければ元のまま（描き直さない） */
function withId(set: ReadonlySet<ID>, id: ID, on: boolean): ReadonlySet<ID> {
  if (set.has(id) === on) return set
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
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
  /** 入力欄を出している（直している）案。開いた案は、ふだんは表示（Markdown） */
  const [editing, setEditing] = useState<ReadonlySet<ID>>(() => new Set())
  const [focusId, setFocusId] = useState<ID | null>(null)
  const open = ideas.filter((i) => !i.checked)
  const checkedCount = ideas.length - open.length

  const toggle = useCallback((id: ID) => {
    setExpanded((prev) => withId(prev, id, !prev.has(id)))
    // 閉じた案は、次に開いた時は表示から
    setEditing((prev) => withId(prev, id, false))
  }, [])
  const setEdit = useCallback((id: ID, on: boolean) => setEditing((prev) => withId(prev, id, on)), [])
  const focused = useCallback(() => setFocusId(null), [])

  const add = () => {
    const id = attempt(() => actions.addRevisionIdea(titleId))
    if (!id) return
    // 新しい案は入力欄で開き、見出しから書く
    setExpanded((prev) => withId(prev, id, true))
    setEditing((prev) => withId(prev, id, true))
    setFocusId(id)
  }

  return (
    <section className="sx-section" aria-labelledby={headingId} id="sx-revision" data-testid="revision-ideas">
      <div className="sx-head">
        <div className="sx-title">
          <h2 id={headingId}>
            改稿案<span className="sx-count">{open.length}</span>
          </h2>
          <p className="small muted">
            開くと中身を表示し、［直す］で書き直せます。実装した・ボツにした案はチェックすると、斜線とグレーで下へ沈みます。
          </p>
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
                editing={editing.has(idea.id)}
                onToggle={toggle}
                onEdit={setEdit}
                first={openIndex === 0}
                last={openIndex === open.length - 1}
                titleId={titleId}
                chips={linkedPieces(data, titleId, idea.pieceIds, numbers)}
                options={options}
                autoFocus={focusId === idea.id}
                onFocused={focused}
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
  /** 入力欄を出している（false なら、開いた時は中身を Markdown で表示する） */
  editing: boolean
  onToggle: (id: ID) => void
  onEdit: (id: ID, on: boolean) => void
  first: boolean
  last: boolean
  titleId: ID
  chips: PieceChip[]
  options: PieceOption[]
  autoFocus: boolean
  onFocused: () => void
}

const ORDER_FOCUS = { up: '[data-testid="revision-up"]', down: '[data-testid="revision-down"]' }

function IdeaCardView({
  idea,
  expanded,
  editing,
  onToggle,
  onEdit,
  first,
  last,
  titleId,
  chips,
  options,
  autoFocus,
  onFocused,
}: IdeaCardProps) {
  const { ref, move } = useKeepInPlace<HTMLLIElement>()
  const [full, setFull] = useState(false)
  // ［閉じる］・［折りたたむ］で中身が短くなる時は、下のボタンの列が画面の同じ位置に残るようにスクロールを直す
  // （長い入力欄・全文が縮むと、スクロールの位置を合わせないブラウザ（Safari・iPhone のアプリ）では、押したボタンも
  // この案も画面の外へ行き、後ろの案が見えてしまう）。長くなる側（直す・全文を表示）は、ボタンが下へ動くだけなので直さない
  const actionsRef = useRef<HTMLDivElement>(null)
  const keepTop = useRef<number | null>(null)
  useLayoutEffect(() => {
    const top = keepTop.current
    keepTop.current = null
    const el = actionsRef.current
    if (top === null || !el) return
    const dy = el.getBoundingClientRect().top - top
    if (Math.abs(dy) >= 1) scrollByInstant(dy)
  })
  const keep = (run: () => void) => {
    keepTop.current = actionsRef.current?.getBoundingClientRect().top ?? null
    run()
  }
  const heading = idea.heading.trim()
  const badge = sourceLabel(idea.source)
  const bodyId = `sx-ri-${idea.id}`
  const long = idea.body.length > LONG_IDEA
  const newer = isNewerRecord(idea)
  // Claude の札・関係する話のチップ（閉じている時は見出しの下、表示で開いた時は中身の上）
  const meta =
    chips.length || badge || newer ? (
      <>
        {badge ? (
          <span className="badge cl-badge" data-testid="revision-source">
            <SparkIcon />
            {badge}
          </span>
        ) : null}
        {newer ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
        {chips.map((c) => (
          <Link key={c.id} to={paths.piece(titleId, c.id)} className="sx-chip" data-testid="revision-piece-chip">
            {c.label}
          </Link>
        ))}
      </>
    ) : null

  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? ORDER_FOCUS.up : ORDER_FOCUS.down
    const other = dir < 0 ? ORDER_FOCUS.down : ORDER_FOCUS.up
    move(() => attempt(() => (actions.moveRevisionIdeaStep(idea.id, dir), true)), [same, other])
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${heading || markdownPreview(idea.body, 20) || '無題の改稿案'}」を削除しますか？`,
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
            {!expanded && idea.body.trim() ? (
              <span className="sx-card-preview" data-testid="revision-preview">
                {markdownPreview(idea.body)}
              </span>
            ) : null}
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
      {meta && !expanded ? <div className="sx-card-meta">{meta}</div> : null}
      {expanded ? (
        <div className="sx-card-body" id={bodyId}>
          {editing ? (
            <>
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
                <span>中身（Markdown。長さの制限はありません。場面を丸ごと書いても構いません）</span>
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
            </>
          ) : (
            <>
              {meta ? <div className="sx-chips">{meta}</div> : null}
              {idea.body.trim() ? (
                <>
                  <div className={`ri-body${long && !full ? ' is-clamped' : ''}`}>
                    <Markdown text={idea.body} preview={long && !full} testId="revision-body" />
                  </div>
                  {long ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm sn-more"
                      aria-expanded={full}
                      onClick={() => (full ? keep(() => setFull(false)) : setFull(true))}
                      data-testid="revision-more"
                    >
                      <ChevronRightIcon className="icon sx-chevron" />
                      {full ? '折りたたむ' : '全文を表示'}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="small muted" data-testid="revision-body-empty">
                  （中身がありません）
                </p>
              )}
            </>
          )}
          <div className="sx-card-actions" ref={actionsRef}>
            {/* 直す ⇔ 閉じる（同じ場所のボタン。押したあともフォーカスはここに残る） */}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => (editing ? keep(() => onEdit(idea.id, false)) : onEdit(idea.id, true))}
              data-testid={editing ? 'revision-edit-done' : 'revision-edit'}
            >
              {editing ? (
                '閉じる'
              ) : (
                <>
                  <EditIcon />
                  直す
                </>
              )}
            </button>
            {editing && badge ? (
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
}

const sameChips = (a: readonly PieceChip[], b: readonly PieceChip[]) =>
  a === b || (a.length === b.length && a.every((c, i) => c.id === b[i].id && c.label === b[i].label))

/** 話のチップは中身で比べ、ほかの値はそのまま比べる（変わった案だけを描き直す） */
function sameCardProps(a: IdeaCardProps, b: IdeaCardProps): boolean {
  const { chips: ca, ...restA } = a
  const { chips: cb, ...restB } = b
  return sameChips(ca, cb) && (Object.keys(restA) as (keyof typeof restA)[]).every((k) => Object.is(restA[k], restB[k]))
}

const IdeaCard = memo(IdeaCardView, sameCardProps)
