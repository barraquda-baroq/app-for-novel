// 応募計画1件のカード。見出し行に応募順・コンテスト名・状態と、状態に応じた情報
// （応募前: 締切・規定の判定／結果待ち: 応募日・結果発表まで／終了: 結果・改稿方針・再応募方針の抜粋）、開くと詳細を編集できる。
import { memo, useId, useMemo, useRef, useState } from 'react'
import {
  SUBMISSION_STATUSES,
  snapshotPieceBody,
  snapshotText,
  submissionsOf,
  submissionStatusLabel,
  type SubmissionPatch,
} from '../../../domain/entityOps'
import { formatCount } from '../../../domain/text'
import { trashNotice } from '../../../domain/trash'
import type { ID, LimitUnit, SnapshotPiece, Submission, SubmissionSnapshot, SubmissionStatus } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { downloadFile, formatDateTime, safeFileName } from '../../../ui/browser'
import { confirmDialog } from '../../../ui/dialogs'
import { DraftInput } from '../../../ui/DraftField'
import { BookIcon, CameraIcon, ChevronRightIcon, DownloadIcon, LinkIcon, TrashIcon } from '../../../ui/icons'
import { useKeepInPlace } from '../../../ui/keepInPlace'
import { Modal } from '../../../ui/Modal'
import { NearViewportContext, useNearViewportWatcher } from '../../../ui/nearViewport'
import { LazyRubyText } from '../../../ui/RubyText'
import { lineShape, lineShapeOf, lineShapeStyle, useCharsPerLine } from '../../read/lineEstimate'
import { GrowTextarea } from '../settings/GrowTextarea'
import { ArrowDownIcon, ArrowUpIcon } from './strategyIcons'
import {
  deadlineInfo,
  followUpLines,
  formatAmount,
  formatYmd,
  isBeforeSubmission,
  isHttpUrl,
  limitBadgeText,
  limitBasis,
  limitCheck,
  limitRange,
  limitTense,
  limitUnitOf,
  manuscriptSummary,
  parseLimit,
  pieceCountLabel,
  resultInfo,
  SNAPSHOT_CHANGE_LABEL,
  snapshotChangeSummary,
  snapshotPages,
  snapshotView,
  statusPhase,
  statusTone,
  toYmd,
  unitSuffix,
  type CurrentManuscript,
  type LimitCheck,
} from './strategyLogic'

/** 削除後に届いた下書きの保存や、値が変わらない保存は何もしない */
export function commitSubmission(id: string, patch: SubmissionPatch): void {
  const s = getData().submissions[id]
  if (!s) return
  const changed = (Object.keys(patch) as (keyof SubmissionPatch)[]).some((k) => patch[k] !== s[k])
  if (!changed) return
  attempt(() => actions.updateSubmission(id, patch))
}

export function contestDisplayName(name: string): string {
  return name.trim() || '（コンテスト名未設定）'
}

/** 規定は入力の途中で判定しないよう、確定（Enter・フォーカスを外す）した時だけ保存する */
const LIMIT_COMMIT_DELAY = 10 * 60 * 1000

const LIMIT_BADGE: Record<LimitCheck['state'], string> = {
  ok: 'badge-active',
  short: 'badge-missing',
  over: 'badge-danger',
}

const UNIT_HINT: Record<LimitUnit, string> = {
  chars: '空白・改行を除いた文字数',
  pages: '400字詰め原稿用紙換算の枚数',
}

/** 現在の採用原稿の量（規定との比較用） */
export interface CurrentAmount {
  chars: number
  pages: number
}

export interface SubmissionCardProps {
  submission: Submission
  /** 応募順（1始まり） */
  position: number
  /** 応募先の数 */
  count: number
  /** 締切順で表示している間は並べ替えボタンを出さない */
  canReorder: boolean
  expanded: boolean
  onToggle: (id: ID) => void
  /** 現在の採用原稿の総文字数・原稿用紙換算枚数 */
  current: CurrentAmount
  /** 現在の採用原稿の状態（応募時の原稿との比較用。原稿が変わった時だけ作り直される） */
  manuscript: CurrentManuscript
  titleName: string
  today: Date
}

