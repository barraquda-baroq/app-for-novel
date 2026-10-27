// Promise で使える確認・入力ダイアログ。
//   if (await confirmDialog({ title: '削除しますか？', danger: true })) { ... }
//   const name = await promptDialog({ title: 'タイトル名', initial: '' })
import { useState } from 'react'
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
}

type DialogRequest =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }

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

export function DialogHost() {
  const current = useDialogs((s) => s.queue[0])
  if (!current) return null
  if (current.kind === 'confirm') return <ConfirmView key={current.id} req={current} />
  return <PromptView key={current.id} req={current} />
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
  const close = (v: string | null) => {
    dequeue()
    req.resolve(v)
  }
  const canSubmit = opts.allowEmpty || value.trim().length > 0
  const submit = () => {
    if (canSubmit) close(value)
  }
  return (
    <Modal
      title={opts.title}
      onClose={() => close(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
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
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <input className="input" value={value} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} />
          )}
        </label>
      </form>
    </Modal>
  )
}
