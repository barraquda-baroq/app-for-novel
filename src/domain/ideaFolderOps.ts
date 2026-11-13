// アイデアのフォルダ（2.9）の操作: 作る・名前を変える・並べ替える・移す・削除する（ゴミ箱の1件）と、カードをまとめて移す。
// どこにあるか（仕切り・段・入っているフォルダ）は見せ方の決まり（ideaFolders.ts）だけで決める。3段目は操作では作れない
// （親にできるのは1段目だけ・中にフォルダのあるフォルダは親を持てない）。同期や作り物の記録で崩れた形は見せ方の決まりが外す。
// カードの folderId は、フォルダの外へ出す時に項目ごと消す（null は書かない。ideaFolders.withIdeaFolder）。
import {
  IDEA_FOLDER_NAME_MAX,
  buildIdeaTree,
  effectiveFolderId,
  effectiveParentId,
  folderNameKey,
  ideaFolderName,
  isTopFolder,
  sectionOf,
  tidyFolderName,
  withIdeaFolder,
} from './ideaFolders'
import { sortIdeas } from './ideaSort'
import { orderOrigin, putInTrash, trashLabel } from './trash'
import { Tx, transact } from './tx'
import { DomainError, type AppData, type ID, type Idea, type IdeaFolder } from './types'
import { byOrder, newId, nextOrder, now, stepOrder } from './util'

/** フォルダの入れ物（仕切り＋見せ方の親。1段目は parentId = null） */
export interface FolderPlace {
  titleId: ID | null
  parentId: ID | null
}

/** フォルダの今の入れ物（見せ方の決まりで） */
export function folderPlaceOf(data: Pick<AppData, 'titles' | 'ideaFolders'>, f: IdeaFolder): FolderPlace {
  return { titleId: sectionOf(data.titles, f.titleId), parentId: effectiveParentId(data, f) }
}

/** 同じ入れ物（仕切り＋親）のフォルダ（order の順。exceptId は除く） */
export function siblingFolders(data: Pick<AppData, 'titles' | 'ideaFolders'>, place: FolderPlace, exceptId?: ID): IdeaFolder[] {
  return Object.values(data.ideaFolders)
    .filter((f) => {
      if (f.id === exceptId) return false
      const p = folderPlaceOf(data, f)
      return p.titleId === place.titleId && p.parentId === place.parentId
    })
    .sort(byOrder)
}

/** 見せ方で中にあるフォルダ（2段目。order の順） */
function subfoldersOf(data: AppData, id: ID): IdeaFolder[] {
  return Object.values(data.ideaFolders)
    .filter((f) => effectiveParentId(data, f) === id)
    .sort(byOrder)
}

/** 見せ方でそのフォルダにじかに入っているカード（sortIdeas） */
function cardsIn(data: AppData, id: ID): Idea[] {
  return sortIdeas(Object.values(data.ideas).filter((i) => effectiveFolderId(data, i) === id))
}

/**
 * フォルダの名前の問題（無ければ null）。空・40字を超える・同じ入れ物に同じ名前（folderNameKey。字の幅・空白の違いは同じ）の
 * フォルダがある。exceptId は比べないフォルダ（名前を変える・移すフォルダ自身）。画面の入力の確かめにも使う
 */
export function ideaFolderNameProblem(
  data: Pick<AppData, 'titles' | 'ideaFolders'>,
  place: FolderPlace,
  name: string,
  exceptId?: ID,
): string | null {
  const t = tidyFolderName(name)
  if (!t) return 'フォルダの名前を入れてください'
  if (Array.from(t).length > IDEA_FOLDER_NAME_MAX) return `フォルダの名前は${IDEA_FOLDER_NAME_MAX}字までです`
  const key = folderNameKey(t)
  if (siblingFolders(data, place, exceptId).some((f) => folderNameKey(f.name) === key)) return '同じ名前のフォルダがもうあります'
  return null
}

/** 名前を確かめてそろえる（問題があれば DomainError） */
function checkedName(data: AppData, place: FolderPlace, name: string, exceptId?: ID): string {
  const problem = ideaFolderNameProblem(data, place, name, exceptId)
  if (problem) throw new DomainError(problem)
  return tidyFolderName(name)
}

/** 仕切り（タイトルがある）と、親にするフォルダ（同じ仕切りの1段目）を確かめる */
function requirePlace(tx: Tx, place: FolderPlace): void {
  if (place.titleId !== null && !tx.get('titles', place.titleId)) throw new DomainError('タイトルが見つかりません')
  if (place.parentId === null) return
  const p = tx.get('ideaFolders', place.parentId)
  if (!p) throw new DomainError('フォルダが見つかりません')
  if (sectionOf(tx.data.titles, p.titleId) !== place.titleId || !isTopFolder(tx.data, p))
    throw new DomainError('3段目のフォルダは作れません')
}

