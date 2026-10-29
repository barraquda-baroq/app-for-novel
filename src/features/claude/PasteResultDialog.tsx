// 「結果を貼り付け」: Claude の答え（最後の ```novel-studio-v1 のコードブロック）を読み、1件ごとの結果
// （追加・重複・以前に削除・見つからない・場所が決まらない・形が違う）を見せてから［追加］で記録にする。
// 作り方はコネクタと同じ（src/claude/records.ts。id は内容から作るので、同じ答えを2回貼り付けても増えない）。
// 作品批評では、コードブロックが無ければ答えの Markdown をそのまま結果にする（アーティファクトの URL も入れられる）。
import { useDeferredValue, useMemo, useState } from 'react'
import { critiquePromptsOf } from '../../claude/order'
import { previewPaste, type PastePreview } from '../../claude/paste'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { Modal } from '../../ui/Modal'
import { ITEM_STATUS_LABELS, itemStatusTone } from './claudeUi'
import './claude.css'

/** 1つの呼び出しで一覧に出す件数の上限（それ以上は数だけ） */
const MAX_ITEMS_SHOWN = 120

export interface PasteResultDialogProps {
  titleId: ID
  /** 作品批評: コードブロックが無ければ Markdown をそのまま結果にする */
  critique?: boolean
  /** 作品批評で最初に選んでおくプロンプト */
  promptId?: ID | null
  onClose: () => void
  /** 追加した後（作った記録の数） */
  onAdded?: (count: number) => void
}

export function PasteResultDialog({ titleId, critique, promptId, onClose, onAdded }: PasteResultDialogProps) {
  const data = useData()
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const prompts = useMemo(() => critiquePromptsOf(data, titleId), [data, titleId])
  const [prompt, setPrompt] = useState<string>(promptId ?? '')
  const deferredText = useDeferredValue(text)
  const deferredUrl = useDeferredValue(url)
  const preview: PastePreview | null = useMemo(() => {
    if (!deferredText.trim() && !(critique && deferredUrl.trim())) return null
    return previewPaste(data, deferredText, {
      titleId,
      now: Date.now(),
      ...(critique ? { plainCritique: { promptId: prompt || null, artifactUrl: deferredUrl } } : {}),
    })
  }, [data, deferredText, deferredUrl, prompt, titleId, critique])
  const created = preview?.ok ? preview.created : 0

  const add = () => {
    // 押した時のデータで作り直す（開いている間に同期で届いたものと重ならないように）
    const fresh = previewPaste(getData(), text, {
      titleId,
      now: Date.now(),
      ...(critique ? { plainCritique: { promptId: prompt || null, artifactUrl: url } } : {}),
    })
    if (!fresh.ok) return
    const ids = attempt(() => actions.addClaudeRecords(fresh.records))
    if (!ids) return
    const n = ids.filter((id) => !getData().proofBatches[id]).length
    notify(n > 0 ? `${n}件を追加しました` : '新しく追加するものはありませんでした（もうあります）')
    onAdded?.(n)
    onClose()
  }

  return (
    <Modal
      title="結果を貼り付け"
      wide
      onClose={onClose}
      initialFocus="textarea"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={add} disabled={created === 0} data-testid="paste-add">
            {created > 0 ? `追加（${created}件）` : '追加'}
          </button>
        </>
      }
    >
      <div className="cl-paste" data-testid="paste-dialog">
        <p className="small muted cl-lead">
          Claude の答えを最後のコードブロック（```novel-studio-v1）まで、そのまま貼り付けてください。
          {critique ? 'コードブロックが無ければ、答えの全体を批評の結果として残します。' : ''}
          同じ答えを2回貼り付けても、同じものは増えません。
        </p>
        <label className="field">
          <span>Claude の答え</span>
          <textarea
            className="textarea cl-paste-input"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'…\n```novel-studio-v1\n{"tool": "…", "input": {…}}\n```'}
            spellCheck={false}
            data-testid="paste-input"
          />
        </label>
        {critique ? (
          <div className="cl-paste-critique">
            <label className="field">
              <span>使ったプロンプト（コードブロックが無い時）</span>
              <select className="select" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="paste-prompt">
                <option value="">プロンプトなし</option>
                {[...prompts.title, ...prompts.shared].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name.trim() || '（名前のないプロンプト）'}
                    {p.titleId === null ? '（共通）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>アーティファクトの URL（任意・https）</span>
              <input
                className="input"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://claude.ai/…"
                data-testid="paste-url"
              />
            </label>
          </div>
        ) : null}
        <PastePreviewView preview={preview} />
      </div>
    </Modal>
  )
}

function PastePreviewView({ preview }: { preview: PastePreview | null }) {
  if (!preview) return null
  if (!preview.ok)
    return (
      <p className="cl-error" role="alert" data-testid="paste-error">
        {preview.error}
      </p>
    )
  return (
    <div className="cl-preview" aria-live="polite" data-testid="paste-preview">
      {preview.plain ? <p className="small muted">コードブロックが無いので、貼り付けた文をそのまま批評の結果にします。</p> : null}
      {preview.calls.map((c, ci) => (
        <section key={ci} className="cl-preview-call" data-testid="paste-call">
          <h3 className="cl-preview-head">
            {c.label}
            <span className="cl-preview-sum" data-testid="paste-summary">
              {c.summary}
            </span>
          </h3>
          {!c.result.ok ? (
            <p className="cl-error">
              {c.result.error}
              {c.result.candidates?.length ? <span className="cl-cands">候補: {c.result.candidates.join('、')}</span> : null}
            </p>
          ) : (
            <ul className="cl-preview-items">
              {c.result.items.slice(0, MAX_ITEMS_SHOWN).map((it, i) => (
                <li
                  key={i}
                  className={`cl-preview-item is-${itemStatusTone(it.status)}`}
                  data-testid="paste-item"
                  data-status={it.status}
                >
                  <span className={`badge cl-status is-${itemStatusTone(it.status)}`}>{ITEM_STATUS_LABELS[it.status]}</span>
                  <span className="cl-preview-label">{it.label}</span>
                  {it.hint ? <span className="cl-preview-hint">{it.hint}</span> : null}
                  {it.candidates?.length ? <span className="cl-cands">候補: {it.candidates.join('、')}</span> : null}
                </li>
              ))}
              {c.result.items.length > MAX_ITEMS_SHOWN ? (
                <li className="small muted">ほか {c.result.items.length - MAX_ITEMS_SHOWN}件</li>
              ) : null}
            </ul>
          )}
          {c.result.notes.length ? (
            <ul className="cl-notes small muted">
              {c.result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  )
}
