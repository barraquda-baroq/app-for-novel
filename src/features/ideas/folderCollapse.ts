// アイデアのフォルダ（2.9）の開け閉め。この端末に覚えておく（閉じたフォルダの id の一覧。既定は開いている。仕切りと同じ）。
// 仕切りの開け閉め（storage.ts の 'novel-studio:idea-collapsed'）とは別の鍵なので、「すべて折りたたむ／開く」でフォルダの状態は消えない。
// ホームのアイデア欄とタイトルの「アイデア」で同じものを使う（タイトルの「アイデア」の仕切りは閉じられないが、フォルダは閉じられる）。
// 保存する時に、もう無いフォルダの id を除き、500 まで（新しく閉じたものを残す）。すべてのデータを削除した時・バックアップから
// 復元した時は、localStorage と一緒に消える（'novel-studio:' で始まる鍵。localState.ts）。
import { create } from 'zustand'
import type { ID } from '../../domain/types'
import { getData } from '../../store/appStore'
import { LOCAL_STATE_CLEARED } from '../appSettings/localState'
import { parseCollapsed } from './ideaLogic'
import { readLocal, writeLocal } from './storage'

export const FOLDER_COLLAPSED_KEY = 'novel-studio:idea-folder-collapsed'

/** 覚えておく閉じたフォルダの数の上限 */
export const FOLDER_COLLAPSED_MAX = 500

interface FolderCollapseState {
  /** 閉じたフォルダの id */
  collapsed: ReadonlySet<ID>
}

function load(): Set<ID> {
  return new Set(parseCollapsed(readLocal(FOLDER_COLLAPSED_KEY)))
}

export const useFolderCollapse = create<FolderCollapseState>(() => ({ collapsed: load() }))

/** もう無いフォルダの id を除き、上限まで（後から閉じたものを残す）にして保存する */
function save(next: Set<ID>): void {
  let folders: Readonly<Record<ID, unknown>> | null = null
  try {
    folders = getData().ideaFolders
  } catch {
    folders = null
  }
  const ids = [...next].filter((id) => !folders || Object.prototype.hasOwnProperty.call(folders, id))
  const kept = ids.slice(-FOLDER_COLLAPSED_MAX)
  writeLocal(FOLDER_COLLAPSED_KEY, kept.length ? JSON.stringify(kept) : null)
  useFolderCollapse.setState({ collapsed: new Set(kept) })
}

/** このフォルダを閉じているか（既定は開いている） */
export function useFolderCollapsed(id: ID): boolean {
  return useFolderCollapse((s) => s.collapsed.has(id))
}

/** 開け閉めを切り替える */
export function toggleFolder(id: ID): void {
  const next = new Set(useFolderCollapse.getState().collapsed)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  save(next)
}

/** 閉じていたら開く（中のカードを見せる時。何度呼んでも同じ） */
export function expandFolders(ids: readonly ID[]): void {
  const { collapsed } = useFolderCollapse.getState()
  if (!ids.some((id) => collapsed.has(id))) return
  const next = new Set(collapsed)
  for (const id of ids) next.delete(id)
  save(next)
}

/** テスト用: 保存してある状態から読み直す */
export function resetFolderCollapseForTests(): void {
  useFolderCollapse.setState({ collapsed: load() })
}

// この端末の状態を消した時（すべてのデータの削除・バックアップからの復元）は、覚えている状態も消す
if (typeof window !== 'undefined') {
  window.addEventListener(LOCAL_STATE_CLEARED, () => useFolderCollapse.setState({ collapsed: new Set() }))
}
