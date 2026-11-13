// アイデアのフォルダ（2.9）の見せ方の決まり。カードとフォルダをどこに出すかは、アプリ（ホームのアイデア欄・タイトルの「アイデア」・
// 移動の画面・ゴミ箱）も Claude 側（src/claude・コネクタ）も、ここの部品だけで決める。
// - 仕切り（タイトル／どのタイトルにも属さない）は、フォルダもカードも titleId で決める（フォルダから仕切りを決めない。
//   Claude に見せる範囲が参照の食い違いで変わらないように）。タイトルが無ければ どのタイトルにも属さない（null）
// - 1段目かどうかは「親への正しいつながり（文字列・自分でない・ある・同じ仕切り）が無い」で決める（再帰しない）。2段目として
//   見せるのは、つながりのある親が1段目の時だけ。3段目・輪・別の仕切りの親は、見せる時は1段目
// - カードは、入っているフォルダがあり同じ仕切りの時だけ、そのフォルダ（どちらの段でもよい）に見せる。それ以外はフォルダの外
// - 修復では文字列の参照を消さない（届く順・ゴミ箱の間に触ったカードも、フォルダが届けば・戻せば、そのフォルダに戻る）
// どの段でも、フォルダ（order の順）→ 済みでないカード（order の順）→ 済みのカード（新しく済みにしたものから）の順に並べる。
// 純粋な部品（型・並び・名前の鍵のほかは読み込まない）。AppData にまだフォルダの表が無くても使えるように、引数は必要な表だけ。
import { refKey } from '../claude/refs'
import { isIdeaChecked, sortIdeas } from './ideaSort'
import type { ID, Idea, IdeaFolder } from './types'
import { byOrder } from './util'

/** フォルダの名前の上限（字の数） */
export const IDEA_FOLDER_NAME_MAX = 40

/** 名前の無いフォルダの表記 */
export const UNTITLED_FOLDER_NAME = '無題のフォルダ'

/** フォルダの見せ方に使う表（タイトルはあるかどうかだけを見る） */
export interface IdeaFolderData {
  titles: Readonly<Record<ID, unknown>>
  ideaFolders: Readonly<Record<ID, IdeaFolder>>
  ideas: Readonly<Record<ID, Idea>>
}

type FolderData = Pick<IdeaFolderData, 'titles' | 'ideaFolders'>

/** 表から引く（自分の項目だけ。'constructor' などの id で Object の中身を拾わない） */
function own<T>(rows: Readonly<Record<ID, T>>, id: unknown): T | undefined {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(rows, id) ? rows[id] : undefined
}

/** 仕切り（タイトルが無ければ どのタイトルにも属さない = null。ideaSections と同じ決まり） */
export function sectionOf(titles: Readonly<Record<ID, unknown>>, titleId: unknown): ID | null {
  return typeof titleId === 'string' && own(titles, titleId) ? titleId : null
}

/** 親への正しいつながり（文字列・自分でない・ある・同じ仕切り）。無ければ null */
function parentLink(data: FolderData, f: IdeaFolder): IdeaFolder | null {
  const pid = f.parentId
  if (typeof pid !== 'string' || pid === f.id) return null
  const p = own(data.ideaFolders, pid)
  if (!p || typeof p !== 'object') return null
  return sectionOf(data.titles, p.titleId) === sectionOf(data.titles, f.titleId) ? p : null
}

/** 1段目として見せるか（親への正しいつながりが無い）。再帰しない（親の親は見ない） */
export function isTopFolder(data: FolderData, f: IdeaFolder): boolean {
  return parentLink(data, f) === null
}

/** 2段目として見せる親（つながりがあり、親が1段目の時だけ）。それ以外は null（1段目として見せる） */
export function effectiveParentId(data: FolderData, f: IdeaFolder): ID | null {
  const p = parentLink(data, f)
  return p && isTopFolder(data, p) ? p.id : null
}

/** 見せる段（1段目か2段目） */
export function folderDepth(data: FolderData, f: IdeaFolder): 1 | 2 {
  return effectiveParentId(data, f) ? 2 : 1
}

/** カードが入っているフォルダ（フォルダがあり、同じ仕切りの時だけ。どちらの段でもよい）。それ以外は null = フォルダの外 */
export function effectiveFolderId(data: FolderData, idea: Pick<Idea, 'titleId' | 'folderId'>): ID | null {
  const f = own(data.ideaFolders, idea.folderId)
  if (!f || typeof f !== 'object') return null
  return sectionOf(data.titles, f.titleId) === sectionOf(data.titles, idea.titleId) ? f.id : null
}

/** 入れ物の鍵: 仕切り＋フォルダ（null = フォルダの外。フォルダは仕切り＋親の effectiveParentId で） */
export function containerKey(section: ID | null, folderId: ID | null): string {
  return `${section ?? ''}|${folderId ?? ''}`
}

/** フォルダの表記（空なら「無題のフォルダ」） */
export function ideaFolderName(f: Pick<IdeaFolder, 'name'>): string {
  return (typeof f.name === 'string' ? f.name.trim() : '') || UNTITLED_FOLDER_NAME
}

export interface IdeaFolderNode {
  folder: IdeaFolder
  depth: 1 | 2
  /** 中のフォルダ（2段目。1段目だけが持つ。order の順） */
  folders: IdeaFolderNode[]
  /** このフォルダにじかに入っているカード（sortIdeas） */
  ideas: Idea[]
  /** 下のすべてのカードの数（中のフォルダのカードも） */
  count: number
  /** そのうち済みの数 */
  done: number
}