/** 並べ替えのボタン（見出し: デスクトップ、詳細: スマホ）。押した後も同じボタンにフォーカスを残す */
const ORDER_FOCUS = {
  head: { up: '[data-testid="submission-up"]', down: '[data-testid="submission-down"]' },
  editor: { up: '[data-testid="submission-order-up"]', down: '[data-testid="submission-order-down"]' },
}

/** カードは自分の内容・開閉・原稿の状態が変わった時だけ描き直す（全体戦略などの入力では描き直さない） */
export const SubmissionCard = memo(function SubmissionCard({
  submission: s,
  position,
  count,
  canReorder,
  expanded,
  onToggle,
  current,
  manuscript,
  titleName,
  today,
}: SubmissionCardProps) {
  const tone = statusTone(s.status)
  const phase = statusPhase(s.status)
  const unit = limitUnitOf(s)
  // 応募前: 締切と現在の原稿の規定判定／結果待ち: 応募日・結果発表と応募時の原稿の規定判定／終了: 注意は出さない
  const deadline = phase === 'before' ? deadlineInfo(s, today) : null
  const result = phase === 'waiting' ? resultInfo(s.resultOn, today) : null
  const submittedOn = phase === 'waiting' ? formatYmd(s.submittedOn) : ''
  const basis = phase === 'finished' ? null : limitBasis(s, current)
  const check = basis ? limitCheck(basis.amount, s.minChars, s.maxChars, unit, limitTense(s.status)) : null
  const followUps = phase === 'finished' && !expanded ? followUpLines(s) : null
  const followUpsEmpty = followUps !== null && followUps.every((f) => !f.text)
  const name = contestDisplayName(s.contestName)
  const bodyId = `sg-sub-${s.id}`
  const isFirst = position === 1
  const isLast = position === count
  const { ref, move } = useKeepInPlace<HTMLLIElement>()

  // 動かしたカードが押した指の下に残るようにし（続けて押すとそのまま動かし続けられる）、新しい応募順を知らせる
  const step = (dir: -1 | 1, where: keyof typeof ORDER_FOCUS) => {
    const same = dir < 0 ? ORDER_FOCUS[where].up : ORDER_FOCUS[where].down
    const other = dir < 0 ? ORDER_FOCUS[where].down : ORDER_FOCUS[where].up
    move(() => {
      if (!attempt(() => (actions.moveSubmissionStep(s.id, dir), true))) return false
      const n = submissionsOf(getData(), s.titleId).findIndex((x) => x.id === s.id) + 1
      if (n > 0) notify(`応募順を変更しました（${n}番目）`)
      return true
    }, [same, other])
  }

  return (
    <li
      ref={ref}
      className={`sg-card is-${tone}${expanded ? ' is-open' : ''}`}
      data-testid="submission-card"
      data-submission-id={s.id}
      data-status={s.status}
    >
      <div className="sg-card-head">
        <span className="sg-num" title={`応募順 ${position}`} data-testid="submission-number">
          <span className="visually-hidden">応募順 </span>
          {position}
        </span>
        <button
          type="button"
          className="sg-card-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          onClick={() => onToggle(s.id)}
          data-testid="submission-toggle"
        >
          <span className="sg-card-text">
            <span className="sg-card-name-row">
              <span className={`sg-card-name${s.contestName.trim() ? '' : ' is-empty'}`} data-testid="submission-name">
                {name}
              </span>
              {s.organizer.trim() ? <span className="sg-card-org">{s.organizer.trim()}</span> : null}
            </span>
            <span className="sg-card-meta">
              <span className={`badge sg-status is-${tone}`} data-testid="submission-status">
                {submissionStatusLabel(s.status)}
              </span>
              {s.stage.trim() ? <span className="sg-stage">{s.stage.trim()}</span> : null}
              {deadline ? (
                <span className={`sg-deadline is-${deadline.tone}`} data-testid="submission-deadline">
                  {deadline.text}
                </span>
              ) : null}
              {submittedOn ? (
                <span className="sg-deadline" data-testid="submission-submitted-on">
                  応募日 {submittedOn}
                </span>
              ) : null}
              {result ? (
                <span className={`sg-deadline is-${result.tone}`} data-testid="submission-result-on">
                  {result.text}
                </span>
              ) : null}
              {check && basis ? (
                <span
                  className={`badge ${LIMIT_BADGE[check.state]}`}
                  data-testid="submission-limit"
                  title={`規定 ${limitRange(s.minChars, s.maxChars, unit)}（${basis.source === 'snapshot' ? '応募時の原稿' : '現在の採用原稿'} ${formatAmount(basis.amount, unit)}）`}
                >
                  {limitBadgeText(check, basis.source)}
                </span>
              ) : null}
            </span>
            {followUps && !followUpsEmpty ? (
              <span className="sg-followups" data-testid="submission-followups">
                {followUps.map((f) => (
                  <span key={f.field} className={`sg-followup${f.text ? '' : ' is-empty'}`} data-testid="submission-followup">
                    <span className="sg-followup-label">{f.label}</span>
                    <span className="sg-followup-text">{f.text || '未記入'}</span>
                  </span>
                ))}
              </span>
            ) : null}
            {followUpsEmpty && s.status !== 'withdrawn' ? (
              <span className="sg-followups" data-testid="submission-followups">
                <span className="sg-followup is-empty">
                  <span className="sg-followup-text">結果・講評／改稿方針／再応募方針は未記入</span>
                </span>
              </span>
            ) : null}
          </span>
          <ChevronRightIcon className="icon sg-card-chevron" />
        </button>
        {canReorder && count > 1 ? (
          // スマホでは見出しに出さない（開閉の矢印と紛れて、知らないうちに応募順を変えてしまうため）。詳細の中で並べ替える
          <div className="sg-card-order" role="group" aria-label="応募順の並べ替え">
            <button
              type="button"
              className="icon-btn"
              disabled={isFirst}
              onClick={() => step(-1, 'head')}
              aria-label="応募順を上げる"
              title="応募順を1つ前へ"
              data-testid="submission-up"
            >
              <ArrowUpIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={isLast}
              onClick={() => step(1, 'head')}
              aria-label="応募順を下げる"
              title="応募順を1つ後へ"
              data-testid="submission-down"
            >
              <ArrowDownIcon />
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <SubmissionEditor
          id={bodyId}
          submission={s}
          current={current}
          manuscript={manuscript}
          titleName={titleName}
          onClose={() => onToggle(s.id)}
          order={
            canReorder && count > 1 ? { position, count, onUp: () => step(-1, 'editor'), onDown: () => step(1, 'editor') } : null
          }
        />
      ) : null}
    </li>
  )
})