function createInTx(tx: Tx, place: FolderPlace, name: string): ID {
  requirePlace(tx, place)
  const clean = checkedName(tx.data, place, name)
  const siblings = siblingFolders(tx.data, place)
  const ts = now()
  const folder: IdeaFolder = {
    id: newId(),
    titleId: place.titleId,
    parentId: place.parentId,
    name: clean,
    // 新しいフォルダは上に入る（日付で分けた時に新しい相談が上に来る）
    order: siblings.length ? Math.min(...siblings.map((f) => f.order)) - 1 : 0,
    createdAt: ts,
    updatedAt: ts,
  }
  tx.put('ideaFolders', folder)
  return folder.id
}

/**
 * フォルダを作る（titleId = null は どのタイトルにも属さない。parentId = null は1段目、それ以外はその1段目の中の2段目）。
 * 兄弟のフォルダの上に入る。戻り値は新しいフォルダの id
 */
export function createIdeaFolder(
  data: AppData,
  titleId: ID | null,
  parentId: ID | null,
  name: string,
): { data: AppData; result: ID } {
  return transact(data, (tx) => createInTx(tx, { titleId, parentId }, name))
}

/** 名前を変える（同じ入れ物の同じ名前は断る）。同じ名前なら書き込まない。Claude のフォルダも作者が名前を変えられる（印はそのまま） */
export function renameIdeaFolder(data: AppData, id: ID, name: string): AppData {
  const f = data.ideaFolders[id]
  if (!f) throw new DomainError('フォルダが見つかりません')
  const clean = checkedName(data, folderPlaceOf(data, f), name, id)
  if (clean === f.name) return data
  return transact(data, (tx) => tx.put('ideaFolders', { ...f, name: clean, updatedAt: now() })).data
}

/** 同じ入れ物（仕切り＋親）のフォルダの中で1つ上（-1）・下（+1）へ */
export function moveIdeaFolderStep(data: AppData, id: ID, dir: -1 | 1): AppData {
  const f = data.ideaFolders[id]
  if (!f) return data
  const changed = stepOrder(siblingFolders(data, folderPlaceOf(data, f)), id, dir)
  if (!changed.length) return data
  return transact(data, (tx) => {
    const ts = now()
    for (const r of changed) tx.put('ideaFolders', { ...r, updatedAt: ts })
  }).data
}

/**
 * フォルダを移す（to の仕切りの1段目（parentId = null）か、その中の2段目に。index は移す先の兄弟の中の位置、既定は先頭）。
 * - 2段目は、どの仕切りの1段目の中へも・1段目にもできる。中にフォルダの無い1段目は、ほかの1段目の中へ移せる
 * - 中にフォルダのあるフォルダは1段目にしか移せない（3段目は作れない）。移す先に同じ名前のフォルダがあれば断る
 * - 仕切りが変わる時は、中のフォルダと、見せ方で中にあるカードの titleId も書き換える（カードの folderId はそのまま）
 * - 同じ入れ物の中なら、位置だけを変える
 */
export function moveIdeaFolder(data: AppData, id: ID, to: FolderPlace, index = 0): AppData {
  return transact(data, (tx) => {
    const f = tx.get('ideaFolders', id)
    if (!f) throw new DomainError('フォルダが見つかりません')
    if (to.parentId === id) throw new DomainError('フォルダをそのフォルダの中へは移せません')
    requirePlace(tx, to)
    const subs = subfoldersOf(tx.data, id)
    if (subs.length && to.parentId !== null) {
      throw new DomainError('中にフォルダがあるフォルダは、ほかのフォルダの中へは移せません（3段目は作れません）')
    }
    const from = folderPlaceOf(tx.data, f)
    const same = from.titleId === to.titleId && from.parentId === to.parentId
    // 移す先の兄弟と中のカードは、書き換える前に見せ方の決まりで集める（中のフォルダは一緒に移るので兄弟に数えない）
    const inner = new Set(subs.map((s) => s.id))
    const list = siblingFolders(tx.data, to, id).filter((s) => !inner.has(s.id))
    const key = folderNameKey(f.name)
    if (!same && list.some((s) => folderNameKey(s.name) === key)) throw new DomainError('移す先に同じ名前のフォルダがあります')
    const cards = from.titleId === to.titleId ? [] : [id, ...inner].flatMap((fid) => cardsIn(tx.data, fid))
    const ts = now()
    // 仕切りが変わる時は、中のフォルダとカードも移す先の仕切りへ（つながり・folderId はそのまま）
    if (from.titleId !== to.titleId) {
      for (const s of subs) tx.put('ideaFolders', { ...s, titleId: to.titleId, updatedAt: ts })
      for (const c of cards) tx.put('ideas', { ...c, titleId: to.titleId, updatedAt: ts })
    }
    const moved: IdeaFolder = same ? f : { ...f, titleId: to.titleId, parentId: to.parentId }
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved)
    list.forEach((r, i) => {
      if (r.order !== i || (r.id === id && !same)) tx.put('ideaFolders', { ...r, order: i, updatedAt: ts })
    })
  }).data
}

