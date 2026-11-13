// ホームの4つの帯（タイトル・アイデア・相対比較・資料。2.9）の開け閉め。
// アプリを起動した時と読み込み直した時だけ、4つとも閉じている（モジュールの中だけで覚え、保存しない）。
// 開けた帯は、タイトルの画面などから戻ってきても開いたまま（ネイティブのアプリを裏から戻した時も、JavaScript は続いているので同じ）。
// 帯ごとに自分の状態だけを読むので（useSyncExternalStore）、1つ開け閉めしても、その帯と、全部を見るホームの画面だけが描き直される。
import { useCallback, useSyncExternalStore } from 'react'
import type { HomeView } from './homeLogic'

let open: ReadonlySet<HomeView> = new Set<HomeView>()
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(next: ReadonlySet<HomeView>): void {
  open = next
  for (const fn of listeners) fn()
}

function getOpen(): ReadonlySet<HomeView> {
  return open
}

/** その帯を開く（開いていれば何もしない） */
export function openBand(area: HomeView): void {
  if (open.has(area)) return
  set(new Set([...open, area]))
}

/** その帯の開け閉めを切り替える */
export function toggleBand(area: HomeView): void {
  const next = new Set(open)
  if (next.has(area)) next.delete(area)
  else next.add(area)
  set(next)
}

/** いま開いているか（読むだけ。描画の外から） */
export function isBandOpen(area: HomeView): boolean {
  return open.has(area)
}

/** その帯が開いているか（既定は閉じている） */
export function useHomeBand(area: HomeView): boolean {
  const get = useCallback(() => open.has(area), [area])
  return useSyncExternalStore(subscribe, get, get)
}

/** 開いている帯（開け閉めのたびに新しい Set になる） */
export function useOpenBands(): ReadonlySet<HomeView> {
  return useSyncExternalStore(subscribe, getOpen, getOpen)
}

/** 起動した時と同じ（4つとも閉じる。テスト用） */
export function resetHomeBandsForTests(): void {
  set(new Set())
}
