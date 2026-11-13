// アイデアのカードを選んでまとめて移す（2.9。「選んで移す」）時の、選んでいるカード。1つの仕切りの中だけで選ぶ
// （ほかの仕切りで始めると、前の選択はやめる）。この画面の間だけ覚える（保存しない）。
// カードの行は自分が選ばれているかだけを読むので（useIsSelected）、1つ選んでも変わった行だけが描き直される。
// ［選んで移す］のほか、スマホではカードの長押し（pressSelect）、カードの［移動］のダイアログの「ほかのカードも選んでまとめて移す」でも始まる。
import { create } from 'zustand'
import type { ID } from '../../domain/types'

interface SelectionState {
  /** 選んでいる仕切り（sectionKey）。null = 選んでいない */
  section: string | null
  ids: ReadonlySet<ID>
}

export const useSelection = create<SelectionState>(() => ({ section: null, ids: new Set() }))

/** その仕切りで選び始める（ほかの仕切りの選択はやめる）。ids: 初めから選んでおくカード（カードの長押し・移動のダイアログから始めた時） */
export function startSelect(section: string, ids: readonly ID[] = []): void {
  useSelection.setState({ section, ids: new Set(ids) })
}

/**
 * カードの長押し（指）: この仕切りで選んでいれば、そのカードを選ぶ・外す。そうでなければ、そのカードを選んだ状態で始める
 * （ほかの仕切りの選択はやめる）
 */
export function pressSelect(section: string, id: ID): void {
  if (useSelection.getState().section === section) toggleSelected(id)
  else startSelect(section, [id])
}

/** 選ぶのをやめる（Esc・やめる・移した後・画面を離れた時） */
export function stopSelect(): void {
  if (useSelection.getState().section === null) return
  useSelection.setState({ section: null, ids: new Set() })
}

/** そのカードを選ぶ・外す */
export function toggleSelected(id: ID): void {
  const { section, ids } = useSelection.getState()
  if (section === null) return
  const next = new Set(ids)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  useSelection.setState({ ids: next })
}

/** まとめて選ぶ・外す（フォルダの見出しの□） */
export function setSelected(list: readonly ID[], on: boolean): void {
  const { section, ids } = useSelection.getState()
  if (section === null) return
  const next = new Set(ids)
  for (const id of list) {
    if (on) next.add(id)
    else next.delete(id)
  }
  useSelection.setState({ ids: next })
}

/** もう無い（その仕切りに見えない）カードを選択から除く */
export function pruneSelection(alive: (id: ID) => boolean): void {
  const { ids } = useSelection.getState()
  const next = [...ids].filter(alive)
  if (next.length !== ids.size) useSelection.setState({ ids: new Set(next) })
}

/** その仕切りで選んでいる最中か */
export function useSelectMode(section: string): boolean {
  return useSelection((s) => s.section === section)
}

/** そのカードが選ばれているか（その仕切りで選んでいない時は null） */
export function useIsSelected(section: string, id: ID): boolean | null {
  return useSelection((s) => (s.section === section ? s.ids.has(id) : null))
}

/** list のうち選んでいる数（その仕切りで選んでいない時は 0） */
export function useSelectedCount(section: string, list: readonly ID[]): number {
  return useSelection((s) => (s.section === section ? list.reduce((n, id) => (s.ids.has(id) ? n + 1 : n), 0) : 0))
}
