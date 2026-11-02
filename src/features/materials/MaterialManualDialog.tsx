// 資料の画面の「Claude に頼む（手動）」: コネクタを使わずに、資料の PDF を置いた claude.ai のプロジェクトのチャットに
// 貼り付ける依頼文をコピーする（本文は送らない。PDF はプロジェクトのナレッジにある）。項目は選べて（既定は決まった4つ）、足すこともできる。
// Claude の答えの最後のコードブロックは「結果を貼り付け」で記録として取り込む（PasteResultDialog）。
// 相対比較の BenchManualDialog と同じ作り。
import { useMemo, useState } from 'react'
import { jstDate } from '../../claude/dates'
import { DEFAULT_MATERIAL_SECTIONS, materialNotesPrompt } from '../../claude/prompts'
import { MATERIAL_LIMITS, materialName, materialSectionSuggestions } from '../../domain/materialOps'
import type { Material } from '../../domain/types'
import { useData } from '../../store/appStore'
import { copyText } from '../../ui/browser'
import { CheckIcon, CopyIcon, PlusIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { PasteIcon } from '../claude/claudeIcons'
import './materials.css'

export interface MaterialManualDialogProps {
  material: Material
  onClose: () => void
  /** 「結果を貼り付け」を開く（閉じてから開く） */
  onPaste: () => void
}

export function MaterialManualDialog({ material, onClose, onPaste }: MaterialManualDialogProps) {
  const materialNotes = useData().materialNotes
  const options = useMemo(() => {
    const used = materialSectionSuggestions({ materialNotes })
    return [
      ...DEFAULT_MATERIAL_SECTIONS,
      ...used.filter((s) => !(DEFAULT_MATERIAL_SECTIONS as readonly string[]).includes(s)),
    ] as string[]
  }, [materialNotes])
  const [extra, setExtra] = useState<string[]>([])
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_MATERIAL_SECTIONS))
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const all = [...options, ...extra.filter((s) => !options.includes(s))]
  const sections = all.filter((s) => chosen.has(s))
  const today = jstDate(Date.now())
  const prompt = useMemo(() => materialNotesPrompt(material, sections, today), [material, sections.join('\u0000'), today]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (s: string) => {
    setCopied(false)
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }
  const addSection = () => {
    const s = draft.trim()
    if (!s) return
    if (!all.includes(s)) setExtra((list) => [...list, s])
    setChosen((prev) => new Set(prev).add(s))
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
            data-testid="material-manual-open-paste"
          >
            <PasteIcon />
            結果を貼り付け
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="material-manual-close">
            閉じる
          </button>
        </>
      }
    >
      <div className="stack mt-manual" data-testid="material-manual-dialog">
        <p className="small muted mt-lead">
          コネクタを使わずに、『{materialName(material)}』の PDF を置いた claude.ai
          のプロジェクトで読んでもらい、項目ごとに記録してもらいます。PDF
          はプロジェクトのナレッジにあるので、本文は送りません。答えの最後のコードブロックを「結果を貼り付け」で取り込めます。
        </p>
        <div className="field">
          <span id="mt-manual-sections">記録する項目</span>
          <div className="mt-suggest" role="group" aria-labelledby="mt-manual-sections">
            {all.map((s) => (
              <button
                key={s}
                type="button"
                className={`mt-suggest-chip${chosen.has(s) ? ' is-on' : ''}`}
                aria-pressed={chosen.has(s)}
                onClick={() => toggle(s)}
                data-testid="material-manual-section"
              >
                {chosen.has(s) ? <CheckIcon /> : null}
                {s}
              </button>
            ))}
          </div>
        </div>
        <form
          className="mt-add-section"
          onSubmit={(e) => {
            e.preventDefault()
            addSection()
          }}
        >
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MATERIAL_LIMITS.section}
            placeholder="項目を足す（例：用語集）"
            aria-label="足す項目"
            data-testid="material-manual-new-section"
          />
          <button type="submit" className="btn" disabled={!draft.trim()} data-testid="material-manual-add-section">
            <PlusIcon />
            足す
          </button>
        </form>
        <ol className="cl-manual-steps small muted">
          <li>
            claude.ai で、資料の PDF をナレッジに置いたプロジェクトを開き、新しいチャットを始めます
            {material.pdfPlace.trim() ? `（${material.pdfPlace.trim()}）` : ''}。
          </li>
          <li>依頼文をコピーして貼り付け、送ります。</li>
          <li>
            答えの最後のコードブロックまでコピーして、「結果を貼り付け」に貼ります（答えが項目ごとに分かれた時は、答えごとに貼ります）。
          </li>
        </ol>
        <button
          type="button"
          className={`btn mt-copy${copied ? ' is-copied' : ''}`}
          onClick={() => void copy()}
          disabled={sections.length === 0}
          data-testid="material-manual-copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          依頼文をコピー（項目 {sections.length}つ）
        </button>
        {sections.length === 0 ? <p className="small cl-error">項目を1つ以上選んでください</p> : null}
        <details className="mt-prompt-preview">
          <summary>依頼文を見る</summary>
          <pre data-testid="material-manual-prompt">{prompt}</pre>
        </details>
      </div>
    </Modal>
  )
}
