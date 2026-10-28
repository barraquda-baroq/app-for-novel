// ホームのスクロール位置を、履歴の項目ごとに控えておき、「戻る」で戻ってきた時にその位置へ戻す。
// 共通の仕組み（Layout）も同じことをするが、画面が切り替わる瞬間にページの高さが縮んでスクロール位置が 0 に
// 詰められると、その 0 がホームの位置として記録されてしまうことがある。アイデアが多いホームでは先頭へ戻されると
// 探し直しになるので、ホームでスクロールした位置をホーム自身でも控えておく。
// 新しく開いた時（PUSH）は何もしない（先頭から表示する共通の動きのまま）。
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

const KEY = 'novel-studio:home-scroll'
/** 控えておく履歴の項目の数（古いものから捨てる） */
const MAX_ENTRIES = 30

function read(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function save(entryKey: string, y: number): void {
  try {
    const memory = read()
    delete memory[entryKey]
    memory[entryKey] = Math.max(0, Math.round(y))
    const keys = Object.keys(memory)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete memory[k]
    sessionStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    /* 控えられなくても動作は続ける */
  }
}

export function useHomeScrollMemory(): void {
  const { key: entryKey } = useLocation()
  const navType = useNavigationType()
  // 開いた時の状態（戻ってきたかどうか）
  const opened = useRef({ navType, entryKey })

  // スクロールした位置を控える。画面が切り替わる時は、ページの高さが変わって位置が詰められる前に
  // （描画の確定と同時に）記録をやめるので、詰められた 0 で上書きされない
  useLayoutEffect(() => {
    let y = 0
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      if (dirty) save(entryKey, y)
      dirty = false
    }
    const onScroll = () => {
      y = window.scrollY
      dirty = true
      clearTimeout(timer)
      timer = setTimeout(flush, 200)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
      flush()
    }
  }, [entryKey])

  // 「戻る／進む」で戻ってきた時だけ、控えた位置へ戻す（共通の仕組みが戻した後に、同じ描画の中で上書きする）
  useEffect(() => {
    if (opened.current.navType !== 'POP') return
    const y = read()[opened.current.entryKey]
    if (typeof y !== 'number' || y <= 0) return
    const raf = requestAnimationFrame(() => window.scrollTo(0, y))
    return () => cancelAnimationFrame(raf)
  }, [])
}