/** 詳細の中の並べ替え（スマホ用）。何番目かと、矢印に言葉を添えたボタン */
function OrderRow({ position, count, onUp, onDown }: { position: number; count: number; onUp: () => void; onDown: () => void }) {
  return (
    <div
      className="sg-order-row show-mobile"
      role="group"
      aria-label={`応募順の並べ替え（${count}件中${position}番目）`}
      data-testid="submission-order"
    >
      <span className="sg-order-label" aria-hidden="true">
        応募順 <strong>{position}</strong>番目
      </span>
      <span className="grow" />
      <button
        type="button"
        className="btn btn-sm"
        disabled={position <= 1}
        onClick={onUp}
        aria-label="応募順を上げる"
        data-testid="submission-order-up"
      >
        <ArrowUpIcon />
        上げる
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={position >= count}
        onClick={onDown}
        aria-label="応募順を下げる"
        data-testid="submission-order-down"
      >
        <ArrowDownIcon />
        下げる
      </button>
    </div>
  )
}

/**
 * 状態を「応募済み」（または応募前から「選考中」）にした時、応募時の原稿がまだ記録されていなければ、
 * 今の採用原稿を記録するか尋ねる。記録する場合は、応募日が空なら今日を入れる。
 */
async function changeStatus(id: string, next: SubmissionStatus): Promise<void> {
  const prev = getData().submissions[id]
  if (!prev || prev.status === next) return
  commitSubmission(id, { status: next })
  const justSubmitted = next === 'submitted' || (next === 'reviewing' && isBeforeSubmission(prev.status))
  if (!justSubmitted || prev.snapshot) return

  const summary = manuscriptSummary(getData(), prev.titleId)
  const today = toYmd(new Date())
  const ok = await confirmDialog({
    title: '応募した原稿を記録しますか？',
    message:
      `現在の採用原稿（${formatCount(summary.chars)}字・${pieceCountLabel(summary.episodes, summary.specials)}）を、` +
      `この応募先に応募した原稿として記録します。後から改稿しても、応募した時の内容を見返せます。` +
      (prev.submittedOn.trim() ? '' : `\n応募日には今日（${formatYmd(today)}）を入れます。`),
    confirmLabel: '記録する',
    cancelLabel: '記録しない',
  })
  if (!ok) return
  const latest = getData().submissions[id]
  if (!latest || latest.snapshot) return
  const done = attempt(() => {
    actions.recordSubmissionSnapshot(id)
    if (!latest.submittedOn.trim()) actions.updateSubmission(id, { submittedOn: today })
    return true
  })
  if (done) notify('応募時の原稿を記録しました')
}

