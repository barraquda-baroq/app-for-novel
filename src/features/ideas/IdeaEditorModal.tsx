// アイデアの追加・編集ダイアログ。入力欄は内容だけ（見出しはない）。Ctrl/⌘+Enter で保存。
// 古い版で見出しを付けたアイデアは、見出しを内容の1行目にまとめた形で開く（保存するまで元のデータは変えない）。
// 入力中の内容はこの端末に下書きとして残し、戻る操作やアプリを閉じても、次に同じダイアログを開いた時に戻せる。
import { useId, useRef, useState } from 'react'
import { confirmDialog } from '../../ui/dialogs'
import { Modal } from '../../ui/Modal'
import { canSaveIdea, isSubmitShortcut, parseIdeaModalDraft, serializeIdeaModalDraft, submitShortcutLabel } from './ideaLogic'
import { readLocal, writeLocal } from './storage'

export interface IdeaEditorModalProps {
  mode: 'add' | 'edit'
  /** 追加先・現在の仕切りの名前 */
  sectionName: string
  /** 開いた時の内容（編集: ideaEditText。見出しのあるアイデアは見出しを1行目にまとめたもの） */
  initialBody?: string
  /** 見出しを1行目にまとめて開いた（古い版で見出しを付けたアイデア）。その旨を添える */
  mergedHeading?: boolean
  /** 書きかけを保存するキー（ideaModalDraftKey）。省略すると保存しない */
  draftKey?: string
  onSave: (body: string) => void
  onClose: () => void
}

export function IdeaEditorModal({
  mode,
  sectionName,
  initialBody = '',
  mergedHeading = false,
  draftKey,
  onSave,
  onClose,
}: IdeaEditorModalProps) {
  const formId = useId()
  const noteId = useId()
  // 前回閉じた時の書きかけがあれば、そこから続ける
  const [restored] = useState(() => {
    const draft = draftKey ? parseIdeaModalDraft(readLocal(draftKey)) : null
    return draft && draft.body !== initialBody ? draft : null
  })
  const [body, setBody] = useState(restored?.body ?? initialBody)
  const [restoredNotice, setRestoredNotice] = useState(restored !== null)
  const confirming = useRef(false)
  const canSave = canSaveIdea(body)
  const dirty = body !== initialBody

  /** 入力のたびにすぐ控える（閉じる・戻る・アプリの終了で失わないように） */
  const persist = (b: string) => {
    if (!draftKey) return
    writeLocal(draftKey, b !== initialBody ? serializeIdeaModalDraft(b) : null)
  }
  const clearDraft = () => {
    if (draftKey) writeLocal(draftKey, null)
  }

  const save = () => {
    if (!canSave) return
    clearDraft()
    onSave(body.replace(/\s+$/u, ''))
  }

  const discardRestored = () => {
    setBody(initialBody)
    setRestoredNotice(false)
    clearDraft()
  }

  // 書きかけの内容をうっかり閉じて失わないようにする
  const requestClose = async () => {
    if (confirming.current) return
    if (!dirty) {
      clearDraft()
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
    if (!ok) return
    clearDraft()
    onClose()
  }

  return (
    <Modal
      title={mode === 'add' ? 'アイデアを追加' : 'アイデアを編集'}
      onClose={() => void requestClose()}
      initialFocus="textarea"
      footer={
        <>
          <span className="idea-editor-hint hide-mobile hint-keyboard" data-testid="idea-editor-hint">
            {submitShortcutLabel()} で保存
          </span>
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
        {restoredNotice ? (
          <p className="idea-editor-restored" role="status" data-testid="idea-draft-restored">
            <span>下書きを復元しました</span>
            <button
              type="button"
              className="idea-editor-restored-discard"
              onClick={discardRestored}
              data-testid="idea-draft-discard"
            >
              {mode === 'add' ? '下書きを破棄' : '下書きを破棄して元に戻す'}
            </button>
          </p>
        ) : null}
        <label className="field">
          <span>内容</span>
          <textarea
            className="textarea idea-editor-body"
            rows={8}
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              persist(e.target.value)
            }}
            placeholder="思いついたこと、場面、台詞、設定の種など"
            aria-describedby={mergedHeading ? noteId : undefined}
            data-testid="idea-body-input"
          />
        </label>
        {mergedHeading ? (
          <p id={noteId} className="idea-editor-merged small muted" data-testid="idea-heading-merged">
            見出しは内容の1行目に入れました。保存するとこの形になります。
          </p>
        ) : null}
      </form>
    </Modal>
  )
}
