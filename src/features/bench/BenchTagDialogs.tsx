// 相対比較の作品のタグ（ジャンル。2.7）のダイアログ。部品は資料のタグと共通（MaterialTagDialogs.tsx）で、タグの一覧は別。
// - BenchTagsEditDialog: 1つの作品のタグを付け直す（作品の画面の「ジャンル」の「タグを付ける」「タグを編集」）。
//   開いている間に自動のタグが付いても消さないように、開いた時との差分（足した・外した）を今のタグに当てて保存する
// - BenchManageTagsDialog: 棚の「タグを管理」（名前を変える・削除は、そのタグの付いたすべての作品で）
import { useMemo, useState } from 'react'
import type { BenchWork } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { TagManageDialog, TagsEditDialog, type TagManageTexts } from '../materials/MaterialTagDialogs'
import { benchTagChips, benchTags, tagDiff, workName } from './benchLogic'

/** 使っている作品のタグの名前（多く使われている順。タグの入力の候補。資料のタグは混ぜない） */
export function useBenchTagsInUse(): string[] {
  const benchWorks = useData().benchWorks
  return useMemo(() => benchTagChips({ benchWorks }).map((t) => t.tag), [benchWorks])
}

/** 作品の画面のタグの案内（自動で付くこと） */
export const BENCH_TAG_HINT =
  '「14 検索用タグ」の判定したジャンル・サブジャンルは自動で付きます（外したタグは、新しい 14 が来るまで付き直しません）。'

/** 1つの作品のタグを付け直す */
export function BenchTagsEditDialog({ work, onClose }: { work: BenchWork; onClose: () => void }) {
  const inUse = useBenchTagsInUse()
  const [initial] = useState(() => benchTags(work))
  return (
    <TagsEditDialog
      title={`「${workName(work)}」のジャンル（タグ）`}
      initial={initial}
      inUse={inUse}
      onClose={onClose}
      testIdPrefix="bench"
      editor={{ noun: '作品', placeholder: '例：恋愛、青春、喪失', hint: BENCH_TAG_HINT }}
      onSave={(next) => {
        if (!attempt(() => (actions.editBenchWorkTags(work.id, tagDiff(initial, next)), true))) return false
        notify('タグを保存しました')
        return true
      }}
    />
  )
}

const BENCH_TEXTS: TagManageTexts = {
  count: (n) => `${n}作品`,
  cellCount: (n) => `${n}作品`,
  noun: '作品',
  lead: '作品に付けたタグ（ジャンル）の一覧です。名前を変える・削除は、そのタグの付いたすべての作品に効きます。「14 検索用タグ」の判定したジャンル・サブジャンルは自動で付きます。資料の棚のタグとは別です。',
  empty: 'まだタグがありません。作品の画面の「ジャンル」で付けられます（「14 検索用タグ」のジャンルは自動で付きます）。',
  removeMessage: (tag, count) =>
    `${count}作品からタグ「${tag}」を外します。作品とその分析は消えません（ゴミ箱には入りません）。新しい「14 検索用タグ」に同じジャンルがあれば、また付きます。`,
}

/** 相対比較の棚の「タグを管理」 */
export function BenchManageTagsDialog({
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
  const benchWorks = useData().benchWorks
  const chips = useMemo(() => benchTagChips({ benchWorks }), [benchWorks])
  return (
    <TagManageDialog
      chips={chips}
      texts={BENCH_TEXTS}
      rename={(from, to) => actions.renameBenchTag(from, to)}
      remove={(tag) => actions.removeBenchTag(tag)}
      onClose={onClose}
      onRenamed={onRenamed}
      onRemoved={onRemoved}
      testIdPrefix="bench"
    />
  )
}
