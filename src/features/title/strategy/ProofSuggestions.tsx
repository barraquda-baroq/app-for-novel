// 戦略タブの推敲案: Claude のワードサーチなどの提案。フラグを立てたものが一番上、次に新しい順。チェックしたものは
// 斜線＋グレーで下へ沈む（並びは src/claude/order.ts）。種類のチップ、「抜き出した箇所」→ 直し方・理由、場所「第12話 第2幕 ¶14」。
// 押すと話・幕を開いて、その箇所を選ぶ（本文が変わっていれば探し直す。見つからなければ「本文が変わりました（直した可能性）」）。
// 種類・状態・実行で絞り込め、実行の一覧と確かめた範囲（「未確認 #41〜#300、本文が変わった話 #12」）、「チェック済みを削除」もある。
import { memo, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PROOF_CATEGORIES, PROOF_CATEGORY_LABELS, proofCategoryLabel } from '../../../claude/categories'
import { proofCoverage, proofRunsOf, proofSuggestionsOf } from '../../../claude/order'
import { readingOrder } from '../../../claude/refs'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../../claude/visibility'
import { episodeNumbers } from '../../../domain/structure'
import { trashNotice } from '../../../domain/trash'
import type { ID, ProofCategory, ProofSuggestion } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { EditIcon, MoreIcon, PlusIcon, TrashIcon } from '../../../ui/icons'
import { Modal } from '../../../ui/Modal'
import { PopupMenu } from '../../../ui/PopupMenu'
import { FlagIcon, SparkIcon } from '../../claude/claudeIcons'
import { sourceLabel } from '../../claude/claudeUi'
import {
  categoriesIn,
  DEFAULT_PROOF_FILTER,
  filterProofSuggestions,
  LOST_LABEL,
  MANUAL_RUN,
  MISSING_LABEL,
  proofPlace,
  runLine,
  type ProofFilter,
  type ProofPlace,
  type ProofStatusFilter,
} from './proofLogic'

/** 一度に出す件数（多い時は「さらに表示」） */
const PAGE = 50
/** 実行の一覧に出す数 */
const RUNS_SHOWN = 3

const STATUS_OPTIONS: { value: ProofStatusFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'open', label: '未チェック' },
  { value: 'done', label: 'チェック済み' },
]

export interface ProofSuggestionsProps {
  titleId: ID
  headingId: string
  today: string
  /** 「Claude に頼む（手動）」「結果を貼り付け」 */
  actionsSlot?: React.ReactNode
}

