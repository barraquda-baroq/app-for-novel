// 資料の記録を手で足す・直す（項目・日付・Markdown の本文）。項目は決まった4つ（要約・創作に役立つ知識・描写に使える部分・
// サンプルシーン）と、すべての資料の記録で使ったことのある項目から選べる（資料をまたいで同じ名前にそろえやすいように）。
// 保存は［保存］を押した時。相対比較の AnalysisDialog と同じ作り（既にある記録を直している間は、Claude の依頼（「ゴミ箱へ移す依頼」など）を
// 当てない。ClaudeRequests の useHoldClaudeRequests）。
import { useId, useMemo, useState } from 'react'
import { jstDate } from '../../claude/dates'
import { MATERIAL_LIMITS, materialSectionSuggestions } from '../../domain/materialOps'
import type { ID, MaterialNote } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { useHoldClaudeRequests } from '../claude/ClaudeRequests'
import './materials.css'

/** 項目の候補のチップの数 */
const SUGGESTIONS_SHOWN = 8

export interface MaterialNoteDialogProps {
  materialId: ID
  /** 直す記録（null = 新しく足す） */
  note: MaterialNote | null
  /** 新しく足す時に最初に入れておく項目 */
  section?: string
  onClose: () => void
  /** 足した後（記録の id） */
  onAdded?: (id: ID) => void
}

export function MaterialNoteDialog({ materialId, note, section: initialSection, onClose, onAdded }: MaterialNoteDialogProps) {
  const formId = useId()
  const materialNotes = useData().materialNotes
  const suggestions = useMemo(() => materialSectionSuggestions({ materialNotes }), [materialNotes])
  const [section, setSection] = useState(note?.section ?? initialSection ?? '')
  const [runDate, setRunDate] = useState(note?.runDate || jstDate(Date.now()))
  const [body, setBody] = useState(note?.body ?? '')
  const [tried, setTried] = useState(false)
  const missing = !section.trim()
  useHoldClaudeRequests(note !== null)

  const save = () => {
    setTried(true)
    if (missing) return
    const input = { section, runDate, body }
    if (note) {
      if (attempt(() => (actions.updateMaterialNote(note.id, input), true))) {
        notify('記録を保存しました')
        onClose()
      }
      return
    }
    const id = attempt(() => actions.addMaterialNote(materialId, input))
    if (!id) return
    notify(`「${section.trim()}」の記録を足しました`)
    onClose()
    onAdded?.(id)
  }

  return (
    <Modal
      title={note ? '記録を直す' : '記録を追加'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="material-note-save">
            保存
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack mt-form"
        data-testid="material-note-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="mt-form-row">
          <label className="field mt-section-field">
            <span>
              項目<span className="mt-required">（必須・{MATERIAL_LIMITS.section}字まで）</span>
            </span>
            <input
              className="input"
              value={section}
              onChange={(e) => setSection(e.target.value)}
              maxLength={MATERIAL_LIMITS.section}
              list={`${formId}-sections`}
              placeholder="例：要約"
              aria-invalid={tried && missing ? true : undefined}
              data-testid="material-note-section"
            />
            <datalist id={`${formId}-sections`}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {tried && missing ? (
              <span className="cl-error small" role="alert">
                項目を入れてください（要約・創作に役立つ知識など）
              </span>
            ) : null}
          </label>
          <label className="field mt-date-field">
            <span>記録した日</span>
            <input
              className="input"
              type="date"
              value={runDate}
              onChange={(e) => setRunDate(e.target.value)}
              required
              data-testid="material-note-date"
            />
          </label>
        </div>
        <div className="mt-suggest" role="group" aria-label="項目の候補">
          {suggestions.slice(0, SUGGESTIONS_SHOWN).map((s) => (
            <button
              key={s}
              type="button"
              className={`mt-suggest-chip${section.trim() === s ? ' is-on' : ''}`}
              aria-pressed={section.trim() === s}
              onClick={() => setSection(s)}
              data-testid="material-note-suggestion"
            >
              {s}
            </button>
          ))}
        </div>
        <label className="field">
          <span>記録（Markdown）</span>
          <textarea
            className="textarea mt-body-input"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'## 要約\n- 第1章では…'}
            spellCheck={false}
            data-testid="material-note-input"
          />
        </label>
      </form>
    </Modal>
  )
}
