// アイデアの追加・編集ダイアログ。見出し（任意）と内容。Ctrl/⌘+Enter で保存。
import { useId, useRef, useState } from 'react'
import { confirmDialog } from '../../ui/dialogs'
import { Modal } from '../../ui/Modal'
import { canSaveIdea, isSubmitShortcut, submitShortcutLabel } from './ideaLogic'

export interface IdeaEditorModalProps {
  mode: 'add' | 'edit'
  /** 追加先・現在の仕切りの名前 */
  sectionName: string
  initialHeading?: string
  initialBody?: string
  onSave: (heading: string, body: string) => void
  onClose: () => void
}

export function IdeaEditorModal({ mode, sectionName, initialHeading = '', initialBody = '', onSave, onClose }: IdeaEditorModalProps) {
  const formId = useId()
  const [heading, setHeading] = useState(initialHeading)
  const [body, setBody] = useState(initialBody)
  const confirming = useRef(false)
  const canSave = canSaveIdea(heading, body)
  const dirty = heading !== initialHeading || body !== initialBody

  const save = () => {
    if (!canSave) return
    onSave(heading.trim(), body.replace(/\s+$/u, ''))
  }

  // 書きかけの内容をうっかり閉じて失わないようにする
  const requestClose = async () => {
    if (confirming.current) return
    if (!dirty) {
      onClose()
      return
    }
    confirming.current = true
    const ok = await confirmDialog({
      title: '編集中の内容を破棄しますか？',
      message: mode === 'add' ? '入力したアイデアは追加されません。' : '変更は保存されません。',
      confirmLabel: '破棄する',
      cancelLabel: '編集を続ける',
      danger: true,
    })
    confirming.current = false
    if (ok) onClose()
  }

  return (
    <Modal
      title={mode === 'add' ? 'アイデアを追加' : 'アイデアを編集'}
      onClose={() => void requestClose()}
      initialFocus={mode === 'edit' && initialHeading === '' && initialBody !== '' ? 'textarea' : undefined}
      footer={
        <>
          <span className="idea-editor-hint hide-mobile">{submitShortcutLabel()} で保存</span>
          <button type="button" className="btn" onClick={() => void requestClose()} data-testid="idea-cancel">
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!canSave} data-testid="idea-save">
            {mode === 'add' ? '追加' : '保存'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack idea-editor"
        data-testid="idea-editor"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        onKeyDown={(e) => {
          if (isSubmitShortcut({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })) {
            e.preventDefault()
            save()
          }
        }}
      >
        <p className="idea-editor-place">
          <span className="idea-editor-place-label">{mode === 'add' ? '追加先' : '場所'}</span>
          <span className="idea-editor-place-name">{sectionName}</span>
        </p>
        <label className="field">
          <span>見出し（任意）</span>
          <input
            className="input"
            value={heading}
            onChange={(e) => setHeading(e.target.value)}
            placeholder="例: 記憶を売る古書店"
            data-testid="idea-heading-input"
          />
        </label>
        <label className="field">
          <span>内容</span>
          <textarea
            className="textarea idea-editor-body"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="思いついたこと、場面、台詞、設定の種など"
            data-testid="idea-body-input"
          />
        </label>
      </form>
    </Modal>
  )
}
