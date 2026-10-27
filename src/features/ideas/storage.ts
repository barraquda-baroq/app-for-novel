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

const COLLAPSED_KEY = 'novel-studio:idea-collapsed'

/** ホームのアイデア領域で、折りたたんだ仕切り（sectionKey の一覧） */
export function useCollapsedSections(): [Set<string>, (key: string) => void, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(parseCollapsed(readLocal(COLLAPSED_KEY))))
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeLocal(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }, [])
  /** 折りたたんでいたら開く（何度呼んでも同じ） */
  const expand = useCallback((key: string) => {
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      writeLocal(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }, [])
  return [collapsed, toggle, expand]
}
