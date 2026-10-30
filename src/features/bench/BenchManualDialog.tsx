// 相対比較の作品の画面の「Claude に頼む（手動）」: コネクタを使わずに、作品の PDF を置いた claude.ai のプロジェクトのチャットに
// 貼り付ける依頼文をコピーする（本文は送らない。PDF はプロジェクトのナレッジにある）。観点は選べて、足すこともできる。
// Claude の答えの最後のコードブロックは「結果を貼り付け」で分析として取り込む（PasteResultDialog）。
import { useMemo, useState } from 'react'
import { jstDate } from '../../claude/dates'
import { benchAnalysisPrompt, DEFAULT_BENCH_VIEWPOINTS } from '../../claude/prompts'
import { BENCH_LIMITS, benchViewpointSuggestions } from '../../domain/benchOps'
import type { BenchWork } from '../../domain/types'
import { useData } from '../../store/appStore'
import { copyText } from '../../ui/browser'
import { CheckIcon, CopyIcon, PlusIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { PasteIcon } from '../claude/claudeIcons'
import './bench.css'

export interface BenchManualDialogProps {
  work: BenchWork
  onClose: () => void
  /** 「結果を貼り付け」を開く（閉じてから開く） */
  onPaste: () => void
}

export function BenchManualDialog({ work, onClose, onPaste }: BenchManualDialogProps) {
  const benchAnalyses = useData().benchAnalyses
  const options = useMemo(() => {
    const used = benchViewpointSuggestions({ benchAnalyses })
    return [...DEFAULT_BENCH_VIEWPOINTS, ...used.filter((v) => !(DEFAULT_BENCH_VIEWPOINTS as readonly string[]).includes(v))]
  }, [benchAnalyses])
  const [extra, setExtra] = useState<string[]>([])
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_BENCH_VIEWPOINTS))
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const all = [...options, ...extra.filter((v) => !options.includes(v))]
  const viewpoints = all.filter((v) => chosen.has(v))
  const today = jstDate(Date.now())
  const prompt = useMemo(() => benchAnalysisPrompt(work, viewpoints, today), [work, viewpoints.join('\u0000'), today]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (v: string) => {
    setCopied(false)
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }
  const addViewpoint = () => {
    const v = draft.trim()
    if (!v) return
    if (!all.includes(v)) setExtra((list) => [...list, v])
    setChosen((prev) => new Set(prev).add(v))
    setDraft('')
    setCopied(false)
  }
  const copy = async () => {
    if (await copyText(prompt, '依頼文をコピーしました（PDF を置いた claude.ai のプロジェクトのチャットに貼り付けてください）'))
      setCopied(true)
  }

  return (
    <Modal
      title="Claude に頼む（手動）"
      wide
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose()
              onPaste()
            }}
            data-testid="bench-manual-open-paste"
          >
            <PasteIcon />
            結果を貼り付け
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="bench-manual-close">
            閉じる
          </button>
        </>
      }
    >
      <div className="stack bw-manual" data-testid="bench-manual-dialog">
        <p className="small muted bw-lead">
          コネクタを使わずに、『{work.name.trim() || '無題'}』の PDF を置いた claude.ai のプロジェクトで分析してもらいます。PDF
          はプロジェクトのナレッジにあるので、本文は送りません。答えの最後のコードブロックを「結果を貼り付け」で取り込めます。
        </p>
        <div className="field">
          <span id="bw-manual-viewpoints">分析の観点</span>
          <div className="bw-suggest" role="group" aria-labelledby="bw-manual-viewpoints">
            {all.map((v) => (
              <button
                key={v}
                type="button"
                className={`bw-suggest-chip${chosen.has(v) ? ' is-on' : ''}`}
                aria-pressed={chosen.has(v)}
                onClick={() => toggle(v)}
                data-testid="bench-manual-viewpoint"
              >
                {chosen.has(v) ? <CheckIcon /> : null}
                {v}
              </button>
            ))}
          </div>
        </div>
        <form
          className="bw-add-viewpoint"
          onSubmit={(e) => {
            e.preventDefault()
            addViewpoint()
          }}
        >
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={BENCH_LIMITS.viewpoint}
            placeholder="観点を足す（例：会話の運び）"
            aria-label="足す観点"
            data-testid="bench-manual-new-viewpoint"
          />
          <button type="submit" className="btn" disabled={!draft.trim()} data-testid="bench-manual-add-viewpoint">
            <PlusIcon />
            足す
          </button>
        </form>
        <ol className="cl-manual-steps small muted">
          <li>
            claude.ai で、作品の PDF をナレッジに置いたプロジェクトを開き、新しいチャットを始めます
            {work.pdfPlace.trim() ? `（${work.pdfPlace.trim()}）` : ''}。
          </li>
          <li>依頼文をコピーして貼り付け、送ります。</li>
          <li>答えの最後のコードブロックまでコピーして、「結果を貼り付け」に貼ります。</li>
        </ol>
        <button
          type="button"
          className={`btn bw-copy${copied ? ' is-copied' : ''}`}
          onClick={() => void copy()}
          disabled={viewpoints.length === 0}
          data-testid="bench-manual-copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          依頼文をコピー（観点 {viewpoints.length}つ）
        </button>
        {viewpoints.length === 0 ? <p className="small cl-error">観点を1つ以上選んでください</p> : null}
        <details className="bw-prompt-preview">
          <summary>依頼文を見る</summary>
          <pre data-testid="bench-manual-prompt">{prompt}</pre>
        </details>
      </div>
    </Modal>
  )
}
