// 相対比較の作品の分析を手で足す・直す（観点・日付・Markdown の本文）。観点はすべての作品の分析の観点から選べる
// （作品をまたいで同じ名前にそろえると、観点ごとに比べやすい）。保存は［保存］を押した時。
import { useId, useMemo, useState } from 'react'
import { jstDate } from '../../claude/dates'
import { BENCH_LIMITS, benchViewpointSuggestions } from '../../domain/benchOps'
import { DEFAULT_BENCH_VIEWPOINTS } from '../../claude/prompts'
import type { BenchAnalysis, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import './bench.css'

export interface AnalysisDialogProps {
  workId: ID
  /** 直す分析（null = 新しく足す） */
  analysis: BenchAnalysis | null
  onClose: () => void
  /** 足した後（分析の id） */
  onAdded?: (id: ID) => void
}

export function AnalysisDialog({ workId, analysis, onClose, onAdded }: AnalysisDialogProps) {
  const formId = useId()
  const benchAnalyses = useData().benchAnalyses
  const suggestions = useMemo(() => {
    const used = benchViewpointSuggestions({ benchAnalyses })
    return [...used, ...DEFAULT_BENCH_VIEWPOINTS.filter((v) => !used.includes(v))]
  }, [benchAnalyses])
  const [viewpoint, setViewpoint] = useState(analysis?.viewpoint ?? '')
  const [runDate, setRunDate] = useState(analysis?.runDate || jstDate(Date.now()))
  const [body, setBody] = useState(analysis?.body ?? '')
  const [tried, setTried] = useState(false)
  const missing = !viewpoint.trim()

  const save = () => {
    setTried(true)
    if (missing) return
    const input = { viewpoint, runDate, body }
    if (analysis) {
      if (attempt(() => (actions.updateBenchAnalysis(analysis.id, input), true))) {
        notify('分析を保存しました')
        onClose()
      }
      return
    }
    const id = attempt(() => actions.addBenchAnalysis(workId, input))
    if (!id) return
    notify(`「${viewpoint.trim()}」の分析を足しました`)
    onClose()
    onAdded?.(id)
  }

  return (
    <Modal
      title={analysis ? '分析を直す' : '分析を追加'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="bench-analysis-save">
            保存
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack bw-form"
        data-testid="bench-analysis-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="bw-form-row">
          <label className="field bw-viewpoint-field">
            <span>
              観点<span className="bw-required">（必須・{BENCH_LIMITS.viewpoint}字まで）</span>
            </span>
            <input
              className="input"
              value={viewpoint}
              onChange={(e) => setViewpoint(e.target.value)}
              maxLength={BENCH_LIMITS.viewpoint}
              list={`${formId}-viewpoints`}
              placeholder="例：構成"
              aria-invalid={tried && missing ? true : undefined}
              data-testid="bench-analysis-viewpoint"
            />
            <datalist id={`${formId}-viewpoints`}>
              {suggestions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {tried && missing ? (
              <span className="cl-error small" role="alert">
                観点を入れてください（構成・文体・人物など）
              </span>
            ) : null}
          </label>
          <label className="field bw-date-field">
            <span>分析した日</span>
            <input
              className="input"
              type="date"
              value={runDate}
              onChange={(e) => setRunDate(e.target.value)}
              required
              data-testid="bench-analysis-date"
            />
          </label>
        </div>
        <div className="bw-suggest" role="group" aria-label="観点の候補">
          {suggestions.slice(0, 8).map((v) => (
            <button
              key={v}
              type="button"
              className={`bw-suggest-chip${viewpoint.trim() === v ? ' is-on' : ''}`}
              aria-pressed={viewpoint.trim() === v}
              onClick={() => setViewpoint(v)}
              data-testid="bench-analysis-suggestion"
            >
              {v}
            </button>
          ))}
        </div>
        <label className="field">
          <span>分析（Markdown）</span>
          <textarea
            className="textarea bw-body-input"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'## 構成\n- 三幕構成。第一幕の終わりに…'}
            spellCheck={false}
            data-testid="bench-analysis-input"
          />
        </label>
      </form>
    </Modal>
  )
}
