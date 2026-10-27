// ハッシュでの画面遷移ではスクロール位置が前の画面のまま残るので、画面を開いた時に先頭へ戻す。
import { useEffect, useRef } from 'react'

export function scrollToTop(): void {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
  } catch {
    window.scrollTo(0, 0)
  }
}

/** 画面を開いた時に一度だけ先頭へスクロールする（skip のときは何もしない） */
export function useScrollTopOnMount(skip = false): void {
  const skipRef = useRef(skip)
  useEffect(() => {
    if (!skipRef.current) scrollToTop()
  }, [])
}
