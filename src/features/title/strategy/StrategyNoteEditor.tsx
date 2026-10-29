// 戦略メモを手で書く・書き直す（見出し・Markdown の本文・コンテストの候補）。Claude が書いた締切・URL・規定の間違いもここで直す。
// 保存は［保存］を押した時（閉じると何も変えない）。コンテストの候補は前の候補と印（k0…）で結び付き、
// ［応募計画にする］で作った応募計画の印は残る。
import { useState } from 'react'
import type { ID, LimitUnit, StrategyNote } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { attempt, notify } from '../../../store/uiStore'
import { PlusIcon, TrashIcon } from '../../../ui/icons'
import { Modal } from '../../../ui/Modal'

interface ContestDraft {
  /** 画面の中だけの印（React の key） */
  key: string
  /** 前の候補の印（新しい候補は無し） */
  id?: string
  name: string
  organizer: string
  url: string
  deadline: string
  min: string
  max: string
  unit: LimitUnit
  fit: string
  plan: string
  /** 応募計画にした候補 */
  planned: boolean
}

let seq = 0
const draftKey = () => `c${++seq}`

function draftsOf(note: StrategyNote | null): ContestDraft[] {
  return (note?.contests ?? []).map((c) => ({
    key: draftKey(),
    id: c.id,
    name: c.name,
    organizer: c.organizer,
    url: c.url,
    deadline: c.deadline,
    min: c.minChars === null ? '' : String(c.minChars),
    max: c.maxChars === null ? '' : String(c.maxChars),
    unit: c.limitUnit === 'pages' ? 'pages' : 'chars',
    fit: c.fit,
    plan: c.plan,
    planned: c.submissionId !== null,
  }))
}

const blank = (): ContestDraft => ({
  key: draftKey(),
  name: '',
  organizer: '',
  url: '',
  deadline: '',
  min: '',
  max: '',
  unit: 'chars',
  fit: '',
  plan: '',
  planned: false,
})

/** '' は null、数字でなければ NaN（保存の時の確かめで断る） */
const countOf = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim().replace(/[,，]/g, '')))

export interface StrategyNoteEditorProps {
  titleId: ID
  /** 書き直すメモ（null = 新しく足す） */
  note: StrategyNote | null
  onClose: () => void
}

export function StrategyNoteEditor({ titleId, note, onClose }: StrategyNoteEditorProps) {
  const [heading, setHeading] = useState(note?.heading ?? '')
  const [body, setBody] = useState(note?.body ?? '')
  const [contests, setContests] = useState<ContestDraft[]>(() => draftsOf(note))

  const change = (key: string, patch: Partial<ContestDraft>) =>
    setContests((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  const save = () => {
    const input = contests.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      name: c.name,
      organizer: c.organizer,
      url: c.url,
      deadline: c.deadline,
      minChars: countOf(c.min),
      maxChars: countOf(c.max),
      limitUnit: c.unit,
      fit: c.fit,
      plan: c.plan,
    }))
    const ok = note
      ? attempt(() => (actions.updateStrategyNote(note.id, { heading, body, contests: input }), true))
      : attempt(() => actions.addStrategyNote(titleId, { heading, body, contests: input }))
    if (!ok) return
    notify(note ? '戦略メモを書き直しました' : '戦略メモを足しました')
    onClose()
  }

  return (
    <Modal
      title={note ? '戦略メモを書き直す' : '戦略メモを足す'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid="strategy-memo-save">
            保存
          </button>
        </>
      }
    >
      <div className="stack sn-editor" data-testid="strategy-memo-editor">
        <label className="field">
          <span>見出し</span>
          <input
            className="input"
            value={heading}
            onChange={(e) => setHeading(e.target.value)}
            placeholder="例: 長編の新人賞を軸に"
            data-testid="strategy-memo-heading-input"
          />
        </label>
        <label className="field">
          <span>本文（Markdown）</span>
          <textarea
            className="textarea"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            data-testid="strategy-memo-body-input"
          />
        </label>
        <fieldset className="sn-editor-contests">
          <legend className="field-label">コンテストの候補</legend>
          {contests.length === 0 ? <p className="small muted">まだありません。</p> : null}
          {contests.map((c, i) => (
            <div key={c.key} className="sn-editor-contest" data-testid="strategy-contest-editor">
              <div className="sn-editor-contest-head">
                <strong className="small">候補 {i + 1}</strong>
                {c.planned ? <span className="tiny faint">応募計画にしました</span> : null}
                <span className="grow" />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setContests((list) => list.filter((x) => x.key !== c.key))}
                  aria-label={`候補 ${i + 1} を外す`}
                  title="この候補を外す"
                  data-testid="strategy-contest-remove"
                >
                  <TrashIcon />
                </button>
              </div>
              <div className="sn-editor-grid">
                <label className="field">
                  <span>名前</span>
                  <input
                    className="input"
                    value={c.name}
                    onChange={(e) => change(c.key, { name: e.target.value })}
                    data-testid="strategy-contest-name-input"
                  />
                </label>
                <label className="field">
                  <span>主催</span>
                  <input className="input" value={c.organizer} onChange={(e) => change(c.key, { organizer: e.target.value })} />
                </label>
                <label className="field">
                  <span>公式ページ（https）</span>
                  <input
                    className="input"
                    type="url"
                    inputMode="url"
                    value={c.url}
                    onChange={(e) => change(c.key, { url: e.target.value })}
                    placeholder="https://"
                    data-testid="strategy-contest-url-input"
                  />
                </label>
                <label className="field">
                  <span>締切</span>
                  <input
                    className="input"
                    type="date"
                    value={c.deadline}
                    onChange={(e) => change(c.key, { deadline: e.target.value })}
                    data-testid="strategy-contest-deadline-input"
                  />
                </label>
                <label className="field">
                  <span>規定の下限</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={c.min}
                    onChange={(e) => change(c.key, { min: e.target.value })}
                    data-testid="strategy-contest-min-input"
                  />
                </label>
                <label className="field">
                  <span>規定の上限</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={c.max}
                    onChange={(e) => change(c.key, { max: e.target.value })}
                    data-testid="strategy-contest-max-input"
                  />
                </label>
              </div>
              <div className="segmented" role="group" aria-label="規定の単位">
                <button type="button" aria-pressed={c.unit === 'chars'} onClick={() => change(c.key, { unit: 'chars' })}>
                  文字数
                </button>
                <button type="button" aria-pressed={c.unit === 'pages'} onClick={() => change(c.key, { unit: 'pages' })}>
                  原稿用紙の枚数
                </button>
              </div>
              <label className="field">
                <span>相性</span>
                <textarea className="textarea" rows={2} value={c.fit} onChange={(e) => change(c.key, { fit: e.target.value })} />
              </label>
              <label className="field">
                <span>方針</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={c.plan}
                  onChange={(e) => change(c.key, { plan: e.target.value })}
                />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setContests((list) => [...list, blank()])}
            data-testid="strategy-contest-add"
          >
            <PlusIcon />
            候補を足す
          </button>
        </fieldset>
      </div>
    </Modal>
  )
}
