// アイデアのフォルダ（2.9）を作る・名前を変える・削除する時のダイアログと、その後のフォーカス。
// 仕切りの［＋ フォルダ］、フォルダの「…」のメニュー、移動のダイアログの「新しいフォルダを作って移す」で同じものを使う。
import { folderSubtree, ideaFolderName } from '../../domain/ideaFolders'
import { folderPlaceOf, ideaFolderNameProblem, type FolderPlace } from '../../domain/ideaFolderOps'
import { trashNotice } from '../../domain/trash'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { expandFolders } from './folderCollapse'
import { folderDeleteSubject, subfolderInitialName } from './ideaLogic'

/** ホームのフォルダの名前は Claude にも見えることの説明（作る時） */
export const HOME_FOLDER_HINT =
  'どのタイトルにも属さないフォルダの名前は、Claude と連携していると Claude にも見えます（作者が書いたカードの中身は見えません）'

/** 画面に出ているフォルダ（section.idea-folder）。id は属性の値として比べる（セレクタに id を書かない） */
export function folderElement(id: ID): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[data-testid="idea-folder"]')
  for (const el of all) if (el.dataset.folderId === id) return el
  return null
}

/** フォルダの見出しの開け閉めのボタン */
export function folderToggle(el: Element | null): HTMLElement | null {
  return el?.querySelector<HTMLElement>(':scope > .idea-folder-head [data-testid="idea-folder-toggle"]') ?? null
}

/** 描き終わった後に、そのフォルダの見出しへフォーカスする（見える所まで出す） */
export function focusFolderHead(id: ID): void {
  requestAnimationFrame(() => {
    const toggle = folderToggle(folderElement(id))
    if (!toggle) return
    toggle.focus({ preventScroll: true })
    toggle.scrollIntoView?.({ block: 'nearest' })
  })
}

/**
 * フォルダの名前を聞く（作る時）。parent があれば2段目（名前の初期値は今日の日付と全角の空白）。
 * 名前の問題（空・40字を超える・同じ入れ物に同じ名前）は入力欄の下に出して作らせない。キャンセルは null
 */
export function askNewFolderName(place: FolderPlace): Promise<string | null> {
  const parent = place.parentId === null ? undefined : getData().ideaFolders[place.parentId]
  const validate = (v: string) => ideaFolderNameProblem(getData(), place, v)
  if (parent) {
    return promptDialog({
      title: `『${ideaFolderName(parent)}』の中にフォルダを作る`,
      label: 'フォルダの名前（40字まで）',
      initial: subfolderInitialName(Date.now()),
      placeholder: '例: 2026/11/13　港町',
      confirmLabel: '作る',
      hint: place.titleId === null ? HOME_FOLDER_HINT : undefined,
      validate,
    })
  }
  return promptDialog({
    title: 'フォルダを作る',
    label: 'フォルダの名前（40字まで）',
    placeholder: '例: 新作の相談',
    confirmLabel: '作る',
    hint: place.titleId === null ? HOME_FOLDER_HINT : undefined,
    validate,
  })
}

/** フォルダを作る（仕切りの［＋ フォルダ］・メニューの「この中にフォルダを作る」）。作ったフォルダは上に入り、開いて見出しにフォーカスする */
export async function createFolderFlow(place: FolderPlace): Promise<ID | null> {
  const name = await askNewFolderName(place)
  if (name === null) return null
  const id = attempt(() => actions.createIdeaFolder(place.titleId, place.parentId, name))
  if (!id) return null
  if (place.parentId) expandFolders([place.parentId])
  notify(`フォルダ「${ideaFolderName(getData().ideaFolders[id] ?? { name })}」を作りました`)
  focusFolderHead(id)
  return id
}

/** 名前を変える（Claude が作ったフォルダも。印はそのまま） */
export async function renameFolderFlow(id: ID): Promise<void> {
  const f = getData().ideaFolders[id]
  if (!f) return
  const name = await promptDialog({
    title: 'フォルダの名前を変える',
    label: 'フォルダの名前（40字まで）',
    initial: f.name,
    confirmLabel: '変更',
    selectOnOpen: true,
    validate: (v) => {
      const now = getData().ideaFolders[id]
      return now ? ideaFolderNameProblem(getData(), folderPlaceOf(getData(), now), v, id) : null
    },
  })
  if (name === null) return
  attempt(() => (actions.renameIdeaFolder(id, name), true))
}

/**
 * 削除したフォルダの次にフォーカスする所: 次の兄弟のフォルダの見出し、無ければ前の兄弟、2段目なら親のフォルダの見出し、
 * それも無ければ仕切りの見出し（タイトルの「アイデア」では［＋ フォルダ］）
 */
function focusAfterDelete(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  const sibling = (n: Element | null) => (n instanceof HTMLElement && n.dataset.testid === 'idea-folder' ? folderToggle(n) : null)
  const parentFolder = el.parentElement?.closest<HTMLElement>('[data-testid="idea-folder"]') ?? null
  const section = el.closest<HTMLElement>('[data-testid="idea-section"]')
  return (
    sibling(el.nextElementSibling) ??
    sibling(el.previousElementSibling) ??
    folderToggle(parentFolder) ??
    section?.querySelector<HTMLElement>('[data-testid="idea-section-toggle"]') ??
    section?.querySelector<HTMLElement>('[data-testid="idea-folder-create"]') ??
    null
  )
}

/** フォルダを削除する（中のフォルダとカードも一緒にゴミ箱の1件へ。戻す時も一緒に戻る） */
export async function deleteFolderFlow(id: ID): Promise<void> {
  const data = getData()
  const f = data.ideaFolders[id]
  if (!f) return
  const name = ideaFolderName(f)
  const { folders, ideas } = folderSubtree(data, id)
  const ok = await confirmDialog({
    title: 'フォルダを削除しますか？',
    message: trashNotice(folderDeleteSubject(name, Math.max(0, folders.length - 1), ideas.length)),
    danger: true,
    confirmLabel: '削除',
  })
  if (!ok) return
  const next = focusAfterDelete(folderElement(id))
  if (!attempt(() => (actions.deleteIdeaFolder(id), true))) return
  notify(`フォルダ「${name}」をゴミ箱に移しました`)
  requestAnimationFrame(() => {
    if (next?.isConnected) next.focus({ preventScroll: true })
  })
}