export interface IdeaTree {
  /** 1段目のフォルダ（order の順） */
  folders: IdeaFolderNode[]
  /** フォルダの外のカード（sortIdeas） */
  loose: Idea[]
  /** 仕切りのすべてのカードの数（フォルダの中も） */
  count: number
  done: number
}

/** 1つの仕切りの木（どの段もフォルダは byOrder、カードは sortIdeas。count は下の全部のカード） */
export function buildIdeaTree(data: IdeaFolderData, section: ID | null): IdeaTree {
  const folders = Object.values(data.ideaFolders).filter(
    (f) => f && typeof f === 'object' && sectionOf(data.titles, f.titleId) === section,
  )
  const children = new Map<ID, IdeaFolder[]>()
  const tops: IdeaFolder[] = []
  for (const f of folders) {
    const pid = effectiveParentId(data, f)
    if (pid === null) tops.push(f)
    else {
      const list = children.get(pid)
      if (list) list.push(f)
      else children.set(pid, [f])
    }
  }
  const cards = new Map<ID | null, Idea[]>()
  for (const i of Object.values(data.ideas)) {
    if (!i || typeof i !== 'object' || sectionOf(data.titles, i.titleId) !== section) continue
    const fid = effectiveFolderId(data, i)
    const list = cards.get(fid)
    if (list) list.push(i)
    else cards.set(fid, [i])
  }
  const node = (folder: IdeaFolder, depth: 1 | 2): IdeaFolderNode => {
    const subs = depth === 1 ? (children.get(folder.id) ?? []).sort(byOrder).map((f) => node(f, 2)) : []
    const ideas = sortIdeas(cards.get(folder.id) ?? [])
    const count = ideas.length + subs.reduce((n, s) => n + s.count, 0)
    const done = ideas.filter(isIdeaChecked).length + subs.reduce((n, s) => n + s.done, 0)
    return { folder, depth, folders: subs, ideas, count, done }
  }
  const top = tops.sort(byOrder).map((f) => node(f, 1))
  const loose = sortIdeas(cards.get(null) ?? [])
  return {
    folders: top,
    loose,
    count: loose.length + top.reduce((n, s) => n + s.count, 0),
    done: loose.filter(isIdeaChecked).length + top.reduce((n, s) => n + s.done, 0),
  }
}

/** フォルダのつながり（見せ方のつながりで [1段目] か [1段目, 2段目]）。フォルダが無ければ空 */
export function folderChain(data: FolderData, folderId: ID | null | undefined): IdeaFolder[] {
  const f = own(data.ideaFolders, folderId)
  if (!f || typeof f !== 'object') return []
  const pid = effectiveParentId(data, f)
  const p = pid ? own(data.ideaFolders, pid) : undefined
  return p ? [p, f] : [f]
}

/** フォルダの名前のつながり（['新作の相談', '2026/11/12　港町']） */
export function folderPathNames(data: FolderData, folderId: ID | null | undefined): string[] {
  return folderChain(data, folderId).map(ideaFolderName)
}

/** フォルダの場所の表記（アプリは ' › '、Claude 側は '＞'）。フォルダが無ければ空 */
export function folderPathLabel(data: FolderData, folderId: ID | null | undefined, sep = ' › '): string {
  return folderPathNames(data, folderId).join(sep)
}

/**
 * フォルダの見せ方の中身。folders は そのフォルダと中のフォルダ（2段目。order の順）、ideas はその中のカード（見せる順: 中のフォルダの
 * カードを先に、そのフォルダにじかに入っているカードを後に。それぞれ sortIdeas）。フォルダが無ければ空
 */
export function folderSubtree(data: IdeaFolderData, folderId: ID): { folders: IdeaFolder[]; ideas: Idea[] } {
  const f = own(data.ideaFolders, folderId)
  if (!f || typeof f !== 'object') return { folders: [], ideas: [] }
  const tree = buildIdeaTree(data, sectionOf(data.titles, f.titleId))
  const find = (nodes: IdeaFolderNode[]): IdeaFolderNode | undefined => {
    for (const n of nodes) {
      if (n.folder.id === folderId) return n
      const sub = find(n.folders)
      if (sub) return sub
    }
    return undefined
  }
  const n = find(tree.folders)
  if (!n) return { folders: [], ideas: [] }
  return {
    folders: [n.folder, ...n.folders.map((s) => s.folder)],
    ideas: [...n.folders.flatMap((s) => s.ideas), ...n.ideas],
  }
}

/** 1行にする改行・タブ（全角の空白は名前の中に残す） */
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]/g
/** 前後の空白（全角の空白も） */
const EDGE_SPACES = /^[\s\u3000]+|[\s\u3000]+$/gu

/**
 * フォルダの名前をそろえる。NFC、改行・タブは半角の空白、前後の空白（全角も）を除き、続く半角の空白は1つ、
 * 中の全角の空白は残す（「2026/11/12　港町」）、40字まで（切った後の終わりの空白も除く）
 */
export function normalizeFolderName(s: string): string {
  const t = (typeof s === 'string' ? s : '')
    .normalize('NFC')
    .replace(LINE_BREAKS, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(EDGE_SPACES, '')
  const chars = Array.from(t)
  return chars.length > IDEA_FOLDER_NAME_MAX ? chars.slice(0, IDEA_FOLDER_NAME_MAX).join('').replace(EDGE_SPACES, '') : t
}

/** 同じ名前と見なす鍵（字の幅・空白の違いは同じ。refs.ts の refKey） */
export const folderNameKey = refKey
