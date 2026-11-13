// 追加したアイデアのカードを見せる（スクロールして少しの間だけ目立たせる）ための小さな状態。
// 2.9: 見せる前に、カードの入っている仕切り（ホーム）とフォルダ（folderChain）を開く（revealIdeaInTree）。
// 見せるのは頼んだ直後だけ（REVEAL_FRESH_MS）。後でカードを描き直した時（ホームへ戻った・帯を開き直した）にもう一度は見せない。
import { createContext } from 'react'
import { create } from 'zustand'
import { effectiveFolderId, folderChain, sectionOf } from '../../domain/ideaFolders'
import type { ID } from '../../domain/types'
import { getData } from '../../store/appStore'
import { expandFolders } from './folderCollapse'
import { sectionKey } from './ideaLogic'

interface RevealState {
  /** 目立たせるアイデア */
  id: ID | null
  /** 同じアイデアをもう一度見せる時にも反応させるための連番 */
  seq: number
  /** そのカードまでスクロールしてフォーカスするか（false なら目立たせるだけ） */
  scroll: boolean
  /** 頼んだ時刻（Date.now()） */
  at: number
}

export const useReveal = create<RevealState>(() => ({ id: null, seq: 0, scroll: false, at: 0 }))

export function revealIdea(id: ID, scroll = true): void {
  useReveal.setState((s) => ({ id, seq: s.seq + 1, scroll, at: Date.now() }))
}

/**
 * 頼んでからこの時間（ミリ秒）より後に描いたカードは見せない。移すと入れ物が変わってカードを描き直すが、それは頼んだのと同じ時なので見せる
 */
export const REVEAL_FRESH_MS = 1000

/** 目立たせる時間（ミリ秒） */
export const REVEAL_MS = 2400

/**
 * 折りたたんだ仕切りを開く手段（sectionKey を渡す）。ホームのアイデア欄が渡す（タイトルの「アイデア」の仕切りは閉じられないので無い）
 */
export const IdeaSectionOpenContext = createContext<((key: string) => void) | null>(null)

/** カードの入っている仕切りとフォルダを開いてから、そのカードまでスクロールして目立たせる（移した後など） */
export function revealIdeaInTree(id: ID, openSection?: ((key: string) => void) | null): void {
  const data = getData()
  const idea = data.ideas[id]
  if (!idea) return
  openSection?.(sectionKey(sectionOf(data.titles, idea.titleId)))
  expandFolders(folderChain(data, effectiveFolderId(data, idea)).map((f) => f.id))
  revealIdea(id, true)
}
