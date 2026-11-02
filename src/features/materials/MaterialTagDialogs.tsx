// 資料のタグ（2.6）のダイアログ。タグは作者が自分で付けて管理する（Claude は資料を足して記録を書くだけで、タグは付けない）。
// - MaterialTagsEditDialog: 1つの資料のタグを付け直す（資料の画面の「タグを編集」）
// - ManageTagsDialog: 棚の「タグを管理」。使っているタグと資料の数の一覧で、名前を変える（すべての資料で付け替え。
//   もうあるタグの名前にすれば1つにまとめる）・削除（すべての資料から外す。資料は消えない）ができる
import { useMemo, useRef, useState } from 'react'
import { tagKey } from '../../domain/materialOps'
import type { Material } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { EditIcon, TagIcon, TrashIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { materialName, materialTags, tagChips } from './materialLogic'
import { TagEditor } from './TagEditor'
import './materials.css'

/** 使っているタグの名前（多く使われている順。タグの入力の候補） */
export function useTagsInUse(): string[] {
  const materials = useData().materials
  return useMemo(() => tagChips({ materials }).map((t) => t.tag), [materials])
}

/** 1つの資料のタグを付け直す（保存は［保存］を押した時。閉じると何も変えない） */
export function MaterialTagsEditDialog({ material, onClose }: { material: Material; onClose: () => void }) {
  const inUse = useTagsInUse()
  const [tags, setTags] = useState<string[]>(() => materialTags(material))
  const flush = useRef<(() => string[] | null) | null>(null)
  const save = () => {
    // 打ちかけのタグを足せない時（20字を超えるなど）は保存しない（理由はタグの欄に出ている）
    const next = flush.current ? flush.current() : tags
    if (!next) return
    if (attempt(() => (actions.setMaterialTags(material.id, next), true))) {
      notify('タグを保存しました')
      onClose()
    }
  }
  return (
    <Modal
      title={`「${materialName(material)}」のタグ`}
      onClose={onClose}
      initialFocus='[data-testid="material-tag-input"]'
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid="material-tags-save">
            保存
          </button>
        </>
      }
    >
      <div className="stack mt-form" data-testid="material-tags-dialog">
        <TagEditor tags={tags} onChange={setTags} inUse={inUse} flushRef={flush} label="タグ" />
      </div>
    </Modal>
  )
}

/** 棚の「タグを管理」（使っているタグの一覧。名前を変える・削除は、すべての資料で） */
export function ManageTagsDialog({
  onClose,
  onRenamed,
  onRemoved,
}: {
  onClose: () => void
  /** 名前を変えた後（棚のタグの絞り込みを付け替える。from・to は tagKey の形） */
  onRenamed?: (fromKey: string, toKey: string) => void
  /** 削除した後（棚のタグの絞り込みから外す。tagKey の形） */
  onRemoved?: (key: string) => void
}) {
  const materials = useData().materials
  const chips = useMemo(() => tagChips({ materials }), [materials])

  const rename = async (tag: string, count: number) => {
    const raw = await promptDialog({
      title: `タグ「${tag}」の名前を変える`,
      label: `新しい名前（${count}件の資料で付け替えます）`,
      initial: tag,
      confirmLabel: '名前を変える',
      selectOnOpen: true,
    })
    if (raw === null) return
    const to = raw.trim()
    if (to === tag) return
    const into = chips.find((c) => c.key === tagKey(to) && c.key !== tagKey(tag))
    if (
      into &&
      !(await confirmDialog({
        title: `タグ「${into.tag}」にまとめますか？`,
        message: `タグ「${into.tag}」はもう${into.count}件の資料に付いています。「${tag}」の付いた${count}件の資料のタグを「${into.tag}」にまとめます（両方が付いた資料では1つにします）。`,
        confirmLabel: 'まとめる',
      }))
    )
      return
    const name = into ? into.tag : to
    const changed = attempt(() => actions.renameMaterialTag(tag, name))
    if (changed === undefined) return
    notify(
      into
        ? `タグ「${tag}」を「${name}」にまとめました（${changed}件の資料）`
        : `タグ「${tag}」の名前を「${name}」に変えました（${changed}件の資料）`,
    )
    onRenamed?.(tagKey(tag), tagKey(name))
  }

  const remove = async (tag: string, count: number) => {
    const ok = await confirmDialog({
      title: `タグ「${tag}」を削除しますか？`,
      message: `${count}件の資料からタグ「${tag}」を外します。資料とその記録は消えません（ゴミ箱には入りません）。`,
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    const changed = attempt(() => actions.removeMaterialTag(tag))
    if (changed === undefined) return
    notify(`タグ「${tag}」を${changed}件の資料から外しました`)
    onRemoved?.(tagKey(tag))
  }

  return (
    <Modal
      title="タグを管理"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          閉じる
        </button>
      }
    >
      <div className="stack mt-form" data-testid="material-manage-tags">
        <p className="small muted mt-lead">
          資料に付けたタグの一覧です。名前を変える・削除は、そのタグの付いたすべての資料に効きます。タグは作者が付けるもので、Claude
          は付けません。
        </p>
        {chips.length === 0 ? (
          <p className="empty small" data-testid="material-manage-tags-empty">
            まだタグがありません。資料の画面の「タグを付ける」か「資料の情報を直す」で付けられます。
          </p>
        ) : (
          <ul className="mt-manage-list" aria-label="使っているタグ">
            {chips.map((c) => (
              <li key={c.key} className="mt-manage-row" data-testid="material-manage-tag" data-tag={c.tag}>
                <TagIcon className="icon mt-manage-icon" />
                <span className="mt-manage-name" data-testid="material-manage-tag-name">
                  {c.tag}
                </span>
                <span className="mt-manage-count" data-testid="material-manage-tag-count">
                  {c.count}件
                </span>
                <span className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void rename(c.tag, c.count)}
                  aria-label={`タグ「${c.tag}」の名前を変える`}
                  data-testid="material-manage-rename"
                >
                  <EditIcon />
                  名前を変える
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void remove(c.tag, c.count)}
                  aria-label={`タグ「${c.tag}」を削除`}
                  data-testid="material-manage-delete"
                >
                  <TrashIcon />
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
