// スマホの画面キーボードに隠れる高さ（visualViewport で測る）。
// Android Chrome はキーボードの分だけ画面（レイアウトの表示領域）が縮む（index.html の interactive-widget=resizes-content）ので 0 のまま。
// iOS Safari は画面が縮まず、見えている範囲（visualViewport）だけが縮むので、その差を CSS 変数 --kb-inset に入れる。
// 原稿画面はこの分だけ高さを詰め、いちばん下の記号バーがキーボードのすぐ上に来るようにする（piece.css）。
import { useEffect } from 'react'

/** 拡大している時（ピンチ）は測らない */
const MAX_SCALE = 1.01

/**
 * layoutHeight（レイアウトの表示領域の高さ）のうち、見えている範囲（visualViewport）より下に隠れている高さ。
 * iOS ではキーボードを出しても innerHeight が変わらない版と見えている高さになる版があるので、
 * 呼ぶ側は innerHeight と documentElement.clientHeight の大きい方を渡す。
 */
export function keyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number; scale: number }): number {
  if (vv.scale > MAX_SCALE) return 0
  return Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop))
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let frame = 0
    let last = -1
    const apply = () => {
      const inset = keyboardInset(Math.max(window.innerHeight, root.clientHeight), vv)
      if (inset === last) return
      last = inset
      root.style.setProperty('--kb-inset', `${inset}px`)
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    }
    apply()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      root.style.removeProperty('--kb-inset')
    }
  }, [])
}
