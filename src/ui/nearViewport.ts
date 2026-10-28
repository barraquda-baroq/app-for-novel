// 長い本文を読む画面（通し読み・応募時の原稿）で、画面の近くに来た話だけルビ・傍点の要素を作るための仕組み。
// ルビの多い長編（数百話・数百万字）では、全話分の <ruby> を作ると数十万の要素になり開くのが遅くなる。
// 画面の外の話は組版されない（content-visibility: auto）ので、それまでは記号と読みを除いた文字だけを置き、
// 近づいたら（IntersectionObserver）ルビ・傍点の表示に切り替える。一度切り替えた話は戻さない。
// 印刷する時は、すべての話を切り替えてから印刷する。
import { createContext, useContext, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/** 要素を見張り、画面の近くに来たら onNear を1回呼ぶ。戻り値は見張りをやめる関数 */
export type RegisterNear = (el: Element, onNear: () => void) => () => void

/** 見張り役がない所（テストや、短い本文だけの画面）では、すぐに切り替える */
export const NearViewportContext = createContext<RegisterNear | null>(null)

/** 画面（スクロールする枠）の前後これだけの範囲に入ったら切り替える */
const MARGIN = '200%'

export class NearViewportWatcher {
  private readonly pending = new Map<Element, () => void>()
  private io: IntersectionObserver | null = null

  constructor() {
    this.setRoot(null)
  }

  /** スクロールする枠（null は画面全体）。縦書き・横書きの切り替えなどで枠が変わったら呼ぶ */
  setRoot(root: Element | null): void {
    this.io?.disconnect()
    if (typeof IntersectionObserver === 'undefined') {
      this.io = null
      this.flushAll()
      return
    }
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) this.fire(e.target)
      },
      { root, rootMargin: MARGIN },
    )
    for (const el of this.pending.keys()) this.io.observe(el)
  }

  readonly register: RegisterNear = (el, onNear) => {
    if (!this.io) {
      onNear()
      return () => {}
    }
    this.pending.set(el, onNear)
    this.io.observe(el)
    return () => {
      this.pending.delete(el)
      this.io?.unobserve(el)
    }
  }

  private fire(el: Element): void {
    const onNear = this.pending.get(el)
    if (!onNear) return
    this.pending.delete(el)
    this.io?.unobserve(el)
    onNear()
  }

  private flushAll(): void {
    for (const el of [...this.pending.keys()]) this.fire(el)
  }

  /** まだ切り替えていない話をすべて切り替える（印刷の前など） */
  upgradeAll(): void {
    flushSync(() => this.flushAll())
  }

  dispose(): void {
    this.io?.disconnect()
    this.io = null
    this.pending.clear()
  }
}

/**
 * 見張り役を作る。root はスクロールする枠（null は画面全体）を返す関数で、deps が変わるたびに付け直す。
 * 印刷の前には、すべての話を切り替える。
 */
export function useNearViewportWatcher(root: () => Element | null, deps: unknown[]): RegisterNear {
  const [watcher] = useState(() => new NearViewportWatcher())
  // 子の useEffect（見張りの登録）より前に枠を決める
  useLayoutEffect(() => {
    watcher.setRoot(root())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    const beforePrint = () => watcher.upgradeAll()
    window.addEventListener('beforeprint', beforePrint)
    return () => {
      window.removeEventListener('beforeprint', beforePrint)
      watcher.dispose()
    }
  }, [watcher])
  return watcher.register
}

/**
 * ref の要素が画面の近くに来たか（一度 true になったら戻らない）。enabled が false の間は見張らない。
 * 見張り役（NearViewportContext）がなければ最初から true。
 */
export function useNearViewport(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const register = useContext(NearViewportContext)
  const [near, setNear] = useState(() => register === null)
  useEffect(() => {
    const el = ref.current
    if (!enabled || near || !register || !el) return
    return register(el, () => setNear(true))
  }, [enabled, near, register, ref])
  return near || register === null
}
