// 設定エントリ1件のカード。畳んでいる時は名前と要約、開くと名前・フィールド・自由記述を編集できる。
import { useState } from 'react'
import type { SettingCategory, SettingEntry } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { DraftInput } from '../../../ui/DraftField'
import { ChevronRightIcon, DownIcon, PlusIcon, TrashIcon, UpIcon, XIcon } from '../../../ui/icons'
import { commitEntry, commitFields } from './commits'
import { GrowTextarea } from './GrowTextarea'
import {
  appendField,
  categoryDisplayName,
  entryDisplayName,
  entrySummary,
  moveField,
  patchField,
  removeField,
} from './settingsLogic'

export interface EntryCardProps {
  entry: SettingEntry
  categories: SettingCategory[]
  isFirst: boolean
  isLast: boolean
  expanded: boolean
  onToggle: () => void
  /** 追加した直後のエントリは名前の欄にフォーカスする */
  autoFocusName: boolean
}

export function EntryCard({ entry, categories, isFirst, isLast, expanded, onToggle, autoFocusName }: EntryCardProps) {
  const [newFieldId, setNewFieldId] = useState<string | null>(null)
  const name = entryDisplayName(entry.name)
  const summary = entrySummary(entry)
  const others = categories.filter((c) => c.id !== entry.categoryId)
  const bodyId = `st-entry-${entry.id}`

  const addField = () => {
    let created: string | null = null
    const ok = commitFields(entry.id, (fields) => {
      const r = appendField(fields)
      created = r.fieldId
      return r.fields
    })
    if (ok) setNewFieldId(created)
  }

  const removeFieldWithConfirm = async (fieldId: string, label: string) => {
    const current = getData().settingEntries[entry.id]?.fields.find((f) => f.id === fieldId)
    if (!current) return
    if (current.value.trim()) {
      const ok = await confirmDialog({
        title: `フィールド「${label}」を削除しますか？`,
        message: '入力した内容も削除されます。',
        confirmLabel: '削除',
        danger: true,
      })
      if (!ok) return
    }
    commitFields(entry.id, (fields) => removeField(fields, fieldId))
  }

  const moveTo = (categoryId: string) => {
    const target = getData().settingCategories[categoryId]
    if (!target) return
    if (attempt(() => (actions.moveEntryToCategory(entry.id, categoryId), true))) {
      notify(
        `「${entryDisplayName(getData().settingEntries[entry.id]?.name ?? entry.name)}」を「${categoryDisplayName(target.name)}」へ移動しました`,
      )
    }
  }

  const remove = async () => {
    const latest = getData().settingEntries[entry.id] ?? entry
    const ok = await confirmDialog({
      title: `「${entryDisplayName(latest.name)}」を削除しますか？`,
      message: 'このエントリのフィールドと自由記述も削除されます。この操作は取り消せません。',
      confirmLabel: '削除',
      danger: true,
    })
    if (ok) attempt(() => actions.deleteEntry(entry.id))
  }

  return (
    <li className={`st-entry${expanded ? ' is-open' : ''}`} data-testid="entry-card" data-entry-id={entry.id}>
      <button
        type="button"
        className="st-entry-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
        data-testid="entry-toggle"
      >
        <ChevronRightIcon className="icon st-entry-chevron" />
        <span className="st-entry-heading">
          <span className={`st-entry-name${entry.name.trim() ? '' : ' is-empty'}`} data-testid="entry-name-label">
            {name}
          </span>
          {!expanded && summary ? (
            <span className="st-entry-summary" data-testid="entry-summary">
              {summary}
            </span>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className="st-entry-body" id={bodyId}>
          <label className="field">
            <span>名前</span>
            <DraftInput
              key={entry.id}
              className="input st-entry-name-input"
              value={entry.name}
              onCommit={(v) => commitEntry(entry.id, { name: v })}
              placeholder="名前（例：主人公の名前、用語、地名）"
              autoFocus={autoFocusName}
              data-testid="entry-name"
            />
          </label>

          <div className="st-fields">
            <span className="field-label">フィールド</span>
            {entry.fields.length === 0 ? (
              <p className="small muted st-fields-empty">
                フィールドはまだありません。「＋フィールドを追加」で年齢・読みなどの欄を作れます。
              </p>
            ) : (
              <ul className="st-field-list">
                {entry.fields.map((f, i) => {
                  const label = f.key.trim() || `フィールド${i + 1}`
                  return (
                    <li key={f.id} className="st-field" data-testid="entry-field">
                      <DraftInput
                        key={f.id}
                        className="input st-field-key"
                        value={f.key}
                        onCommit={(v) => commitFields(entry.id, (fields) => patchField(fields, f.id, { key: v }))}
                        placeholder="項目名"
                        aria-label={`フィールド${i + 1}の項目名`}
                        autoFocus={f.id === newFieldId}
                        data-testid="field-key"
                      />
                      <GrowTextarea
                        key={f.id}
                        className="textarea st-field-value"
                        value={f.value}
                        onCommit={(v) => commitFields(entry.id, (fields) => patchField(fields, f.id, { value: v }))}
                        placeholder="内容"
                        aria-label={`${label}の内容`}
                        data-testid="field-value"
                      />
                      <div className="st-field-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={i === 0}
                          onClick={() => commitFields(entry.id, (fields) => moveField(fields, f.id, -1))}
                          aria-label={`${label}を上へ`}
                          title="上へ"
                          data-testid="field-up"
                        >
                          <UpIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={i === entry.fields.length - 1}
                          onClick={() => commitFields(entry.id, (fields) => moveField(fields, f.id, 1))}
                          aria-label={`${label}を下へ`}
                          title="下へ"
                          data-testid="field-down"
                        >
                          <DownIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn st-danger-icon"
                          onClick={() => void removeFieldWithConfirm(f.id, label)}
                          aria-label={`${label}を削除`}
                          title="このフィールドを削除"
                          data-testid="field-remove"
                        >
                          <XIcon />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <button type="button" className="btn btn-sm st-add-field" onClick={addField} data-testid="add-field">
              <PlusIcon />
              フィールドを追加
            </button>
          </div>

          <label className="field">
            <span>自由記述</span>
            <GrowTextarea
              key={entry.id}
              className="textarea st-entry-free"
              rows={3}
              value={entry.body}
              onCommit={(v) => commitEntry(entry.id, { body: v })}
              placeholder="エピソード・関係性・設定の詳細など、自由に書けます"
              data-testid="entry-body"
            />
          </label>

          <div className="st-entry-actions">
            <div className="st-entry-order" role="group" aria-label="並べ替え">
              <button
                type="button"
                className="icon-btn"
                disabled={isFirst}
                onClick={() => attempt(() => actions.moveEntryStep(entry.id, -1))}
                aria-label="エントリを上へ"
                title="上へ"
                data-testid="entry-up"
              >
                <UpIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={isLast}
                onClick={() => attempt(() => actions.moveEntryStep(entry.id, 1))}
                aria-label="エントリを下へ"
                title="下へ"
                data-testid="entry-down"
              >
                <DownIcon />
              </button>
            </div>
            {others.length > 0 ? (
              <select
                className="select st-entry-move"
                value=""
                onChange={(e) => {
                  if (e.target.value) moveTo(e.target.value)
                }}
                aria-label="別の項目へ移動"
                data-testid="entry-move"
              >
                <option value="">別の項目へ移動…</option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryDisplayName(c.name)}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="grow" />
            <div className="st-entry-end">
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="entry-delete">
                <TrashIcon />
                削除
              </button>
              <button type="button" className="btn btn-sm" onClick={onToggle} data-testid="entry-close">
                閉じる
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}
