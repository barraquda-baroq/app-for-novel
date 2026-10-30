// 「Claude に頼む（手動）」: コネクタを使わずに、依頼文と採用原稿をコピーして claude.ai に貼り付ける。
// 依頼（ワードサーチ・作品批評・戦略）と範囲（タイトル全体・章・話の範囲）を選ぶと、依頼文と本文（コネクタが返すのと同じ形）を
// 50,000 字以内のパートに分ける（「パート 1/6 をコピー」）。iPhone などで添付するときのために「.txt で保存」も出す。
// Claude の答えの最後のコードブロックを「結果を貼り付け」で取り込む（PasteResultDialog.tsx）。
import { useMemo, useState } from 'react'
import { jstDate } from '../../claude/dates'
import { critiquePromptsOf } from '../../claude/order'
import { buildManualParts, MANUAL_TASK_LABELS, type ManualTask } from '../../claude/prompts'
import { readingOrder } from '../../claude/refs'
import { benchWorksOfTitle } from '../../domain/benchOps'
import { chaptersOf } from '../../domain/structure'
import type { ID } from '../../domain/types'
import { useData } from '../../store/appStore'
import { saveTextFile } from '../../platform/saveFile'
import { copyText } from '../../ui/browser'
import { CheckIcon, CopyIcon, DownloadIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { PasteIcon } from './claudeIcons'
import { manualFileName, partSizeLabel, resolveRange, type RangeKind } from './claudeUi'
import './claude.css'

const ALL_TASKS: ManualTask[] = ['proofreading', 'critique', 'strategy']

const TASK_HINTS: Record<ManualTask, string> = {
  proofreading: '作者の癖・既成表現・誤字脱字・ら抜き・い抜きなどを洗い出して、推敲案の一覧にしてもらいます。',
  critique: '批評プロンプトのとおりに、採用原稿で作品を批評してもらいます。結果は作品批評に日付ごとに残ります。',
  strategy:
    '目次・全体戦略・応募計画と採用原稿から、今後の戦略（狙うコンテストなど）を考えてもらいます。戦略メモとして残ります。',
}

/** 作品批評でプロンプトを使わない時の値 */
const NO_PROMPT = ''

export interface ManualDialogProps {
  titleId: ID
  /** 最初に選んでおく依頼 */
  task: ManualTask
  /** 選べる依頼（省略ですべて） */
  tasks?: readonly ManualTask[]
  /** 作品批評で最初に選んでおくプロンプト */
  promptId?: ID | null
  onClose: () => void
  /** 「結果を貼り付け」を開く（閉じてから開く。作品批評なら、いま選んでいるプロンプト。「プロンプトなし」は null） */
  onPaste?: (task: ManualTask, promptId: ID | null) => void
}

export function ManualDialog({ titleId, task: initialTask, tasks = ALL_TASKS, promptId, onClose, onPaste }: ManualDialogProps) {
  const data = useData()
  const title = data.titles[titleId]
  const [task, setTask] = useState<ManualTask>(initialTask)
  const [kind, setKind] = useState<RangeKind>('all')
  const chapters = useMemo(() => (title?.chaptersEnabled ? chaptersOf(data, titleId) : []), [data, title, titleId])
  const [chapterId, setChapterId] = useState<ID | null>(null)
  const order = useMemo(() => readingOrder(data, titleId), [data, titleId])
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(() => Math.max(1, order.length))
  const prompts = useMemo(() => critiquePromptsOf(data, titleId), [data, titleId])
  const [prompt, setPrompt] = useState<string>(() => promptId ?? prompts.title[0]?.id ?? prompts.shared[0]?.id ?? NO_PROMPT)
  const [includeText, setIncludeText] = useState(true)
  // 作品批評: 比べるベンチ作品の分析も入れる（比べる作品を選んでいれば、はじめから入れる）
  const bench = useMemo(() => benchWorksOfTitle(data, titleId), [data, titleId])
  const [includeBench, setIncludeBench] = useState(true)
  const benchWorkIds = task === 'critique' && includeBench && bench.length ? bench.map((w) => w.id) : undefined
  const [copied, setCopied] = useState<ReadonlySet<number>>(() => new Set())
  const today = jstDate(Date.now())

  const range = useMemo(
    () => resolveRange(data, titleId, { kind, chapterId: chapterId ?? chapters[0]?.id ?? null, from, to }),
    [data, titleId, kind, chapterId, chapters, from, to],
  )
  const chosenPrompt = prompt ? (data.critiquePrompts[prompt] ?? null) : null
  const result = useMemo(
    () =>
      title
        ? buildManualParts(data, titleId, {
            task,
            selection: range.selection,
            rangeLabel: range.rangeLabel,
            scope: range.scope,
            prompt: task === 'critique' ? chosenPrompt : undefined,
            today,
            includeText,
            ...(benchWorkIds ? { benchWorkIds } : {}),
          })
        : null,
    [data, title, titleId, task, range, chosenPrompt, today, includeText, benchWorkIds?.join(',')], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 選び直したら、コピーした印を消す
  const key = `${task}|${kind}|${chapterId}|${from}|${to}|${prompt}|${includeText}|${benchWorkIds?.join(',') ?? ''}`
  const [copiedKey, setCopiedKey] = useState(key)
  if (copiedKey !== key) {
    setCopiedKey(key)
    setCopied(new Set())
  }

  if (!title) return null
  const parts = result?.ok ? result.parts : []

  const copyPart = async (i: number) => {
    const ok = await copyText(parts[i], `パート ${i + 1}/${parts.length} をコピーしました`)
    if (ok) setCopied((prev) => new Set(prev).add(i))
  }

  const saveTxt = () => {
    // ファイルは1つにまとめる（添付なら長さの上限が無いので、パートに分けない）
    const whole = buildManualParts(data, titleId, {
      task,
      selection: range.selection,
      rangeLabel: range.rangeLabel,
      scope: range.scope,
      prompt: task === 'critique' ? chosenPrompt : undefined,
      today,
      includeText,
      partChars: Number.MAX_SAFE_INTEGER,
      ...(benchWorkIds ? { benchWorkIds } : {}),
    })
    if (!whole.ok) return
    void saveTextFile(manualFileName(title.name, task, today), whole.parts.join('\n\n'))
  }

  return (
    <Modal
      title="Claude に頼む（手動）"
      wide
      onClose={onClose}
      footer={
        <>
          {onPaste ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose()
                onPaste(task, task === 'critique' ? prompt || null : null)
              }}
              data-testid="manual-open-paste"
            >
              <PasteIcon />
              結果を貼り付け
            </button>
          ) : null}
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="manual-close">
            閉じる
          </button>
        </>
      }
    >
      <div className="cl-manual" data-testid="manual-dialog">
        <p className="small muted cl-lead">
          コネクタを使わずに、依頼文と本文をコピーして claude.ai
          のチャットに貼り付けます。答えの最後のコードブロックを「結果を貼り付け」で取り込めます。
        </p>

        {tasks.length > 1 ? (
          <div className="field">
            <span id="cl-manual-task">依頼</span>
            <div className="segmented cl-seg" role="group" aria-labelledby="cl-manual-task">
              {tasks.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={task === t}
                  onClick={() => setTask(t)}
                  data-testid={`manual-task-${t}`}
                >
                  {MANUAL_TASK_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="cl-manual-task-one">
            <strong>{MANUAL_TASK_LABELS[task]}</strong>
          </p>
        )}
        <p className="small muted cl-manual-hint">{TASK_HINTS[task]}</p>

        {task === 'critique' ? (
          <label className="field">
            <span>批評プロンプト</span>
            <select className="select" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="manual-prompt">
              {prompts.title.length ? (
                <optgroup label="このタイトルのプロンプト">
                  {prompts.title.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name.trim() || '（名前のないプロンプト）'}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {prompts.shared.length ? (
                <optgroup label="共通のプロンプト">
                  {prompts.shared.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name.trim() || '（名前のないプロンプト）'}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <option value={NO_PROMPT}>プロンプトを使わない（「この作品を批評してください」）</option>
            </select>
          </label>
        ) : null}

        <div className="field">
          <span id="cl-manual-range">範囲（採用原稿）</span>
          <div className="segmented cl-seg" role="group" aria-labelledby="cl-manual-range">
            <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')} data-testid="manual-range-all">
              タイトル全体
            </button>
            {chapters.length ? (
              <button
                type="button"
                aria-pressed={kind === 'chapter'}
                onClick={() => setKind('chapter')}
                data-testid="manual-range-chapter"
              >
                章
              </button>
            ) : null}
            <button
              type="button"
              aria-pressed={kind === 'pieces'}
              onClick={() => setKind('pieces')}
              disabled={order.length === 0}
              data-testid="manual-range-pieces"
            >
              話の範囲
            </button>
          </div>
        </div>
        {kind === 'chapter' && chapters.length ? (
          <label className="field">
            <span>章</span>
            <select
              className="select"
              value={chapterId ?? chapters[0].id}
              onChange={(e) => setChapterId(e.target.value)}
              data-testid="manual-chapter"
            >
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name.trim() || '無題の章'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'pieces' && order.length ? (
          <div className="cl-manual-pieces">
            <label className="field">
              <span>から</span>
              <select className="select" value={from} onChange={(e) => setFrom(Number(e.target.value))} data-testid="manual-from">
                {order.map((o) => (
                  <option key={o.piece.id} value={o.index}>
                    #{o.index} {o.fullLabel}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>まで</span>
              <select className="select" value={to} onChange={(e) => setTo(Number(e.target.value))} data-testid="manual-to">
                {order.map((o) => (
                  <option key={o.piece.id} value={o.index}>
                    #{o.index} {o.fullLabel}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {task === 'critique' && bench.length ? (
          <label className="check cl-manual-check">
            <input
              type="checkbox"
              checked={includeBench}
              onChange={(e) => setIncludeBench(e.target.checked)}
              data-testid="manual-include-bench"
            />
            比べるベンチ作品の分析も入れる（{bench.map((w) => `『${w.name.trim() || '無題'}』`).join('')}）
          </label>
        ) : null}
        {task === 'strategy' ? (
          <label className="check cl-manual-check">
            <input
              type="checkbox"
              checked={includeText}
              onChange={(e) => setIncludeText(e.target.checked)}
              data-testid="manual-include-text"
            />
            採用原稿の本文も送る（外すと目次・全体戦略・応募計画だけ）
          </label>
        ) : null}

        <div className="cl-manual-out" aria-live="polite">
          {!result ? null : !result.ok ? (
            <p className="cl-error" role="alert">
              {result.error}
            </p>
          ) : (
            <>
              <p className="cl-manual-sum" data-testid="manual-summary">
                {range.rangeLabel}・全 {parts.length} パート（合計 {partSizeLabel(result.totalChars)}）
              </p>
              <ol className="cl-manual-steps small muted">
                <li>claude.ai で新しいチャットを開きます。</li>
                <li>
                  {parts.length > 1
                    ? 'パート 1 から順にコピーして貼り付け、送ります（最後のパートを送ると Claude が作業を始めます）。'
                    : 'コピーして貼り付け、送ります。'}
                </li>
                <li>答えの最後のコードブロックまでコピーして、「結果を貼り付け」に貼ります。</li>
              </ol>
              <ul className="cl-parts" data-testid="manual-parts">
                {parts.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className={`btn cl-part${copied.has(i) ? ' is-copied' : ''}`}
                      onClick={() => void copyPart(i)}
                      data-testid="manual-copy-part"
                    >
                      {copied.has(i) ? <CheckIcon /> : <CopyIcon />}
                      パート {i + 1}/{parts.length} をコピー
                      <span className="cl-part-size">{partSizeLabel(p.length)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost cl-save-txt" onClick={saveTxt} data-testid="manual-save-txt">
                <DownloadIcon />
                .txt で保存（1つのファイルにまとめる。添付して送る時に）
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
