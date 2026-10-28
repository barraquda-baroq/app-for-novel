// 折りたたんだ章の一覧（この端末・このタブの間だけ覚えておく）。
import { useCallback, useState } from 'react'
import type { ID } from '../../../domain/types'

const KEY = (titleId: ID) => `novel-studio:collapsed-chapters:${titleId}`

function load(titleId: ID): ID[] {
  try {
    const raw = sessionStorage.getItem(KEY(titleId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is ID => typeof v === 'string') : []
  } catch {
    return []
  }
}

function save(titleId: ID, collapsed: Set<ID>): void {
  try {
    sessionStorage.setItem(KEY(titleId), JSON.stringify([...collapsed]))
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

export interface CollapsedChapters {
  collapsed: Set<ID>
  toggle: (chapterId: ID) => void
  /** 章を開く（折りたたまれていなければ何もしない） */
  expand: (chapterId: ID) => void
}

export function useCollapsedChapters(titleId: ID): CollapsedChapters {
  const [collapsed, setCollapsed] = useState<Set<ID>>(() => new Set(load(titleId)))
  const toggle = useCallback(
    (chapterId: ID) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(chapterId)) next.delete(chapterId)
        else next.add(chapterId)
        save(titleId, next)
        return next
      })
    },
    [titleId],
  )
  const expand = useCallback(
    (chapterId: ID) => {
      setCollapsed((prev) => {
        if (!prev.has(chapterId)) return prev
        const next = new Set(prev)
        next.delete(chapterId)
        save(titleId, next)
        return next
      })
    },
    [titleId],
  )
  return { collapsed, toggle, expand }
}
