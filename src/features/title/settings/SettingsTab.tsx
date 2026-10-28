// 設定タブ: キャラクター・世界観など、後から任意に追加できる「設定項目」と、その中のエントリ。
// 選んでいる項目は URL の ?cat=<id> に持つ（本編タブの設定チップからそのまま開ける）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { categoriesOf, entriesOf } from '../../../domain/entityOps'
import { trashNotice } from '../../../domain/trash'
import type { ID, SettingCategory } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { confirmDialog, promptDialog } from '../../../ui/dialogs'
import { DownIcon, EditIcon, ListIcon, PlusIcon, TrashIcon, UpIcon } from '../../../ui/icons'
import { ActionMenu } from './ActionMenu'
import { AddCategoryDialog, TemplateDialog } from './CategoryDialogs'
import { EntryCard } from './EntryCard'
import { categoryDisplayName } from './settingsLogic'
import './settings.css'

export function SettingsTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const [params, setParams] = useSearchParams()
  const categories = useMemo(() => categoriesOf(data, titleId), [data, titleId])
  const counts = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const c of categories) out[c.id] = 0
    for (const e of Object.values(data.settingEntries)) if (e.categoryId in out) out[e.categoryId] += 1
    return out
  }, [data, categories])

  const requested = params.get('cat')
  const selected = categories.find((c) => c.id === requested) ?? categories[0] ?? null
  const selectedId = selected?.id ?? null
  const entries = useMemo(() => (selectedId ? entriesOf(data, selectedId) : []), [data, selectedId])

  const [adding, setAdding] = useState(false)
  const [templateFor, setTemplateFor] = useState<ID | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<ID>>(() => new Set())
  const [justAdded, setJustAdded] = useState<ID | null>(null)
  const catListRef = useRef<HTMLUListElement>(null)

  // スマホの横スクロールのチップで、選んでいる項目が見えていなければ見える位置までずらす（ページ自体はスクロールしない）
  useEffect(() => {
    const list = catListRef.current
    if (!list || list.scrollWidth <= list.clientWidth) return
    const chip = list.querySelector<HTMLElement>('[aria-current="true"]')
    if (!chip) return
    const lr = list.getBoundingClientRect()
    const cr = chip.getBoundingClientRect()
    if (cr.left < lr.left || cr.right > lr.right) list.scrollLeft += cr.left - lr.left - (lr.width - cr.width) / 2
  }, [selectedId])

  const select = (categoryId: ID | null) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (categoryId) p.set('cat', categoryId)
        else p.delete('cat')
        return p
      },
      { replace: true },
    )
  }

  const toggle = (entryId: ID) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
    if (justAdded === entryId) setJustAdded(null)
  }

  const addEntry = () => {
    if (!selectedId) return
    const id = attempt(() => actions.addEntry(selectedId, ''))
    if (!id) return
    setExpanded((prev) => new Set(prev).add(id))
    setJustAdded(id)
  }

  const rename = async (c: SettingCategory) => {
    const name = await promptDialog({ title: '項目名を変更', label: '項目名', initial: c.name, confirmLabel: '変更' })
    if (name === null || name.trim() === c.name) return
    attempt(() => actions.updateCategory(c.id, { name: name.trim() }))
  }

  const remove = async (c: SettingCategory) => {
    const n = counts[c.id] ?? 0
    const ok = await confirmDialog({
      title: `設定項目「${categoryDisplayName(c.name)}」を削除しますか？`,
      message: n > 0 ? trashNotice(`この項目の中のエントリ（${n}件）もすべていっしょに`) : trashNotice(),
      confirmLabel: '削除',
      danger: true,
    })
    if (!ok) return
    const list = categoriesOf(getData(), titleId)
    const i = list.findIndex((x) => x.id === c.id)
    const neighbor = list[i + 1] ?? list[i - 1] ?? null
    if (attempt(() => (actions.deleteCategory(c.id), true))) {
      notify(`設定項目「${categoryDisplayName(c.name)}」をゴミ箱に移しました`)
      select(neighbor && neighbor.id !== c.id ? neighbor.id : null)
    }
  }

  const templateCategory = templateFor ? data.settingCategories[templateFor] : undefined
  const selectedIndex = selected ? categories.indexOf(selected) : -1

  return (
    <div className="st-tab" data-testid="settings-tab">
      {categories.length === 0 ? (
        <div className="empty st-empty" data-testid="settings-empty">
          <p>まだ設定項目がありません。</p>
          <p className="small">キャラクター・世界観・用語集など、作品に必要な項目を自由に追加できます。</p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-category">
            <PlusIcon />
            項目を追加
          </button>
        </div>
      ) : (
        <div className="st-layout">
          <nav className="st-cats" aria-label="設定項目">
            <div className="st-cats-head">
              <h2 className="st-cats-title">設定項目</h2>
              <button
                type="button"
                className="btn btn-sm st-add-category"
                onClick={() => setAdding(true)}
                data-testid="add-category"
              >
                <PlusIcon />
                項目を追加
              </button>
            </div>
            <ul className="st-cat-list" ref={catListRef}>
              {categories.map((c) => {
                const isSel = c.id === selectedId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`st-cat${isSel ? ' is-selected' : ''}`}
                      aria-current={isSel ? 'true' : undefined}
                      onClick={() => select(c.id)}
                      data-testid="category-item"
                    >
                      <span className="st-cat-name">{categoryDisplayName(c.name)}</span>
                      <span className="st-cat-count" aria-label={`${counts[c.id] ?? 0}件`}>
                        {counts[c.id] ?? 0}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {selected ? (
            <section className="st-main" aria-labelledby="st-main-heading" data-testid="category-panel">
              <div className="st-main-head">
                <h2 id="st-main-heading" className="st-main-title" data-testid="category-title">
                  {categoryDisplayName(selected.name)}
                </h2>
                <span className="badge st-main-count">{entries.length}件</span>
                <span className="grow" />
                <button type="button" className="btn btn-primary" onClick={addEntry} data-testid="add-entry">
                  <PlusIcon />
                  エントリを追加
                </button>
                <ActionMenu
                  label={`「${categoryDisplayName(selected.name)}」の操作`}
                  testId="category-menu"
                  items={[
                    { label: '名前を変更', icon: <EditIcon />, onSelect: () => void rename(selected), testId: 'category-rename' },
                    {
                      label: 'フィールドのテンプレートを編集',
                      icon: <ListIcon />,
                      onSelect: () => setTemplateFor(selected.id),
                      testId: 'category-template',
                    },
                    {
                      label: '上へ移動',
                      icon: <UpIcon />,
                      disabled: selectedIndex <= 0,
                      onSelect: () => attempt(() => actions.moveCategoryStep(selected.id, -1)),
                      testId: 'category-up',
                    },
                    {
                      label: '下へ移動',
                      icon: <DownIcon />,
                      disabled: selectedIndex >= categories.length - 1,
                      onSelect: () => attempt(() => actions.moveCategoryStep(selected.id, 1)),
                      testId: 'category-down',
                    },
                    {
                      label: '項目を削除',
                      icon: <TrashIcon />,
                      danger: true,
                      onSelect: () => void remove(selected),
                      testId: 'category-delete',
                    },
                  ]}
                />
              </div>

              <div className="st-template-line small">
                <span className="muted">テンプレート：</span>
                {selected.fieldTemplate.length > 0 ? (
                  // 「立場・役割」のように名前に「・」を含むフィールドもあるので、区切り文字でつながず1つずつ札にする
                  <ul className="st-template-keys" aria-label="テンプレートのフィールド" data-testid="template-keys">
                    {selected.fieldTemplate.map((k) => (
                      <li key={k} className="st-template-key" data-testid="template-key">
                        {k}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="faint">なし（自由記述のみ）</span>
                )}
                <button
                  type="button"
                  className="st-link-btn"
                  onClick={() => setTemplateFor(selected.id)}
                  data-testid="template-edit"
                >
                  編集
                </button>
              </div>

              {entries.length === 0 ? (
                <div className="empty st-entries-empty" data-testid="entries-empty">
                  「{categoryDisplayName(selected.name)}」にはまだエントリがありません。
                  <br />
                  「＋エントリを追加」から書き始めましょう。
                </div>
              ) : (
                <ul className="st-entry-list" data-testid="entry-list">
                  {entries.map((e, i) => (
                    <EntryCard
                      key={e.id}
                      entry={e}
                      categories={categories}
                      isFirst={i === 0}
                      isLast={i === entries.length - 1}
                      expanded={expanded.has(e.id)}
                      onToggle={() => toggle(e.id)}
                      autoFocusName={justAdded === e.id}
                    />
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      )}

      {adding ? (
        <AddCategoryDialog
          titleId={titleId}
          existing={categories}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            select(id)
          }}
        />
      ) : null}
      {templateCategory ? (
        <TemplateDialog key={templateCategory.id} category={templateCategory} onClose={() => setTemplateFor(null)} />
      ) : null}
    </div>
  )
}
