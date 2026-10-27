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

export function useCollapsedChapters(titleId: ID): [Set<ID>, (chapterId: ID) => void] {
  const [collapsed, setCollapsed] = useState<Set<ID>>(() => new Set(load(titleId)))
  const toggle = useCallback(
    (chapterId: ID) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(chapterId)) next.delete(chapterId)
        else next.add(chapterId)
        try {
          sessionStorage.setItem(KEY(titleId), JSON.stringify([...next]))
        } catch {
          /* 保存できなくても動作は続ける */
        }
        return next
      })
    },
    [titleId],
  )
  return [collapsed, toggle]
}
