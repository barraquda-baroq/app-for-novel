// 本編の一覧で、幕に分けた話の幕の行を折りたたんだ話（この端末・このタブの間だけ覚えておく）。
// 行ごとに自分の状態だけを読むので（useSyncExternalStore）、1つ開閉しても変わった行だけが描き直される。
import { useCallback, useSyncExternalStore } from 'react'
import type { ID } from '../../../domain/types'

const KEY = 'novel-studio:collapsed-acts'

function load(): Set<ID> {
  try {
    const raw = sessionStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is ID => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

let collapsed: Set<ID> | null = null
const listeners = new Set<() => void>()

function current(): Set<ID> {
  collapsed ??= load()
  return collapsed
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function toggleActsCollapsed(pieceId: ID): void {
  const next = new Set(current())
  if (next.has(pieceId)) next.delete(pieceId)
  else next.add(pieceId)
  collapsed = next
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* 保存できなくても動作は続ける */
  }
  for (const fn of listeners) fn()
}

/** この話の幕の行を折りたたんでいるか（既定は開いている） */
export function useActsCollapsed(pieceId: ID): boolean {
  const get = useCallback(() => current().has(pieceId), [pieceId])
  return useSyncExternalStore(subscribe, get, get)
}
