// 原稿画面の欄ごとの検索（採用原稿・推敲バージョン）の語と、窓が開いているか。
// 端末のメモリだけに持つ（保存・同期はしない）。原稿画面は話ごとに作り直す（PieceWorkspace の key）が、
// このストアはモジュールの中にあるので、話・幕・タイトルを移っても語と窓は残る（読み込み直すと消える）
import { create } from 'zustand'

/** active = 採用原稿の欄、compare = 推敲バージョンの欄 */
export type SearchSlot = 'active' | 'compare'

export interface SlotSearch {
  open: boolean
  query: string
}

interface FieldSearchState {
  active: SlotSearch
  compare: SlotSearch
  set: (slot: SearchSlot, patch: Partial<SlotSearch>) => void
}

const CLOSED: SlotSearch = { open: false, query: '' }

export const useFieldSearchStore = create<FieldSearchState>((set) => ({
  active: CLOSED,
  compare: CLOSED,
  set: (slot, patch) => set((s) => ({ [slot]: { ...s[slot], ...patch } })),
}))

export function resetFieldSearchForTests(): void {
  useFieldSearchStore.setState({ active: CLOSED, compare: CLOSED })
}
