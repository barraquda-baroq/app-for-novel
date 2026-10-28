// 並べ替え（↑↓）の後も、動かしたカードが画面の同じ位置（押した指の下）に残るようにする。
// カードが動いた分だけページをスクロールし、押したボタンにフォーカスを戻すので、続けて押すとそのまま動かし続けられる。
import { useLayoutEffect, useRef } from 'react'

interface Pending {
  /** 動かす前のカードの画面上の位置 */
  top: number
  /** 動かした後にフォーカスするボタンのセレクタ（押せる最初のもの） */
  focus: string[]
}

function scrollByInstant(dy: number): void {
  try {
    window.scrollTo({ top: window.scrollY + dy, left: window.scrollX, behavior: 'instant' as ScrollBehavior })
  } catch {
    window.scrollTo(window.scrollX, window.scrollY + dy)
  }
}

export function useKeepInPlace<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const pending = useRef<Pending | null>(null)

  // 並べ替えの結果が描画された直後（画面に出る前）に位置とフォーカスを合わせる
  useLayoutEffect(() => {
    const p = pending.current
    const el = ref.current
    if (!p || !el) return
    pending.current = null
    const delta = el.getBoundingClientRect().top - p.top
    if (Math.abs(delta) >= 1) scrollByInstant(delta)
    for (const selector of p.focus) {
      const target = el.querySelector<HTMLButtonElement>(selector)
      if (target && !target.disabled) {
        target.focus({ preventScroll: true })
        break
      }
    }
  })

  /**
   * run（並べ替えの操作）を実行する。成功したら（true を返したら）描画後にカードを元の画面位置に戻し、
   * focus の最初の押せるボタンにフォーカスする（端に着いて押せなくなったら次の候補）。
   */
  const move = (run: () => boolean | undefined, focus: string[]) => {
    const el = ref.current
    pending.current = el ? { top: el.getBoundingClientRect().top, focus } : null
    if (!run()) pending.current = null
  }

  return { ref, move }
}
