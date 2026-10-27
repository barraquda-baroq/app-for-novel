// 設定項目の追加ダイアログと、フィールドのテンプレート編集ダイアログ。
import { useId, useMemo, useState } from 'react'
import { entriesOf } from '../../../domain/entityOps'
import type { ID, SettingCategory } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { Modal } from '../../../ui/Modal'
import { commitFields } from './commits'
import { addMissingTemplateFields, CATEGORY_PRESETS, categoryDisplayName, parseTemplate, templateToText } from './settingsLogic'

const TEMPLATE_HELP = '新しく作るエントリに最初から用意される項目です。1行に1つずつ書きます（空欄でもかまいません）。'

export function AddCategoryDialog({
  titleId,
  existing,
  onClose,
  onAdded,
}: {
  titleId: ID
  existing: SettingCategory[]
  onClose: () => void
  onAdded: (categoryId: ID) => void
}) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('')
  const formId = useId()
  const trimmed = name.trim()
  const preset = CATEGORY_PRESETS.find((p) => p.name === trimmed)
  const duplicate = trimmed !== '' && existing.some((c) => c.name.trim() === trimmed)

  const submit = () => {
    if (!trimmed) return
    const id = attempt(() => actions.addCategory(titleId, trimmed, parseTemplate(template)))
    if (!id) return
    notify(`設定項目「${trimmed}」を追加しました`)
    onAdded(id)
  }

  return (
    <Modal
      title="設定項目を追加"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!trimmed} data-testid="category-submit">
            追加
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack st-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-testid="add-category-dialog"
      >
        <label className="field">
          <span>項目名</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：キャラクター、魔法体系、舞台となる学校"
            maxLength={40}
            data-testid="category-name-input"
          />
        </label>
        {duplicate ? (
          <p className="small st-dialog-note is-warn">同じ名前の項目がすでにあります（このまま追加することもできます）。</p>
        ) : null}

        <div className="field">
          <span className="field-label" id={`${formId}-presets`}>
            よく使う項目から選ぶ
          </span>
          <div className="st-presets" role="group" aria-labelledby={`${formId}-presets`}>
            {CATEGORY_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="st-preset"
                aria-pressed={preset?.name === p.name}
                onClick={() => {
                  setName(p.name)
                  setTemplate(templateToText(p.fieldTemplate))
                }}
                data-testid="category-preset"
              >
                <strong>{p.name}</strong>
                <span>{p.hint}</span>
              </button>
            ))}
          </div>
          <p className="small muted st-dialog-note">名前は自由に付けられます。選んだあとに書き換えてもかまいません。</p>
        </div>

        <label className="field">
          <span>フィールドのテンプレート（任意）</span>
          <textarea
            className="textarea st-template-input"
            rows={4}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={'例：\n読み\n年齢\n性格'}
            data-testid="category-template-input"
          />
        </label>
        <p className="small muted st-dialog-note">{TEMPLATE_HELP}</p>
      </form>
    </Modal>
  )
}

export function TemplateDialog({ category, onClose }: { category: SettingCategory; onClose: () => void }) {
  const [text, setText] = useState(() => templateToText(category.fieldTemplate))
  const [fillExisting, setFillExisting] = useState(false)
  const formId = useId()
  const entryCount = useMemo(() => entriesOf(getData(), category.id).length, [category.id])
  const name = categoryDisplayName(category.name)

  const save = () => {
    const fieldTemplate = parseTemplate(text)
    if (attempt(() => (actions.updateCategory(category.id, { fieldTemplate }), true)) !== true) return
    let filled = 0
    if (fillExisting) {
      for (const e of entriesOf(getData(), category.id)) {
        if (commitFields(e.id, (fields) => addMissingTemplateFields(fields, fieldTemplate))) filled += 1
      }
    }
    notify(filled > 0 ? `テンプレートを保存し、${filled}件のエントリに項目を追加しました` : 'テンプレートを保存しました')
    onClose()
  }

  return (
    <Modal
      title={`「${name}」のテンプレート`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="template-save">
            保存
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack st-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        data-testid="template-dialog"
      >
        <p className="small st-dialog-lead">{TEMPLATE_HELP}</p>
        <label className="field">
          <span>フィールド名（1行に1つ）</span>
          <textarea
            className="textarea st-template-input"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'例：\n読み\n年齢\n性格'}
            data-testid="template-input"
          />
        </label>
        <p className="small muted st-dialog-note">テンプレートを変えても、すでにあるエントリの内容はそのままです。</p>
        {entryCount > 0 ? (
          <label className="check small">
            <input
              type="checkbox"
              checked={fillExisting}
              onChange={(e) => setFillExisting(e.target.checked)}
              data-testid="template-fill"
            />
            既存のエントリ（{entryCount}件）にも、足りない項目を追加する
          </label>
        ) : null}
      </form>
    </Modal>
  )
}
