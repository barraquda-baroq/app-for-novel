// 一覧の行の操作メニューを開くきっかけ: デスクトップの右クリック（contextmenu）と、スマホの長押し（約0.5秒）。
// - 長押しは、指が動いた（スクロールし始めた）・離した・スクロールした時に取りやめる
// - 長押しでメニューを開いたら、指を離した時の「クリック」（リンクの移動）を取り消す
// - Android は長押しでも contextmenu が届くので、長押しで開いた直後のものは無視する（ブラウザのメニューも出さない）
// - キーボードのメニューキー（Shift+F10）の contextmenu は座標が 0 なので、押した要素の下に開く
// 文字の選択や iOS の長押しのメニュー（リンクのプレビュー）は CSS（user-select / -webkit-touch-callout）で止める。
import { useMemo, useRef, type MouseEvent, type PointerEvent } from 'react'

/** 長押しとみなす時間 */
export const LONG_PRESS_MS = 500
/** これ以上指が動いたら長押しをやめる（スクロール・なぞり） */
const MOVE_TOLERANCE = 10
/** 長押しで開いた後、続けて届く contextmenu を無視する時間 */
const DUPLICATE_MS = 1000

export interface MenuTriggerHandlers {
  onContextMenu: (e: MouseEvent<HTMLElement>) => void
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onClickCapture: (e: MouseEvent<HTMLElement>) => void
}

/** open(point, element): メニューを開く（point は画面上の座標、element は手を当てた要素） */
export function useMenuTrigger(open: (point: { x: number; y: number }, element: HTMLElement) => void): MenuTriggerHandlers {
  const openRef = useRef(open)
  openRef.current = open
  return useMemo(() => {
    let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
    /** 長押しで開いた後の「クリック」を取り消す */
    let suppressClick = false
    /** 長押し（タイマー）で開いた時刻（続けて届く contextmenu を無視するため） */
    let pressOpenedAt = 0
    const cancel = () => {
      if (!press) return
      clearTimeout(press.timer)
      press = null
      window.removeEventListener('scroll', cancel, true)
    }
    const fire = (x: number, y: number, el: HTMLElement) => openRef.current({ x, y }, el)
    return {
      onPointerDown(e) {
        // 新しく触れた時は、前の長押しの取り消しを持ち越さない（クリックが届かなかった時のため）
        suppressClick = false
        if (e.pointerType === 'mouse' || !e.isPrimary || e.button > 0) return
        cancel()
        const el = e.currentTarget
        const x = e.clientX
        const y = e.clientY
        press = {
          x,
          y,
          timer: setTimeout(() => {
            press = null
            window.removeEventListener('scroll', cancel, true)
            suppressClick = true
            pressOpenedAt = Date.now()
            try {
              navigator.vibrate?.(10)
            } catch {
              /* 振動できなくてもよい */
            }
            fire(x, y, el)
          }, LONG_PRESS_MS),
        }
        window.addEventListener('scroll', cancel, true)
      },
      onPointerMove(e) {
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu(e) {
        e.preventDefault()
        if (Date.now() - pressOpenedAt < DUPLICATE_MS) return
        const fromTouch = press !== null
        cancel()
        const el = e.currentTarget
        let x = e.clientX
        let y = e.clientY
        if (x === 0 && y === 0) {
          // キーボードから開いた: 押した要素（フォーカスのある要素）の下
          const r = (e.target instanceof Element ? e.target : el).getBoundingClientRect()
          x = r.left + 16
          y = r.bottom
        }
        // 指で開いた時（Android の長押し）は、離した時のクリックを取り消す
        if (fromTouch) suppressClick = true
        fire(x, y, el)
      },
      onClickCapture(e) {
        if (!suppressClick) return
        suppressClick = false
        e.preventDefault()
        e.stopPropagation()
      },
    }
  }, [])
}