export function ProofSuggestions({ titleId, headingId, today, actionsSlot }: ProofSuggestionsProps) {
  const data = useData()
  const navigate = useNavigate()
  // 同じ時に作った案は読む順に並べるので、話の並び（タイトル・章・話）が変わった時も並べ直す
  const all = useMemo(
    () => proofSuggestionsOf(data, titleId),
    [data.proofSuggestions, data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const runs = useMemo(
    () => proofRunsOf(data, titleId),
    [data.proofBatches, data.proofSuggestions, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const hasBatches = runs.length > 0
  // 確かめた範囲は、実行の記録があり、原稿か記録が変わった時だけ数え直す
  const coverage = useMemo(
    () => (hasBatches ? proofCoverage(data, titleId) : null),
    [hasBatches, data.proofBatches, data.titles, data.chapters, data.pieces, data.versions, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const numbers = useMemo(
    () => episodeNumbers(data, titleId),
    [data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [filter, setFilter] = useState<ProofFilter>(DEFAULT_PROOF_FILTER)
  const [limit, setLimit] = useState(PAGE)
  const [showAllRuns, setShowAllRuns] = useState(false)
  const [editing, setEditing] = useState<ID | null>(null)
  const [adding, setAdding] = useState(false)
  const shown = useMemo(() => filterProofSuggestions(all, filter), [all, filter])
  const visible = useMemo(() => shown.slice(0, limit), [shown, limit])
  const categories = useMemo(() => categoriesIn(all), [all])
  const hasManual = all.some((s) => s.runId === null)
  const openCount = all.filter((s) => !s.done).length
  const doneShown = shown.filter((s) => s.done)
  // 見えている推敲案の場所だけを探す（本文が変わっていれば探し直す）
  const places = useMemo(() => {
    const d = getData()
    return new Map(visible.map((s) => [s.id, proofPlace(d, s, numbers)]))
  }, [visible, numbers, data.pieces, data.versions]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<ProofFilter>) => {
    setFilter((f) => ({ ...f, ...patch }))
    setLimit(PAGE)
  }

  const jump = (s: ProofSuggestion, place: ProofPlace) => {
    if (!place.pieceId) return
    navigate(paths.pieceProof(titleId, place.pieceId, s.id))
  }

  const removeChecked = async () => {
    const ids = doneShown.map((s) => s.id)
    if (!ids.length) return
    const ok = await confirmDialog({
      title: `チェック済みの推敲案 ${ids.length}件を削除しますか？`,
      message: trashNotice('まとめて1件として'),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteCheckedProofSuggestions(titleId, ids), true)))
      notify(`チェック済みの推敲案 ${ids.length}件をゴミ箱に移しました`)
  }

  const runsShown = showAllRuns ? runs : runs.slice(0, RUNS_SHOWN)
  const editTarget = editing ? data.proofSuggestions[editing] : undefined

  return (
    <section className="sx-section" aria-labelledby={headingId} id="sx-proof" data-testid="proof-suggestions">
      <div className="sx-head">
        <div className="sx-title">
          <h2 id={headingId}>
            推敲案<span className="sx-count">{openCount}</span>
          </h2>
          <p className="small muted">
            フラグを立てたものが一番上、次に新しい順。直したらチェックで消し込み、押すと本文のその箇所を開きます。
          </p>
        </div>
        <span className="grow" />
        {actionsSlot}
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)} data-testid="proof-add">
          <PlusIcon />
          推敲案を足す
        </button>
      </div>

      {runs.length || coverage?.text ? (
        <div className="ps-runs" data-testid="proof-runs">
          {runs.length ? (
            <p className="ps-runs-line">
              <span className="ps-runs-label">実行</span>
              {runsShown.map((r, i) => (
                <span key={r.runId} className="ps-run" data-testid="proof-run">
                  {i > 0 ? '・' : ''}
                  {runLine(r, today)}
                </span>
              ))}
              {runs.length > RUNS_SHOWN ? (
                <button
                  type="button"
                  className="ps-runs-more"
                  onClick={() => setShowAllRuns((v) => !v)}
                  data-testid="proof-runs-more"
                >
                  {showAllRuns ? '閉じる' : `ほか ${runs.length - RUNS_SHOWN}回`}
                </button>
              ) : null}
            </p>
          ) : null}
          {coverage?.text ? (
            <p className="ps-runs-line" data-testid="proof-coverage">
              <span className="ps-runs-label">確かめた範囲</span>
              {coverage.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {all.length === 0 ? (
        <div className="empty sx-empty" data-testid="proof-empty">
          <p>まだ推敲案がありません。</p>
          <p className="small">
            Claude のコネクタか「Claude
            に頼む（手動）」で、作者の癖・既成表現・誤字脱字・ら抜き・い抜きなどを洗い出してもらえます。
          </p>
        </div>
      ) : (
        <>
          <div className="ps-filters" role="group" aria-label="推敲案の絞り込み">
            <div className="segmented ps-status" role="group" aria-label="状態">
              {STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={filter.status === o.value}
                  onClick={() => set({ status: o.value })}
                  data-testid={`proof-status-${o.value}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              className="select ps-select"
              value={filter.category}
              onChange={(e) => set({ category: e.target.value })}
              aria-label="種類"
              data-testid="proof-category-filter"
            >
              <option value="">すべての種類</option>
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}（{c.count}）
                </option>
              ))}
            </select>
            {runs.length > 1 || (runs.length && hasManual) ? (
              <select
                className="select ps-select"
                value={filter.runId}
                onChange={(e) => set({ runId: e.target.value })}
                aria-label="実行"
                data-testid="proof-run-filter"
              >
                <option value="">すべての実行</option>
                {runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {runLine(r, today)}
                  </option>
                ))}
                {hasManual ? <option value={MANUAL_RUN}>手で追加したもの</option> : null}
              </select>
            ) : null}
            <span className="grow" />
            {doneShown.length ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void removeChecked()}
                data-testid="proof-delete-checked"
              >
                <TrashIcon />
                チェック済みを削除（{doneShown.length}）
              </button>
            ) : null}
          </div>

          {shown.length === 0 ? (
            <p className="small muted ps-none" data-testid="proof-filter-empty">
              この条件の推敲案はありません。
            </p>
          ) : (
            <ul className="ps-list" data-testid="proof-list">
              {visible.map((s) => (
                <ProofItem key={s.id} s={s} place={places.get(s.id)!} onJump={jump} onEdit={setEditing} />
              ))}
            </ul>
          )}
          {shown.length > visible.length ? (
            <button type="button" className="btn ps-more" onClick={() => setLimit((n) => n + PAGE)} data-testid="proof-more">
              さらに表示（残り {shown.length - visible.length}件）
            </button>
          ) : null}
        </>
      )}
      {editTarget ? <ProofEditDialog s={editTarget} onClose={() => setEditing(null)} /> : null}
      {adding ? <ProofAddDialog titleId={titleId} onClose={() => setAdding(false)} /> : null}
    </section>
  )
}

export interface ProofItemProps {
  s: ProofSuggestion
  place: ProofPlace
  onJump: (s: ProofSuggestion, place: ProofPlace) => void
  onEdit?: (id: ID) => void
  /** 原稿画面の一覧（場所は出さず、押すと本文の中で選ぶ） */
  compact?: boolean
  /** 原稿画面の一覧で、いま選んでいる推敲案 */
  selected?: boolean
}

/** 推敲案の1行（戦略タブと原稿画面の一覧で使う） */
export const ProofItem = memo(function ProofItem({ s, place, onJump, onEdit, compact, selected }: ProofItemProps) {
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const category = proofCategoryLabel(s.category, s.categoryLabel)
  const badge = sourceLabel(s.source)
  const remove = async () => {
    const ok = await confirmDialog({
      title: '推敲案を削除しますか？',
      message: trashNotice(),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok) attempt(() => actions.deleteProofSuggestion(s.id))
  }
  const where =
    place.state === 'found'
      ? place.label
      : place.state === 'lost'
        ? `${place.label}・${LOST_LABEL}`
        : `${place.label}・${MISSING_LABEL}`
  return (
    <li
      className={`ps-item${s.done ? ' is-done' : ''}${s.flagged ? ' is-flagged' : ''}${place.state !== 'found' ? ' is-lost' : ''}${selected ? ' is-selected' : ''}`}
      data-testid="proof-item"
      data-proof-id={s.id}
      data-done={s.done}
      data-flagged={s.flagged}
    >
      <label className="sx-check" title={s.done ? 'チェックを外す' : '直した・見送ったらチェック'}>
        <input
          type="checkbox"
          checked={s.done}
          onChange={(e) => attempt(() => actions.setProofDone(s.id, e.target.checked))}
          aria-label={`推敲案「${s.excerpt}」をチェック`}
          data-testid="proof-check"
        />
      </label>
      <div className="ps-main">
        <div className="ps-top">
          <span className={`badge ps-cat is-${s.category}`} data-testid="proof-category">
            {category}
          </span>
          {!compact || place.state !== 'found' ? (
            <span className={`ps-loc${place.state === 'found' ? '' : ' is-lost'}`} data-testid="proof-location">
              {where}
            </span>
          ) : (
            <span className="ps-loc" data-testid="proof-location">
              ¶{place.result.status !== 'lost' ? place.result.paragraph : ''}
            </span>
          )}
          {badge && !compact ? (
            <span className="ps-source" title={badge}>
              <SparkIcon />
              <span className="visually-hidden">{badge}</span>
            </span>
          ) : null}
          {isNewerRecord(s) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
        </div>
        <button
          type="button"
          className="ps-text"
          onClick={() => onJump(s, place)}
          disabled={!place.pieceId}
          title={place.pieceId ? '本文のこの箇所を開く' : MISSING_LABEL}
          data-testid="proof-jump"
        >
          <span className="ps-excerpt">「{s.excerpt}」</span>
          {s.suggestion.trim() ? (
            <>
              <span className="ps-arrow" aria-hidden="true">
                →
              </span>
              <span className="visually-hidden">の直し方: </span>
              <span className="ps-suggestion">{s.suggestion}</span>
            </>
          ) : null}
        </button>
        {s.reason.trim() ? <p className="ps-reason">{s.reason}</p> : null}
      </div>
      <div className="ps-side">
        <button
          type="button"
          className={`icon-btn ps-flag${s.flagged ? ' is-on' : ''}`}
          aria-pressed={s.flagged}
          aria-label={s.flagged ? 'フラグを外す' : 'フラグを立てる（一番上に出す）'}
          title={s.flagged ? 'フラグを外す' : 'フラグを立てる（一番上に出す）'}
          onClick={() => attempt(() => actions.setProofFlagged(s.id, !s.flagged))}
          data-testid="proof-flag"
        >
          <FlagIcon filled={s.flagged} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label="推敲案の操作"
          title="推敲案の操作"
          onClick={(e) => {
            const el = e.currentTarget
            setMenu((m) => (m ? null : el))
          }}
          data-testid="proof-more-button"
        >
          <MoreIcon />
        </button>
      </div>
      {menu ? (
        <PopupMenu
          label="推敲案の操作"
          placement={{ anchor: menu }}
          returnFocus={menu}
          onClose={() => setMenu(null)}
          items={[
            ...(onEdit ? [{ label: '書き直す', icon: <EditIcon />, onSelect: () => onEdit(s.id), testId: 'proof-edit' }] : []),
            { label: '削除', icon: <TrashIcon />, danger: true, onSelect: () => void remove(), testId: 'proof-delete' },
          ]}
        />
      ) : null}
    </li>
  )
})

/** 推敲案を書き直す（直し方・理由・種類） */
function ProofEditDialog({ s, onClose }: { s: ProofSuggestion; onClose: () => void }) {
  const [suggestion, setSuggestion] = useState(s.suggestion)
  const [reason, setReason] = useState(s.reason)
  const [category, setCategory] = useState<string>(s.category)
  const save = () => {
    const patch: Parameters<typeof actions.updateProofSuggestion>[1] = { suggestion, reason }
    if (category !== s.category) patch.category = category as ProofCategory
    if (attempt(() => (actions.updateProofSuggestion(s.id, patch), true))) onClose()
  }
  return (
    <Modal
      title="推敲案を書き直す"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid="proof-edit-save">
            保存
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="ps-edit-excerpt">「{s.excerpt}」</p>
        <label className="field">
          <span>種類</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {PROOF_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PROOF_CATEGORY_LABELS[c]}
              </option>
            ))}
            {!(PROOF_CATEGORIES as readonly string[]).includes(s.category) ? (
              <option value={s.category}>{proofCategoryLabel(s.category, s.categoryLabel)}</option>
            ) : null}
          </select>
        </label>
        <label className="field">
          <span>直し方の案</span>
          <textarea
            className="textarea"
            rows={2}
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            data-testid="proof-edit-suggestion"
          />
        </label>
        <label className="field">
          <span>理由</span>
          <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  )
}

/** 推敲案を手で足す（話・抜き出し・直し方・理由・種類・フラグ）。抜き出しが採用原稿に1か所だけあれば場所を控える */
function ProofAddDialog({ titleId, onClose }: { titleId: ID; onClose: () => void }) {
  const data = useData()
  const options = useMemo(
    () => readingOrder(data, titleId).map((o) => ({ id: o.piece.id, label: `#${o.index} ${o.fullLabel}` })),
    [data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [pieceId, setPieceId] = useState<ID>(options[0]?.id ?? '')
  const [excerpt, setExcerpt] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [reason, setReason] = useState('')
  const [category, setCategory] = useState<ProofCategory>('other')
  const [flagged, setFlagged] = useState(false)
  const save = () => {
    if (!pieceId) return
    const id = attempt(() =>
      actions.addProofSuggestion(titleId, { pieceId, excerpt: excerpt.trim(), suggestion, reason, category, flagged }),
    )
    if (!id) return
    const s = getData().proofSuggestions[id]
    notify(s?.anchor ? '推敲案を足しました' : '推敲案を足しました（本文の中の場所は見つかりませんでした）')
    onClose()
  }
  return (
    <Modal
      title="推敲案を足す"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={!pieceId || !excerpt.trim()}
            data-testid="proof-add-save"
          >
            追加
          </button>
        </>
      }
    >
      <div className="stack" data-testid="proof-add-dialog">
        {options.length === 0 ? <p className="small muted">話がまだありません。</p> : null}
        <label className="field">
          <span>話</span>
          <select className="select" value={pieceId} onChange={(e) => setPieceId(e.target.value)} data-testid="proof-add-piece">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>抜き出し（本文のとおりに）</span>
          <input className="input" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} data-testid="proof-add-excerpt" />
        </label>
        <label className="field">
          <span>直し方の案</span>
          <textarea
            className="textarea"
            rows={2}
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            data-testid="proof-add-suggestion"
          />
        </label>
        <label className="field">
          <span>理由</span>
          <textarea
            className="textarea"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="proof-add-reason"
          />
        </label>
        <label className="field">
          <span>種類</span>
          <select
            className="select"
            value={category}
            onChange={(e) => setCategory(e.target.value as ProofCategory)}
            data-testid="proof-add-category"
          >
            {PROOF_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PROOF_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} data-testid="proof-add-flag" />
          <span>フラグを立てる（いつも一番上に）</span>
        </label>
      </div>
    </Modal>
  )
}
