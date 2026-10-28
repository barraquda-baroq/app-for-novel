// 本編の一覧（話・章・メモ）で ↑↓ の後も、動かした行が押した指の下に残るようにする。
// src/ui/keepInPlace.ts の useKeepInPlace に、本編の一覧で必要な2点を補ったもの:
// - 行は React.memo で包んであり、動かしても props が変わらないと描き直されず位置合わせが走らないので、動かした行は必ず描き直す
// - ↑↓で章に出入りした話の行は、別の一覧（章の中／章の外）に作り直されるので、
//   作り直された行（同じ key）が動かす前の画面位置とフォーカスするボタンを引き継ぐ
import { useLayoutEffect, useReducer } from 'react'
import { useKeepInPlace } from '../../../ui/keepInPlace'

/** 作り直された行に引き継ぐ、動かす前の位置（同じ一覧の中で動いた時は描画後に捨てる） */
let carried: { key: string; top: number; focus: string[] } | null = null

function scrollByInstant(dy: number): void {
  try {
    window.scrollTo({ top: window.scrollY + dy, left: window.scrollX, behavior: 'instant' as ScrollBehavior })
  } catch {
    window.scrollTo(window.scrollX, window.scrollY + dy)
  }
}

/**
 * key は行のレコードの ID（作り直された行を見分ける）。
 * move(run, focus) で並べ替えを実行し、成功したら（run が true を返したら）描画後に行を元の画面位置に戻して、
 * focus の最初の押せるボタンにフォーカスする。
 */
export function useKeepMovedInPlace<T extends HTMLElement>(key: string) {
  const { ref, move } = useKeepInPlace<T>()
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  // 作り直された行なら、動かす前と同じ画面位置に戻し、押したボタンにフォーカスする
  useLayoutEffect(() => {
    const c = carried
    const el = ref.current
    if (!c || !el || c.key !== key) return
    carried = null
    const delta = el.getBoundingClientRect().top - c.top
    if (Math.abs(delta) >= 1) scrollByInstant(delta)
    for (const selector of c.focus) {
      const target = el.querySelector<HTMLButtonElement>(selector)
      if (target && !target.disabled) {
        target.focus({ preventScroll: true })
        break
      }
    }
  }, [key, ref])

  const moveInPlace = (run: () => boolean | undefined, focus: string[]) => {
    const top = ref.current?.getBoundingClientRect().top
    move(() => {
      if (!run()) return false
      rerender()
      if (top !== undefined) {
        carried = { key, top, focus }
        requestAnimationFrame(() => {
          if (carried?.key === key) carried = null
        })
      }
      return true
    }, focus)
  }

  return { ref, move: moveInPlace }
}