function SubmissionEditor({
  id,
  submission: s,
  current,
  manuscript,
  titleName,
  onClose,
  order,
}: {
  id: string
  submission: Submission
  current: CurrentAmount
  manuscript: CurrentManuscript
  titleName: string
  onClose: () => void
  /** 応募順の並べ替え（締切順で表示している間・1件だけの時は null） */
  order: { position: number; count: number; onUp: () => void; onDown: () => void } | null
}) {
  const uid = useId()
  // 数字として読めない入力をしたら、その入力欄だけを保存済みの値に戻すための番号
  // （もう一方の欄まで作り直すと、Tab で移ったフォーカスが外れてしまう）
  const [limitReset, setLimitReset] = useState({ minChars: 0, maxChars: 0 })
  const urlOk = isHttpUrl(s.url)
  const unit = limitUnitOf(s)
  const suffix = unitSuffix(unit)
  const phase = statusPhase(s.status)

  const commitLimit = (field: 'minChars' | 'maxChars', raw: string) => {
    const parsed = parseLimit(raw)
    if (parsed === undefined) {
      notifyError(
        unit === 'pages'
          ? '規定枚数は数字で入力してください（例：250）'
          : '規定文字数は数字で入力してください（例：100000、10万）',
      )
      setLimitReset((prev) => ({ ...prev, [field]: prev[field] + 1 }))
      return
    }
    commitSubmission(s.id, field === 'minChars' ? { minChars: parsed } : { maxChars: parsed })
  }

  // 応募後は応募時の原稿と比べる（記録がなければ、参考として現在の採用原稿と比べる）
  const recorded = limitBasis(s, current)
  const basis = recorded ?? { source: 'current' as const, amount: unit === 'pages' ? current.pages : current.chars }
  const fallback = phase !== 'before' && recorded === null
  // 応募した後は「応募時に規定に足りていたか」として言う（これから直す「あと…字必要」は応募前だけ）
  const check = limitCheck(basis.amount, s.minChars, s.maxChars, unit, limitTense(s.status))

  const remove = async () => {
    const latest = getData().submissions[s.id] ?? s
    const ok = await confirmDialog({
      title: `「${contestDisplayName(latest.contestName)}」を削除しますか？`,
      message: trashNotice('応募計画・結果・改稿方針・応募時の原稿などの記録もいっしょに'),
      confirmLabel: '削除',
      danger: true,
    })
    if (ok) attempt(() => actions.deleteSubmission(s.id))
  }

  const text = (
    field: 'overview' | 'result' | 'revisionPlan' | 'resubmissionPlan',
    label: string,
    placeholder: string,
    testId: string,
  ) => (
    <label className="field">
      <span>{label}</span>
      <GrowTextarea
        key={`${s.id}:${field}`}
        className="textarea sg-textarea"
        rows={2}
        value={s[field]}
        onCommit={(v) => commitSubmission(s.id, { [field]: v })}
        placeholder={placeholder}
        data-testid={testId}
      />
    </label>
  )

  const minMaxInvalid = s.minChars !== null && s.maxChars !== null && s.minChars > s.maxChars

  return (
    <div className="sg-editor" id={id} data-testid="submission-editor">
      {order ? <OrderRow {...order} /> : null}
      <div className="sg-grid">
        <label className="field">
          <span>コンテスト名</span>
          <DraftInput
            key={s.id}
            className="input sg-contest-input"
            value={s.contestName}
            onCommit={(v) => commitSubmission(s.id, { contestName: v })}
            placeholder="例：〇〇小説大賞"
            data-testid="submission-contest"
          />
        </label>
        <div className="sg-row sg-row-org">
          <label className="field">
            <span>主催</span>
            <DraftInput
              key={s.id}
              className="input"
              value={s.organizer}
              onCommit={(v) => commitSubmission(s.id, { organizer: v })}
              placeholder="出版社・レーベル・サイト名など"
              data-testid="submission-organizer"
            />
          </label>
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-url`}>
              URL（募集要項など）
            </label>
            <div className="sg-url-row">
              <DraftInput
                key={s.id}
                id={`${uid}-url`}
                className="input"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={s.url}
                onCommit={(v) => commitSubmission(s.id, { url: v.trim() })}
                placeholder="https://"
                data-testid="submission-url"
              />
              {urlOk ? (
                <a
                  className="btn sg-url-open"
                  href={s.url.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="submission-url-open"
                >
                  <LinkIcon />
                  開く
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="sg-row sg-row-dates">
          <DateField
            label="締切"
            value={s.deadline}
            onChange={(v) => commitSubmission(s.id, { deadline: v })}
            testId="submission-deadline-input"
          />
          <DateField
            label="応募日"
            value={s.submittedOn}
            onChange={(v) => commitSubmission(s.id, { submittedOn: v })}
            testId="submission-submitted-input"
          />
          <DateField
            label="結果発表日"
            value={s.resultOn}
            onChange={(v) => commitSubmission(s.id, { resultOn: v })}
            testId="submission-result-on-input"
          />
        </div>

        <div className="sg-row sg-row-state">
          <label className="field">
            <span>状態</span>
            <select
              className="select"
              value={s.status}
              onChange={(e) => void changeStatus(s.id, e.target.value as SubmissionStatus)}
              data-testid="submission-status-select"
            >
              {SUBMISSION_STATUSES.map((st) => (
                <option key={st.value} value={st.value}>
                  {st.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>選考段階</span>
            <DraftInput
              key={s.id}
              className="input"
              value={s.stage}
              onCommit={(v) => commitSubmission(s.id, { stage: v })}
              placeholder="例：一次選考通過、最終候補"
              data-testid="submission-stage"
            />
          </label>
        </div>

        <fieldset className="sg-limits">
          <legend className="field-label">規定（{UNIT_HINT[unit]}）</legend>
          <div className="sg-limits-row">
            <div className="segmented sg-unit" role="group" aria-label="規定の単位">
              <button
                type="button"
                aria-pressed={unit === 'chars'}
                onClick={() => commitSubmission(s.id, { limitUnit: 'chars' })}
                data-testid="limit-unit-chars"
              >
                文字数
              </button>
              <button
                type="button"
                aria-pressed={unit === 'pages'}
                onClick={() => commitSubmission(s.id, { limitUnit: 'pages' })}
                data-testid="limit-unit-pages"
              >
                原稿用紙換算枚数
              </button>
            </div>
            <span className="sg-limit-inputs">
              <label className="sg-limit-field">
                <span className="visually-hidden">下限</span>
                <span aria-hidden="true" className="sg-limit-label">
                  下限
                </span>
                <DraftInput
                  key={`${s.id}:min:${limitReset.minChars}`}
                  className="input sg-limit-input"
                  inputMode="numeric"
                  value={s.minChars === null ? '' : String(s.minChars)}
                  onCommit={(v) => commitLimit('minChars', v)}
                  delay={LIMIT_COMMIT_DELAY}
                  placeholder="なし"
                  data-testid="submission-min"
                />
                <span className="sg-limit-unit">{suffix}</span>
              </label>
              <span className="sg-limit-sep" aria-hidden="true">
                〜
              </span>
              <label className="sg-limit-field">
                <span className="visually-hidden">上限</span>
                <span aria-hidden="true" className="sg-limit-label">
                  上限
                </span>
                <DraftInput
                  key={`${s.id}:max:${limitReset.maxChars}`}
                  className="input sg-limit-input"
                  inputMode="numeric"
                  value={s.maxChars === null ? '' : String(s.maxChars)}
                  onCommit={(v) => commitLimit('maxChars', v)}
                  delay={LIMIT_COMMIT_DELAY}
                  placeholder="なし"
                  data-testid="submission-max"
                />
                <span className="sg-limit-unit">{suffix}</span>
              </label>
            </span>
          </div>
          <p className={`sg-limit-status small${check ? ` is-${check.state}` : ''}`} data-testid="submission-limit-detail">
            {basis.source === 'snapshot' ? '応募時の原稿' : '現在の採用原稿'} {formatAmount(basis.amount, unit)}
            {check ? (
              <>
                {' → '}
                <strong>{check.text}</strong>
              </>
            ) : (
              <span className="faint">
                （規定を入れると、足りない・超えている{unit === 'pages' ? '枚数' : '文字数'}を表示します）
              </span>
            )}
            {fallback ? (
              <span className="faint" data-testid="submission-limit-fallback">
                {s.snapshot
                  ? '（応募時の記録に枚数がないため、現在の採用原稿と比べています）'
                  : '（応募時の原稿が未記録のため、現在の採用原稿と比べています）'}
              </span>
            ) : null}
          </p>
          {minMaxInvalid ? <p className="small sg-limit-warn">下限が上限より大きくなっています。</p> : null}
        </fieldset>

        {text(
          'overview',
          'コンテストの概要',
          '対象ジャンル・賞金や賞典・選考の流れ・応募規定・求められている作風など',
          'submission-overview',
        )}
        {text('result', '結果・講評', '選考結果、編集者や選考委員の講評、評価シートの内容など', 'submission-result')}
        {text(
          'revisionPlan',
          '結果を踏まえた改稿方針',
          '講評で指摘された点をどう直すか、次の応募までに何を変えるか',
          'submission-revision',
        )}
        {text(
          'resubmissionPlan',
          '再応募方針',
          'どのコンテストに、いつ、どの形で出し直すか（概要・規定との相性も踏まえて）',
          'submission-resubmission',
        )}
      </div>

      <SnapshotBox submission={s} manuscript={manuscript} titleName={titleName} />

      <div className="sg-editor-actions">
        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="submission-delete">
          <TrashIcon />
          削除
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={onClose} data-testid="submission-close">
          閉じる
        </button>
      </div>
    </div>
  )
}

function DateField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  testId: string
}) {
  return (
    <label className="field sg-date">
      <span>{label}</span>
      <input type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
    </label>
  )
}

/** 内訳を最初から開いておく件数の上限（多いときは畳んでおく） */
const OPEN_ROWS_LIMIT = 12

/** 応募時の原稿を読む画面の本文の文字の大きさ（strategy.css の .sg-reader-body と合わせる） */
const READER_FONT_SIZE = 16

function SnapshotBox({
  submission: s,
  manuscript,
  titleName,
}: {
  submission: Submission
  manuscript: CurrentManuscript
  titleName: string
}) {
  const snap = s.snapshot
  // 今の原稿の状態はタブで1回だけ作ったものを使う（応募先ごとに原稿全体をなめ直さない）
  const view = useMemo(() => (snap ? snapshotView(snap, manuscript) : null), [snap, manuscript])
  const [reading, setReading] = useState(false)
  // 内訳は開いている時だけ描く（数百話の内訳を、応募先の数だけ常に描かない）
  // 開閉を操作するまでは件数で決める（少なければ開いておく）
  const [rowsToggled, setRowsToggled] = useState<boolean | null>(null)
  const rowsOpen = rowsToggled ?? (view ? view.rows.length <= OPEN_ROWS_LIMIT : false)
  const pages = snap ? snapshotPages(snap) : null
  const changes = view ? snapshotChangeSummary(view.diff) : ''
  const recordedRows = view ? view.rows.filter((r) => r.change !== 'added').length : 0

  const record = async () => {
    const latest = getData().submissions[s.id]
    if (!latest) return
    if (latest.snapshot) {
      const ok = await confirmDialog({
        title: '応募時の原稿を記録し直しますか？',
        message: `前回の記録（${formatDateTime(latest.snapshot.at)}・${formatCount(latest.snapshot.charCount)}字）は、現在の採用原稿で上書きされます。`,
        confirmLabel: '記録し直す',
      })
      if (!ok) return
    }
    if (attempt(() => (actions.recordSubmissionSnapshot(s.id), true))) notify('応募時の原稿を記録しました')
  }

  const exportText = () => {
    const latest = getData().submissions[s.id]?.snapshot
    const text = latest ? snapshotText(getData(), latest, getData().titles[s.titleId]?.name ?? titleName) : null
    if (!text) return
    const contest = s.contestName.trim() || '応募先'
    downloadFile(`${safeFileName(titleName)}_${safeFileName(contest)}_応募時の原稿.txt`, text)
  }

  return (
    <section className="sg-snapshot" aria-label="応募時の原稿" data-testid="snapshot">
      <div className="sg-snapshot-head">
        <h3 className="sg-snapshot-title">
          <CameraIcon />
          応募時の原稿
        </h3>
        <button type="button" className="btn btn-sm sg-snapshot-btn" onClick={() => void record()} data-testid="snapshot-record">
          {snap ? '記録し直す' : '応募時の原稿を記録'}
        </button>
      </div>
      {snap && view ? (
        <>
          <p className="sg-snapshot-info" data-testid="snapshot-info">
            <span>{formatDateTime(snap.at)} 記録</span>・<span>{formatCount(snap.charCount)}字</span>
            {pages !== null ? (
              <>
                ・<span>約{formatCount(pages)}枚</span>
              </>
            ) : null}
            ・<span>{pieceCountLabel(view.episodes, view.specials)}</span>
          </p>
          {changes ? (
            <p className="small sg-snapshot-changed" data-testid="snapshot-diff">
              記録した後に変わったもの：<strong>{changes}</strong>
              {view.diff.charDelta !== 0 ? (
                <>
                  （文字数 {view.diff.charDelta > 0 ? '+' : '−'}
                  {formatCount(Math.abs(view.diff.charDelta))}字）
                </>
              ) : null}
            </p>
          ) : (
            <p className="small muted" data-testid="snapshot-diff">
              記録した後、採用原稿は変わっていません。
            </p>
          )}
          {view.detailed ? (
            <>
              <details className="sg-snap-details" open={rowsOpen} onToggle={(e) => setRowsToggled(e.currentTarget.open)}>
                <summary data-testid="snapshot-pieces-toggle">応募した原稿の内訳（{recordedRows}件）</summary>
                {rowsOpen ? (
                  <ol className="sg-snap-list" data-testid="snapshot-pieces">
                    {view.rows.map((r) => (
                      <li
                        key={r.pieceId}
                        className={`sg-snap-row${r.change ? ` is-${r.change}` : ''}`}
                        data-testid="snapshot-piece"
                        data-change={r.change ?? ''}
                      >
                        <span className="sg-snap-name">
                          <span className={`sg-snap-label${r.kind === 'special' ? ' is-special' : ''}`}>{r.label}</span>
                          {r.subtitle ? <span className="sg-snap-subtitle">{r.subtitle}</span> : null}
                        </span>
                        <span className="sg-snap-meta">
                          {r.change === 'added'
                            ? '記録後に追加'
                            : r.noActive
                              ? '採用原稿なし'
                              : `${r.versionName ?? '（稿名なし）'}・${formatCount(r.chars)}字`}
                        </span>
                        {r.change ? (
                          <span className={`badge sg-snap-badge is-${r.change}`} data-testid="snapshot-piece-change">
                            {SNAPSHOT_CHANGE_LABEL[r.change]}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </details>
              <div className="sg-snapshot-actions">
                <button type="button" className="btn btn-sm" onClick={() => setReading(true)} data-testid="snapshot-read">
                  <BookIcon />
                  応募時の原稿を読む
                </button>
                <button type="button" className="btn btn-sm" onClick={exportText} data-testid="snapshot-export">
                  <DownloadIcon />
                  応募時の原稿を書き出す
                </button>
              </div>
            </>
          ) : (
            <p className="small sg-snapshot-legacy" data-testid="snapshot-legacy">
              この記録は以前の形式のため、話ごとの内訳と本文の控えがありません。内訳を残すには「記録し直す」を押してください（その時点の採用原稿で記録し直されます）。
            </p>
          )}
        </>
      ) : (
        <p className="small muted">
          応募した時点で、どの稿を採用していたか・本文・文字数を記録しておけます。後から改稿しても、応募した原稿を読み返したり書き出したりでき、変えた話がひと目で分かります。
        </p>
      )}
      {reading && snap ? (
        <SnapshotReader
          snapshot={snap}
          contest={contestDisplayName(s.contestName)}
          onExport={exportText}
          onClose={() => setReading(false)}
        />
      ) : null}
    </section>
  )
}

/** 応募時に記録した原稿（本文の控え）を読む */
function SnapshotReader({
  snapshot,
  contest,
  onExport,
  onClose,
}: {
  snapshot: SubmissionSnapshot
  contest: string
  onExport: () => void
  onClose: () => void
}) {
  const order = snapshot.order ?? []
  // 長編でも開いた時に全文を組まないよう、画面の外の話は見積もった大きさで場所だけ取る（通し読みと同じ）
  const readerRef = useRef<HTMLDivElement>(null)
  useCharsPerLine(readerRef, 0, [], READER_FONT_SIZE)
  // ルビ・傍点の要素は画面の近くに来た話だけに作る（ダイアログの本文の枠の中をスクロールする）
  const registerNear = useNearViewportWatcher(() => readerRef.current?.closest('.modal-body') ?? null, [])
  return (
    <Modal
      title={`応募時の原稿（${contest}）`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onExport} data-testid="snapshot-reader-export">
            <DownloadIcon />
            書き出す
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            閉じる
          </button>
        </>
      }
    >
      <NearViewportContext.Provider value={registerNear}>
        <div className="sg-reader" ref={readerRef} data-testid="snapshot-reader">
          <p className="small muted sg-reader-info">
            {formatDateTime(snapshot.at)} に記録・{formatCount(snapshot.charCount)}字
          </p>
          {order.map((id) => {
            const p = snapshot.pieces?.[id]
            return p ? <SnapshotReaderPiece key={id} piece={p} /> : null
          })}
        </div>
      </NearViewportContext.Provider>
    </Modal>
  )
}

/** 応募時の原稿の1話分。ルビ・傍点はこの話が画面の近くに来てから表示する */
function SnapshotReaderPiece({ piece: p }: { piece: SnapshotPiece }) {
  const ref = useRef<HTMLElement>(null)
  const data = getData()
  const body = snapshotPieceBody(data, p)
  const record = p.textKey ? data.snapshotTexts[p.textKey] : undefined
  const shape = record ? lineShape(record) : body ? lineShapeOf(body) : null
  return (
    <article ref={ref} className="sg-reader-piece" style={shape ? lineShapeStyle(shape) : undefined}>
      <h3 className="sg-reader-heading">
        <span>{p.label}</span>
        {p.subtitle.trim() ? <span className="sg-reader-subtitle">{p.subtitle.trim()}</span> : null}
        {p.versionName ? <span className="badge sg-reader-version">{p.versionName}</span> : null}
      </h3>
      {body === null ? (
        <p className="muted sg-reader-none">採用原稿がありません。</p>
      ) : (
        <div className="sg-reader-body">
          <LazyRubyText text={body} watch={ref} />
        </div>
      )}
    </article>
  )
}
