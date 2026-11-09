// タグのダイアログ（資料のタグ（2.6）と相対比較の作品のタグ（2.7）で共通の部品と、資料のもの）。
// - TagsEditDialog: 1つの資料・作品のタグを付け直す（保存は［保存］を押した時。閉じると何も変えない）
// - TagManageDialog: 棚の「タグを管理」。使っているタグと数の一覧で、名前を変える（すべての資料・作品で付け替え。
//   もうあるタグの名前にすれば1つにまとめる）・削除（すべての資料・作品から外す。資料・作品は消えない）ができる
// 資料のタグは作者が自分で付けて管理する（Claude は資料を足して記録を書くだけで、タグは付けない）。
// 相対比較の作品のタグは src/features/bench/BenchTagDialogs.tsx（資料のタグとは別の一覧）。
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { tagKey } from '../../domain/tags'
import type { Material } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { EditIcon, TagIcon, TrashIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { materialName, materialTags, tagChips, type TagChip } from './materialLogic'
import { TagEditor, type TagEditorProps } from './TagEditor'
import './materials.css'
import './tags.css'

type TestIdPrefix = 'material' | 'bench'

/** 1つの資料・作品のタグを付け直す（保存は［保存］を押した時。閉じると何も変えない） */
export function TagsEditDialog({
  title,
  initial,
  inUse,
  onSave,
  onClose,
  editor,
  lead,
  testIdPrefix,
}: {
  title: string
  /** 開いた時のタグ（付けた順） */
  initial: readonly string[]
  /** 使っているタグの名前（多く使われている順。入力の候補） */
  inUse: readonly string[]
  /** 保存する（打ちかけのタグも足した並び）。保存できたら true（閉じる） */
  onSave: (tags: string[]) => boolean
  onClose: () => void
  editor?: Pick<TagEditorProps, 'label' | 'noun' | 'placeholder' | 'hint'>
  /** タグの欄の上の案内（任意） */
  lead?: ReactNode
  testIdPrefix: TestIdPrefix
}) {
  const [tags, setTags] = useState<string[]>(() => [...initial])
  const flush = useRef<(() => string[] | null) | null>(null)
  const save = () => {
    // 打ちかけのタグを足せない時（20字を超えるなど）は保存しない（理由はタグの欄に出ている）
    const next = flush.current ? flush.current() : tags
    if (!next) return
    if (onSave(next)) onClose()
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      initialFocus={`[data-testid="${testIdPrefix}-tag-input"]`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid={`${testIdPrefix}-tags-save`}>
            保存
          </button>
        </>
      }
    >
      <div className="stack mt-form" data-testid={`${testIdPrefix}-tags-dialog`}>
        {lead}
        <TagEditor
          tags={tags}
          onChange={setTags}
          inUse={inUse}
          flushRef={flush}
          label="タグ"
          {...editor}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </Modal>
  )
}

/** 「タグを管理」の文言（資料・作品で変える所） */
export interface TagManageTexts {
  /** 数の言い方（「3件の資料」「3作品」） */
  count: (n: number) => string
  /** 一覧の数の欄（「3件」「3作品」） */
  cellCount: (n: number) => string
  /** 「両方が付いた資料では1つにします」の名詞 */
  noun: string
  /** 一覧の上の案内 */
  lead: string
  /** タグが1つも無い時の案内 */
  empty: string
  /** 削除の確認の文 */
  removeMessage: (tag: string, count: number) => string
}

/** 棚の「タグを管理」（使っているタグの一覧。名前を変える・削除は、そのタグの付いたすべての資料・作品で） */
export function TagManageDialog({
  chips,
  texts,
  rename: renameTag,
  remove: removeTag,
  onClose,
  onRenamed,
  onRemoved,
  testIdPrefix,
}: {
  chips: readonly TagChip[]
  texts: TagManageTexts
  /** 名前を変える（直した数を返す。attempt の中で呼ぶ） */
  rename: (from: string, to: string) => number
  /** すべてから外す（直した数を返す。attempt の中で呼ぶ） */
  remove: (tag: string) => number
  onClose: () => void
  /** 名前を変えた後（棚のタグの絞り込みを付け替える。from・to は tagKey の形） */
  onRenamed?: (fromKey: string, toKey: string) => void
  /** 削除した後（棚のタグの絞り込みから外す。tagKey の形） */
  onRemoved?: (key: string) => void
  testIdPrefix: TestIdPrefix
}) {
  const rename = async (tag: string, count: number) => {
    const raw = await promptDialog({
      title: `タグ「${tag}」の名前を変える`,
      label: `新しい名前（${texts.count(count)}で付け替えます）`,
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
        message: `タグ「${into.tag}」はもう${texts.count(into.count)}に付いています。「${tag}」の付いた${texts.count(count)}のタグを「${into.tag}」にまとめます（両方が付いた${texts.noun}では1つにします）。`,
        confirmLabel: 'まとめる',
      }))
    )
      return
    const name = into ? into.tag : to
    const changed = attempt(() => renameTag(tag, name))
    if (changed === undefined) return
    notify(
      into
        ? `タグ「${tag}」を「${name}」にまとめました（${texts.count(changed)}）`
        : `タグ「${tag}」の名前を「${name}」に変えました（${texts.count(changed)}）`,
    )
    onRenamed?.(tagKey(tag), tagKey(name))
  }

  const remove = async (tag: string, count: number) => {
    const ok = await confirmDialog({
      title: `タグ「${tag}」を削除しますか？`,
      message: texts.removeMessage(tag, count),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    const changed = attempt(() => removeTag(tag))
    if (changed === undefined) return
    notify(`タグ「${tag}」を${texts.count(changed)}から外しました`)
    onRemoved?.(tagKey(tag))
  }

  const tid = (name: string) => `${testIdPrefix}-${name}`
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
      <div className={`stack mt-form${testIdPrefix === 'bench' ? ' tag-bench' : ''}`} data-testid={tid('manage-tags')}>
        <p className="small muted mt-lead">{texts.lead}</p>
        {chips.length === 0 ? (
          <p className="empty small" data-testid={tid('manage-tags-empty')}>
            {texts.empty}
          </p>
        ) : (
          <ul className="mt-manage-list" aria-label="使っているタグ">
            {chips.map((c) => (
              <li key={c.key} className="mt-manage-row" data-testid={tid('manage-tag')} data-tag={c.tag}>
                <TagIcon className="icon mt-manage-icon" />
                <span className="mt-manage-name" data-testid={tid('manage-tag-name')}>
                  {c.tag}
                </span>
                <span className="mt-manage-count" data-testid={tid('manage-tag-count')}>
                  {texts.cellCount(c.count)}
                </span>
                <span className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void rename(c.tag, c.count)}
                  aria-label={`タグ「${c.tag}」の名前を変える`}
                  data-testid={tid('manage-rename')}
                >
                  <EditIcon />
                  名前を変える
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void remove(c.tag, c.count)}
                  aria-label={`タグ「${c.tag}」を削除`}
                  data-testid={tid('manage-delete')}
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

// ---------- 資料のタグ ----------

/** 使っている資料のタグの名前（多く使われている順。タグの入力の候補） */
export function useTagsInUse(): string[] {
  const materials = useData().materials
  return useMemo(() => tagChips({ materials }).map((t) => t.tag), [materials])
}

/** 1つの資料のタグを付け直す（資料の画面の「タグを編集」） */
export function MaterialTagsEditDialog({ material, onClose }: { material: Material; onClose: () => void }) {
  const inUse = useTagsInUse()
  const [initial] = useState(() => materialTags(material))
  return (
    <TagsEditDialog
      title={`「${materialName(material)}」のタグ`}
      initial={initial}
      inUse={inUse}
      onClose={onClose}
      testIdPrefix="material"
      onSave={(next) => {
        if (!attempt(() => (actions.setMaterialTags(material.id, next), true))) return false
        notify('タグを保存しました')
        return true
      }}
    />
  )
}

const MATERIAL_TEXTS: TagManageTexts = {
  count: (n) => `${n}件の資料`,
  cellCount: (n) => `${n}件`,
  noun: '資料',
  lead: '資料に付けたタグの一覧です。名前を変える・削除は、そのタグの付いたすべての資料に効きます。タグは作者が付けるもので、Claude は付けません。',
  empty: 'まだタグがありません。資料の画面の「タグを付ける」か「資料の情報を直す」で付けられます。',
  removeMessage: (tag, count) =>
    `${count}件の資料からタグ「${tag}」を外します。資料とその記録は消えません（ゴミ箱には入りません）。`,
}

/** 資料の棚の「タグを管理」 */
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
  return (
    <TagManageDialog
      chips={chips}
      texts={MATERIAL_TEXTS}
      rename={(from, to) => actions.renameMaterialTag(from, to)}
      remove={(tag) => actions.removeMaterialTag(tag)}
      onClose={onClose}
      onRenamed={onRenamed}
      onRemoved={onRemoved}
      testIdPrefix="material"
    />
  )
}
