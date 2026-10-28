// 端末ごとのちょっとした表示状態（折りたたみ・最後に選んだ表示など）を localStorage に覚えておく。
// プライベートブラウズ等で使えなくても動作は続ける。
import { useCallback, useState } from 'react'
import { parseCollapsed } from './ideaLogic'

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

export const COLLAPSED_KEY = 'novel-studio:idea-collapsed'

export interface CollapsedSections {
  /** 折りたたんだ仕切り（sectionKey の一覧） */
  collapsed: Set<string>
  toggle: (key: string) => void
  /** 折りたたんでいたら開く（何度呼んでも同じ） */
  expand: (key: string) => void
  /** 折りたたむ仕切りをまとめて決める（すべて折りたたむ／すべて開く） */
  setAll: (keys: string[]) => void
}

/** ホームのアイデア領域で、折りたたんだ仕切り。この端末に覚えておく */
export function useCollapsedSections(): CollapsedSections {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(parseCollapsed(readLocal(COLLAPSED_KEY))))
  const save = (next: Set<string>) => writeLocal(COLLAPSED_KEY, next.size ? JSON.stringify([...next]) : null)
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      save(next)
      return next
    })
  }, [])
  const expand = useCallback((key: string) => {
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      save(next)
      return next
    })
  }, [])
  const setAll = useCallback((keys: string[]) => {
    const next = new Set(keys)
    save(next)
    setCollapsed(next)
  }, [])
  return { collapsed, toggle, expand, setAll }
}
