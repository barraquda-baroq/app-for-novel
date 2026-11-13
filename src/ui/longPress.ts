// 一覧の行の操作メニューを開くきっかけ: デスクトップの右クリック（contextmenu）と、スマホの長押し（約0.5秒）。
// - 長押しは、指が動いた（スクロールし始めた）・離した・スクロールした時に取りやめる
// - 長押しでメニューを開いたら、指を離した時の「クリック」（リンクの移動）を取り消す
// - Android は長押しでも contextmenu が届くので、長押しで開いた直後のものは無視する（ブラウザのメニューも出さない）
// - キーボードのメニューキー（Shift+F10）の contextmenu は座標が 0 なので、押した要素の下に開く
// 文字の選択や iOS の長押しのメニュー（リンクのプレビュー）は CSS（user-select / -webkit-touch-callout）で止める。
// 2.9: アイデアのカードの長押し（「選んで移す」を始める）でも使う。その時は options で
// - touchOnly: 指・ペンの長押しだけ。マウスの右クリック・メニューキーはブラウザのメニューのまま
// - ignore: カードの中のボタンなどから始めた長押しは何もしない
// - swallowClick: 始めるとカードの高さが変わり、指を離した所が別のカードになるので、離した時のクリックはどこに届いても取り消す
import { useMemo, useRef, type MouseEvent, type PointerEvent } from 'react'
import { lightTap } from '../platform/haptics'

/** 長押しとみなす時間 */
export const LONG_PRESS_MS = 500
/** これ以上指が動いたら長押しをやめる（スクロール・なぞり） */
const MOVE_TOLERANCE = 10
/** 長押しで開いた後、続けて届く contextmenu を無視する時間 */
const DUPLICATE_MS = 1000
/** swallowClick: 指を離してからこの間にクリックが届かなければ、取り消すのをやめる（iOS は長押しの後にクリックを送らないことがある） */
export const LIFT_CLICK_MS = 400
/** swallowClick: 指を離さないままでも、この時間がたてば取り消すのをやめる（念のため） */
const SWALLOW_MAX_MS = 10_000

/** 長押しを始めない要素（ボタン・リンク・入力欄など。押せばそれ自体が動く） */
export const PRESS_IGNORE =
  'button, a[href], input, select, textarea, label, summary, [role="button"], [contenteditable]:not([contenteditable="false"])'

export interface MenuTriggerOptions {
  /** 指・ペンの長押しだけで開く。マウスの右クリック・メニューキーの contextmenu は止めず、ブラウザのメニューのまま */
  touchOnly?: boolean
  /** この要素（の中）から始めた長押しは無視する（ボタン・チェックボックス・リンクなど。PRESS_IGNORE） */
  ignore?: string
  /** 開いた後に指を離した時のクリックを、どの要素に届いても取り消す（開いた結果で並びが動き、指の下が別の要素になる時） */
  swallowClick?: boolean
}

export interface MenuTriggerHandlers {
  onContextMenu: (e: MouseEvent<HTMLElement>) => void
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onClickCapture: (e: MouseEvent<HTMLElement>) => void
}

/**
 * 長押しで開いた後、指を離した時のクリックを1回だけ、どの要素に届いても取り消す（document の capture で React より先に止める）。
 * 次に触れた時・指を離してから LIFT_CLICK_MS たっても届かなかった時・SWALLOW_MAX_MS たった時にやめる
 * （PopupMenu の swallowNextClick は1秒で切れるので、長く押したままだと間に合わない）
 */
