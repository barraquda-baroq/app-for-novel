// 応募計画1件のカード。見出し行に応募順・コンテスト名・状態・締切・規定文字数の判定、開くと詳細を編集できる。
import { useId, useMemo, useState } from 'react'
import { SUBMISSION_STATUSES, submissionStatusLabel, type SubmissionPatch } from '../../../domain/entityOps'
import { formatCount } from '../../../domain/text'
import type { Submission, SubmissionStatus } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { formatDateTime } from '../../../ui/browser'
import { confirmDialog } from '../../../ui/dialogs'
import { DraftInput } from '../../../ui/DraftField'
import { CameraIcon, ChevronRightIcon, DownIcon, LinkIcon, TrashIcon, UpIcon } from '../../../ui/icons'
import { GrowTextarea } from '../settings/GrowTextarea'
import {
  charLimitCheck,
  charLimitRange,
  compareSnapshot,
  deadlineInfo,
  isHttpUrl,
  parseCharLimit,
  statusTone,
  type CharLimitCheck,
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

/** 規定文字数は入力の途中で判定しないよう、確定（Enter・フォーカスを外す）した時だけ保存する */
const LIMIT_COMMIT_DELAY = 10 * 60 * 1000

const LIMIT_BADGE: Record<CharLimitCheck['state'], string> = {
  ok: 'badge-active',
  short: 'badge-missing',
  over: 'badge-danger',
}

export interface SubmissionCardProps {
  submission: Submission
  /** 応募順（1始まり） */
  position: number
  isFirst: boolean
  isLast: boolean
  /** 締切順で表示している間は並べ替えボタンを出さない */
  canReorder: boolean
  expanded: boolean
  onToggle: () => void
  /** 現在の採用原稿の総文字数 */
  totalChars: number
  today: Date
}

export function SubmissionCard({
  submission: s,
  position,
  isFirst,
  isLast,
  canReorder,
  expanded,
  onToggle,
  totalChars,
  today,
}: SubmissionCardProps) {
  const tone = statusTone(s.status)
  const deadline = deadlineInfo(s, today)
  const check = charLimitCheck(totalChars, s.minChars, s.maxChars)
  const name = contestDisplayName(s.contestName)
  const bodyId = `sg-sub-${s.id}`

  return (
    <li
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
          onClick={onToggle}
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
              {check ? (
                <span
                  className={`badge ${LIMIT_BADGE[check.state]}`}
                  data-testid="submission-limit"
                  title={`規定 ${charLimitRange(s.minChars, s.maxChars)}`}
                >
                  {check.text}
                </span>
              ) : null}
            </span>
          </span>
          <ChevronRightIcon className="icon sg-card-chevron" />
        </button>
        {canReorder ? (
          <div className="sg-card-order">
            <button
              type="button"
              className="icon-btn"
              disabled={isFirst}
              onClick={() => attempt(() => actions.moveSubmissionStep(s.id, -1))}
              aria-label="応募順を上げる"
              title="応募順を上げる"
              data-testid="submission-up"
            >
              <UpIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={isLast}
              onClick={() => attempt(() => actions.moveSubmissionStep(s.id, 1))}
              aria-label="応募順を下げる"
              title="応募順を下げる"
              data-testid="submission-down"
            >
              <DownIcon />
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? <SubmissionEditor id={bodyId} submission={s} totalChars={totalChars} check={check} onClose={onToggle} /> : null}
    </li>
  )
}

function SubmissionEditor({
  id,
  submission: s,
  totalChars,
  check,
  onClose,
}: {
  id: string
  submission: Submission
  totalChars: number
  check: CharLimitCheck | null
  onClose: () => void
}) {
  const uid = useId()
  // 数字として読めない入力をしたら、入力欄を保存済みの値に戻すための番号
  const [limitReset, setLimitReset] = useState(0)
  const urlOk = isHttpUrl(s.url)

  const commitLimit = (field: 'minChars' | 'maxChars', raw: string) => {
    const parsed = parseCharLimit(raw)
    if (parsed === undefined) {
      notifyError('規定文字数は数字で入力してください（例：100000、10万）')
      setLimitReset((n) => n + 1)
      return
    }
    commitSubmission(s.id, field === 'minChars' ? { minChars: parsed } : { maxChars: parsed })
  }

  const remove = async () => {
    const latest = getData().submissions[s.id] ?? s
    const ok = await confirmDialog({
      title: `「${contestDisplayName(latest.contestName)}」を削除しますか？`,
      message: '応募計画・結果・改稿方針などの記録も削除されます。この操作は取り消せません。',
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
              onChange={(e) => commitSubmission(s.id, { status: e.target.value as SubmissionStatus })}
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
          <legend className="field-label">規定文字数（空白・改行を除く）</legend>
          <div className="sg-limits-row">
            <label className="sg-limit-field">
              <span className="visually-hidden">下限</span>
              <span aria-hidden="true" className="sg-limit-label">
                下限
              </span>
              <DraftInput
                key={`${s.id}:min:${limitReset}`}
                className="input sg-limit-input"
                inputMode="numeric"
                value={s.minChars === null ? '' : String(s.minChars)}
                onCommit={(v) => commitLimit('minChars', v)}
                delay={LIMIT_COMMIT_DELAY}
                placeholder="なし"
                data-testid="submission-min"
              />
              <span className="sg-limit-unit">字</span>
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
                key={`${s.id}:max:${limitReset}`}
                className="input sg-limit-input"
                inputMode="numeric"
                value={s.maxChars === null ? '' : String(s.maxChars)}
                onCommit={(v) => commitLimit('maxChars', v)}
                delay={LIMIT_COMMIT_DELAY}
                placeholder="なし"
                data-testid="submission-max"
              />
              <span className="sg-limit-unit">字</span>
            </label>
          </div>
          <p className={`sg-limit-status small${check ? ` is-${check.state}` : ''}`} data-testid="submission-limit-detail">
            現在の採用原稿 {formatCount(totalChars)}字
            {check ? (
              <>
                {' → '}
                <strong>{check.text}</strong>
              </>
            ) : (
              <span className="faint">（規定を入れると、足りない・超えている文字数を表示します）</span>
            )}
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

      <SnapshotBox submission={s} />

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

function SnapshotBox({ submission: s }: { submission: Submission }) {
  const data = useData()
  const snap = s.snapshot
  const diff = useMemo(() => (snap ? compareSnapshot(data, s.titleId, snap) : null), [data, s.titleId, snap])

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

  return (
    <section className="sg-snapshot" aria-label="応募時の原稿" data-testid="snapshot">
      <div className="sg-snapshot-text">
        <h3 className="sg-snapshot-title">
          <CameraIcon />
          応募時の原稿
        </h3>
        {snap && diff ? (
          <>
            <p className="sg-snapshot-info" data-testid="snapshot-info">
              {formatDateTime(snap.at)} 記録・{formatCount(snap.charCount)}字・{diff.recordedPieces}話
            </p>
            {diff.switched === 0 && diff.edited === 0 ? (
              <p className="small muted" data-testid="snapshot-diff">
                記録した後、採用原稿は変わっていません。
              </p>
            ) : (
              <p className="small sg-snapshot-changed" data-testid="snapshot-diff">
                記録した後に採用原稿が変わった話：<strong>{diff.switched}話</strong>
                {diff.edited > 0 ? <>　採用中の稿を編集した話：{diff.edited}話</> : null}
                {diff.charDelta !== 0 ? (
                  <>
                    　文字数 {diff.charDelta > 0 ? '+' : '−'}
                    {formatCount(Math.abs(diff.charDelta))}字
                  </>
                ) : null}
              </p>
            )}
          </>
        ) : (
          <p className="small muted">
            応募した時点で、どの稿を採用していたか・総文字数を記録しておけます。後から改稿した話がひと目で分かります。
          </p>
        )}
      </div>
      <button type="button" className="btn btn-sm sg-snapshot-btn" onClick={() => void record()} data-testid="snapshot-record">
        応募時の原稿を記録
      </button>
    </section>
  )
}
