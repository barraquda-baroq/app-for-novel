// Promise で使える確認・入力ダイアログ。
//   if (await confirmDialog({ title: '削除しますか？', danger: true })) { ... }
//   const name = await promptDialog({ title: 'タイトル名', initial: '' })
//   const choice = await choiceDialog({ title: '…', choices: [{ value: 'save', label: '保存する', primary: true }, …] })
import { useId, useState } from 'react'
import { create } from 'zustand'
import { Modal } from './Modal'

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface PromptOptions {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  multiline?: boolean
  /** 空欄を許可するか（既定: 許可しない） */
  allowEmpty?: boolean
  /** 開いた時に初期値を全選択する（そのまま打ち直せるように）。選ばない時は、カーソルを初期値の後ろに置く */
  selectOnOpen?: boolean
  /** 入力欄の下に出す短い説明 */
  hint?: string
  /** 入力できる長さ（1行の入力欄だけ） */
  maxLength?: number
  /** 入力の確かめ。問題があればその文（入力欄の下に出し、OK を押せない）、無ければ null。空欄の時は呼ばない（allowEmpty を除く） */
  validate?: (value: string) => string | null
}

export interface Choice<T extends string> {
  value: T
  label: string
  /** 主な選択肢（青いボタン。開いた時にここへフォーカスする） */
  primary?: boolean
  /** 取り消せない選択肢（赤い文字のボタン） */
  danger?: boolean
  testId?: string
}

interface ChoiceOptions<T extends string> {
  title: string
  message?: string
  /** 左から順に並べる。Esc・背景・× で閉じた時は null になる */
  choices: Choice<T>[]
}

type DialogRequest =
  | {
      id: number
      kind: 'choice'
      opts: ChoiceOptions<string>
      resolve: (v: string | null) => void
    }
  | {
      id: number
      kind: 'confirm'
      opts: ConfirmOptions
      resolve: (v: boolean) => void
    }
  | {
      id: number
      kind: 'prompt'
      opts: PromptOptions
      resolve: (v: string | null) => void
    }

type NewRequest = DialogRequest extends infer R ? (R extends DialogRequest ? Omit<R, 'id'> : never) : never

let seq = 0

const useDialogs = create<{ queue: DialogRequest[] }>(() => ({ queue: [] }))

function enqueue(req: NewRequest) {
  const withId = { ...req, id: ++seq } as DialogRequest
  useDialogs.setState((s) => ({ queue: [...s.queue, withId] }))
}

function dequeue() {
  useDialogs.setState((s) => ({ queue: s.queue.slice(1) }))
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: 'confirm', opts, resolve }))
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', opts, resolve }))
}

/** 3つ以上の選択肢から選ぶダイアログ。閉じた（キャンセルした）時は null */
export function choiceDialog<T extends string>(opts: ChoiceOptions<T>): Promise<T | null> {
  return new Promise((resolve) =>
    enqueue({ kind: 'choice', opts: opts as ChoiceOptions<string>, resolve: resolve as (v: string | null) => void }),
  )
}

/** 開いている・待っているダイアログをすべてキャンセル扱いで閉じる（画面遷移時など） */
export function cancelAllDialogs(): void {
  const { queue } = useDialogs.getState()
  if (queue.length === 0) return
  useDialogs.setState({ queue: [] })
  for (const req of queue) {
    if (req.kind === 'confirm') req.resolve(false)
    else req.resolve(null)
  }
}

export function DialogHost() {
  const current = useDialogs((s) => s.queue[0])
  if (!current) return null
  if (current.kind === 'confirm') return <ConfirmView key={current.id} req={current} />
  if (current.kind === 'choice') return <ChoiceView key={current.id} req={current} />
  return <PromptView key={current.id} req={current} />
}

function ChoiceView({ req }: { req: Extract<DialogRequest, { kind: 'choice' }> }) {
  const { opts } = req
  const close = (v: string | null) => {
    dequeue()
    req.resolve(v)
  }
  return (
    <Modal
      title={opts.title}
      onClose={() => close(null)}
      initialFocus="[data-autofocus]"
      footer={
        <div className="dialog-choices">
          {opts.choices.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`btn${c.primary ? ' btn-primary' : c.danger ? ' btn-danger' : ''}`}
              onClick={() => close(c.value)}
              data-autofocus={c.primary ? true : undefined}
              data-testid={c.testId}
            >
              {c.label}
            </button>
          ))}
        </div>
      }
    >
      {opts.message ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{opts.message}</p> : null}
    </Modal>
  )
}

function ConfirmView({ req }: { req: Extract<DialogRequest, { kind: 'confirm' }> }) {
  const { opts } = req
  const close = (v: boolean) => {
    dequeue()
    req.resolve(v)
  }
  return (
    <Modal
      title={opts.title}
      onClose={() => close(false)}
      initialFocus="[data-autofocus]"
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(false)}>
            {opts.cancelLabel ?? 'キャンセル'}
          </button>
          <button
            type="button"
            className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => close(true)}
            data-autofocus
          >
            {opts.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {opts.message ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{opts.message}</p> : null}
    </Modal>
  )
}

function PromptView({ req }: { req: Extract<DialogRequest, { kind: 'prompt' }> }) {
  const { opts } = req
  const [value, setValue] = useState(opts.initial ?? '')
  const hintId = useId()
  const problemId = useId()
  const close = (v: string | null) => {
    dequeue()
    req.resolve(v)
  }
  const filled = opts.allowEmpty || value.trim().length > 0
  const problem = filled && opts.validate ? opts.validate(value) : null
  const canSubmit = filled && problem === null
  const submit = () => {
    if (canSubmit) close(value)
  }
  const describedBy = [opts.hint ? hintId : '', problem ? problemId : ''].filter(Boolean).join(' ') || undefined
  return (
    <Modal
      title={opts.title}
      onClose={() => close(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit} data-testid="prompt-ok">
            {opts.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="field">
          {opts.label ? <span>{opts.label}</span> : null}
          {opts.multiline ? (
            <textarea
              className="textarea"
              rows={5}
              value={value}
              placeholder={opts.placeholder}
              aria-describedby={describedBy}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <input
              className="input"
              value={value}
              placeholder={opts.placeholder}
              maxLength={opts.maxLength}
              aria-describedby={describedBy}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => {
                const el = e.currentTarget
                if (opts.selectOnOpen) el.select()
                // 初期値の後ろから続けて書けるように（「2026/11/13　」の後ろにテーマを書く）
                else el.setSelectionRange(el.value.length, el.value.length)
              }}
              data-testid="prompt-input"
            />
          )}
        </label>
        {opts.hint ? (
          <p id={hintId} className="dialog-hint small muted">
            {opts.hint}
          </p>
        ) : null}
        {problem ? (
          <p id={problemId} className="dialog-problem small" role="alert" data-testid="prompt-problem">
            {problem}
          </p>
        ) : null}
      </form>
    </Modal>
  )
}
