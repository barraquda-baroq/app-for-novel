import type { ID } from './types'

let fallbackCounter = 0

export function newId(): ID {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 非セキュアコンテキスト（file:// 等）向けのフォールバック
  fallbackCounter += 1
  return `id-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function now(): number {
  return Date.now()
}

export interface Ordered {
  id: ID
  order: number
}

export function byOrder<T extends Ordered>(a: T, b: T): number {
  return a.order - b.order || a.id.localeCompare(b.id)
}

export function nextOrder(items: Ordered[]): number {
  return items.reduce((max, it) => Math.max(max, it.order), -1) + 1
}

/** order を持つレコード群の中で id を1つ上/下に動かす。変更が必要なレコードだけを返す */
export function stepOrder<T extends Ordered>(items: T[], id: ID, dir: -1 | 1): T[] {
  const sorted = [...items].sort(byOrder)
  const idx = sorted.findIndex((it) => it.id === id)
  const target = idx + dir
  if (idx < 0 || target < 0 || target >= sorted.length) return []
  const moved = [...sorted]
  ;[moved[idx], moved[target]] = [moved[target], moved[idx]]
  // 並びを 0..n-1 に正規化し、変わったものだけ返す
  const changed: T[] = []
  moved.forEach((it, i) => {
    if (it.order !== i) changed.push({ ...it, order: i })
  })
  return changed
}

export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const i = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, i), item, ...list.slice(i)]
}

export function removeValue<T>(list: readonly T[], value: T): T[] {
  return list.filter((v) => v !== value)
}