/**
 * フォルダを、中のフォルダ（2段目）と中のカードと一緒にゴミ箱の1件へ移す（戻す時も一緒に戻る）。中身の順は
 * フォルダ・中のフォルダ（order の順）・そのフォルダのカード（sortIdeas）・中のフォルダごとのカード（sortIdeas）
 */
export function deleteIdeaFolder(data: AppData, id: ID): AppData {
  const f = data.ideaFolders[id]
  if (!f) return data
  return transact(data, (tx) => {
    const place = folderPlaceOf(tx.data, f)
    const subs = subfoldersOf(tx.data, id)
    const records = [
      { table: 'ideaFolders' as const, record: f },
      ...subs.map((record) => ({ table: 'ideaFolders' as const, record })),
      ...[id, ...subs.map((s) => s.id)].flatMap((fid) =>
        cardsIn(tx.data, fid).map((record) => ({ table: 'ideas' as const, record })),
      ),
    ]
    const title = place.titleId === null ? undefined : tx.get('titles', place.titleId)
    const parent = place.parentId === null ? undefined : tx.get('ideaFolders', place.parentId)
    putInTrash(tx, {
      kind: 'ideaFolder',
      label: trashLabel.ideaFolder(f),
      titleName: title?.name ?? '',
      ...(parent ? { parentLabel: ideaFolderName(parent) } : {}),
      origin: { titleId: place.titleId, ...orderOrigin(siblingFolders(tx.data, place), id) },
      records,
    })
  }).data
}

/** カードを移す先（仕切り＋フォルダ。null = フォルダの外） */
export interface IdeaPlace {
  titleId: ID | null
  folderId: ID | null
}

/** 見せる順（仕切りの順、仕切りの中は木の順: 1段目ごとに中のフォルダのカード → そのフォルダのカード、最後にフォルダの外） */
function displayOrder(data: AppData): Idea[] {
  const sections: (ID | null)[] = [
    ...Object.values(data.titles)
      .sort(byOrder)
      .map((t) => t.id),
    null,
  ]
  return sections.flatMap((section) => {
    const tree = buildIdeaTree(data, section)
    return [...tree.folders.flatMap((top) => [...top.folders.flatMap((sub) => sub.ideas), ...top.ideas]), ...tree.loose]
  })
}

function moveIdeasInTx(tx: Tx, ids: readonly ID[], to: IdeaPlace): number {
  if (to.titleId !== null && !tx.get('titles', to.titleId)) throw new DomainError('タイトルが見つかりません')
  if (to.folderId !== null) {
    const f = tx.get('ideaFolders', to.folderId)
    if (!f || sectionOf(tx.data.titles, f.titleId) !== to.titleId) throw new DomainError('フォルダが見つかりません')
  }
  const want = new Set(ids)
  const cards = displayOrder(tx.data).filter((i) => want.has(i.id))
  if (!cards.length) return 0
  const moving = new Set(cards.map((i) => i.id))
  const rest = tx
    .all('ideas')
    .filter(
      (i) =>
        !moving.has(i.id) && sectionOf(tx.data.titles, i.titleId) === to.titleId && effectiveFolderId(tx.data, i) === to.folderId,
    )
  let order = nextOrder(rest)
  const ts = now()
  for (const c of cards)
    tx.put('ideas', { ...withIdeaFolder(c, to.folderId), titleId: to.titleId, order: order++, updatedAt: ts })
  return cards.length
}

/**
 * カードをまとめて移す（「選んで移す」）。移す先の入れ物の末尾に、今の見せる順で入る（済みのものは済みのまま下にまとまる）。
 * もう無いカードは飛ばす。戻り値は移した数
 */
export function moveIdeas(data: AppData, ids: readonly ID[], to: IdeaPlace): { data: AppData; result: number } {
  return transact(data, (tx) => moveIdeasInTx(tx, ids, to))
}

/** 「新しいフォルダを作って移す」: フォルダを作り、カードをその中へまとめて移す（1回の操作。どちらかが断られれば何も変えない） */
export function createIdeaFolderAndMove(
  data: AppData,
  titleId: ID | null,
  parentId: ID | null,
  name: string,
  ids: readonly ID[],
): { data: AppData; result: { folderId: ID; moved: number } } {
  return transact(data, (tx) => {
    const folderId = createInTx(tx, { titleId, parentId }, name)
    return { folderId, moved: moveIdeasInTx(tx, ids, { titleId, folderId }) }
  })
}
