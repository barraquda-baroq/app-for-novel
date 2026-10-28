// 追加したアイデアのカードを見せる（スクロールして少しの間だけ目立たせる）ための小さな状態。
import { create } from 'zustand'
import type { ID } from '../../domain/types'

interface RevealState {
  /** 目立たせるアイデア */
  id: ID | null
  /** 同じアイデアをもう一度見せる時にも反応させるための連番 */
  seq: number
  /** そのカードまでスクロールしてフォーカスするか（false なら目立たせるだけ） */
  scroll: boolean
}

export const useReveal = create<RevealState>(() => ({ id: null, seq: 0, scroll: false }))

export function revealIdea(id: ID, scroll = true): void {
  useReveal.setState((s) => ({ id, seq: s.seq + 1, scroll }))
}

/** 目立たせる時間（ミリ秒） */
export const REVEAL_MS = 2400