function swallowClickAfterLift(): void {
  let timer = setTimeout(() => done(), SWALLOW_MAX_MS)
  const stop = (e: globalThis.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    done()
  }
  const lifted = () => {
    clearTimeout(timer)
    timer = setTimeout(() => done(), LIFT_CLICK_MS)
    window.removeEventListener('pointerup', lifted, true)
    window.removeEventListener('pointercancel', lifted, true)
  }
  const done = () => {
    clearTimeout(timer)
    document.removeEventListener('click', stop, true)
    document.removeEventListener('pointerdown', done, true)
    window.removeEventListener('pointerup', lifted, true)
    window.removeEventListener('pointercancel', lifted, true)
  }
  document.addEventListener('click', stop, true)
  // 次に触れたら取り消しをやめる（離した後のクリックが届かなかった時に、次のタップを取り消さない）
  document.addEventListener('pointerdown', done, true)
  window.addEventListener('pointerup', lifted, true)
  window.addEventListener('pointercancel', lifted, true)
}

/**
 * 長押し・右クリックを受けない押し方か: 要素の外（React の portal で描いたダイアログなど。React ではイベントが要素まで届く）、
 * または ignore に合う要素（要素の中のもの）から始めた
 */
function isIgnored(e: { target: EventTarget | null; currentTarget: HTMLElement }, ignore: string | undefined): boolean {
  const el = e.currentTarget
  const t = e.target
  if (!(t instanceof Node) || !el.contains(t)) return true
  if (!ignore) return false
  const start = t instanceof Element ? t : t.parentElement
  const hit = start?.closest(ignore)
  return Boolean(hit && el.contains(hit))
}

/** open(point, element): メニューを開く（point は画面上の座標、element は手を当てた要素） */
export function useMenuTrigger(
  open: (point: { x: number; y: number }, element: HTMLElement) => void,
  options: MenuTriggerOptions = {},
): MenuTriggerHandlers {
  const openRef = useRef(open)
  openRef.current = open
  const optionsRef = useRef(options)
  optionsRef.current = options
  return useMemo(() => {
    let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
    /** 長押しで開いた後の「クリック」を取り消す */
    let suppressClick = false
    /** 長押しで開いた時刻（続けて届く contextmenu を無視するため） */
    let pressOpenedAt = 0
    const cancel = () => {
      if (!press) return
      clearTimeout(press.timer)
      press = null
      window.removeEventListener('scroll', cancel, true)
    }
    /** 指で開いた時: 離した時のクリックを取り消す（swallowClick ならどこに届いても） */
    const holdClick = () => {
      if (optionsRef.current.swallowClick) swallowClickAfterLift()
      else suppressClick = true
    }
    const fire = (x: number, y: number, el: HTMLElement) => openRef.current({ x, y }, el)
    return {
      onPointerDown(e) {
        // 新しく触れた時は、前の長押しの取り消しを持ち越さない（クリックが届かなかった時のため）
        suppressClick = false
        if (e.pointerType === 'mouse' || !e.isPrimary || e.button > 0) return
        cancel()
        if (isIgnored(e, optionsRef.current.ignore)) return
        const el = e.currentTarget
        const x = e.clientX
        const y = e.clientY
        press = {
          x,
          y,
          timer: setTimeout(() => {
            press = null
            window.removeEventListener('scroll', cancel, true)
            holdClick()
            pressOpenedAt = Date.now()
            // 軽く振動させる（アプリは端末の振動、ブラウザは navigator.vibrate。振動できなくてもよい）
            lightTap()
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
        const fromTouch = press !== null
        const duplicate = Date.now() - pressOpenedAt < DUPLICATE_MS
        // 指だけの時: マウスの右クリック・メニューキーはブラウザのメニューのまま（止めない）
        if (optionsRef.current.touchOnly && !fromTouch && !duplicate) return
        if (isIgnored(e, optionsRef.current.ignore)) return
        e.preventDefault()
        if (duplicate) return
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
        // 指で開いた時（Android の長押し。タイマーより先に届く）は、離した時のクリックを取り消し、続けて届く contextmenu は無視する。
        // Android でも軽く振動させる
        if (fromTouch) {
          holdClick()
          pressOpenedAt = Date.now()
          lightTap()
        }
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
