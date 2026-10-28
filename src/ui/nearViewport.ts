// 長い本文を読む画面（通し読み・応募時の原稿）や長い一覧で、画面の近くに来た所だけルビ・傍点の要素を作るための仕組み。
// ルビの多い長編（数百話・数百万字）では、全話分の <ruby> を作ると数十万の要素になり開くのが遅くなる。
// 画面の外の話は組版されない（content-visibility: auto）ので、それまでは記号と読みを除いた文字だけを置き、
// 近づいたら（IntersectionObserver）ルビ・傍点の表示に切り替える。一度切り替えた話は戻さない。
// 開いた時・目次で移動した時に画面の近くにある話は、描く前に（同じフレームで）切り替える（読みが後から現れないように）。
// 印刷する時は、すべての話を切り替えてから印刷する。
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/** 要素を見張り、画面の近くに来たら onNear を1回呼ぶ。戻り値は見張りをやめる関数 */
export type RegisterNear = (el: Element, onNear: () => void) => () => void

/** 見張り役がない所（テストや、短い本文だけの画面）では、すぐに切り替える */
export const NearViewportContext = createContext<RegisterNear | null>(null)

/** 画面（スクロールする枠）の前後これだけの範囲に入ったら切り替える（isNear の範囲と合わせる） */
const MARGIN = '200%'
const MARGIN_RATIO = 2

export class NearViewportWatcher {
  private readonly pending = new Map<Element, () => void>()
  private io: IntersectionObserver | null = null
  private root: Element | null = null
  private scheduled = false

  constructor() {
    this.setRoot(null)
  }

  /** スクロールする枠（null は画面全体）。縦書き・横書きの切り替えなどで枠が変わったら呼ぶ */
  setRoot(root: Element | null): void {
    this.io?.disconnect()
    this.root = root
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
    // 新しい枠の近くにある話は、知らせ（描いた後に届く）を待たずに切り替える
    if (this.pending.size > 0) this.scheduleCheck()
  }

  readonly register: RegisterNear = (el, onNear) => {
    if (!this.io) {
      onNear()
      return () => {}
    }
    this.pending.set(el, onNear)
    this.io.observe(el)
    // 今すでに画面の近くにあれば、描く前に切り替える（続けて登録される話の分も、まとめて1回で測る）
    this.scheduleCheck()
    return () => {
      this.pending.delete(el)
      this.io?.unobserve(el)
    }
  }

  /** 画面（枠）の近くにあるか。IntersectionObserver の rootMargin と同じ範囲で測る */
  private isNear(el: Element): boolean {
    const r = el.getBoundingClientRect()
    // 表示されていない要素（display: none など）は近くにない扱い（IntersectionObserver と同じ）
    if (r.width === 0 && r.height === 0) return false
    const b = this.root ? this.root.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth }
    const h = (b.bottom - b.top) * MARGIN_RATIO
    const w = (b.right - b.left) * MARGIN_RATIO
    return r.bottom >= b.top - h && r.top <= b.bottom + h && r.right >= b.left - w && r.left <= b.right + w
  }

  /**
   * 今、画面の近くにある話をすぐに切り替える（描く前に呼ぶ）。React の描画・コミットの途中では呼ばない
   * （その時は scheduleCheck を使う）。
   */
  check(): void {
    if (!this.io || this.pending.size === 0) return
    // 先に全部測る（レイアウトは1回だけ）
    const near = [...this.pending.keys()].filter((el) => this.isNear(el))
    if (near.length === 0) return
    flushSync(() => {
      for (const el of near) this.fire(el)
    })
  }

  /** コミットが終わってから（マイクロタスクで。ブラウザが描く前に）check する */
  scheduleCheck(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.check()
    })
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

export interface NearViewportControls {
  /** NearViewportContext に渡す。IntersectionObserver がない環境では null（すぐに切り替える） */
  register: RegisterNear | null
  /** 目次で移動した直後など、画面の近くの話をすぐに切り替える（イベントの処理の中で呼ぶ） */
  check: () => void
  /** 描画の途中（layout effect など）から、コミットの後・描く前に切り替える */
  scheduleCheck: () => void
}

/**
 * 見張り役を作る。root はスクロールする枠（null は画面全体）を返す関数で、deps が変わるたびに付け直す。
 * 印刷の前には、すべての話を切り替える。
 */
export function useNearViewportWatcher(root: () => Element | null, deps: unknown[]): NearViewportControls {
  // IntersectionObserver がない環境（テストの jsdom など）では見張らず、最初からルビ・傍点で表示する
  const [watcher] = useState(() => (typeof IntersectionObserver === 'undefined' ? null : new NearViewportWatcher()))
  // 子の登録（コミットの後のマイクロタスク）より前に枠を決める
  useLayoutEffect(() => {
    watcher?.setRoot(root())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    if (!watcher) return
    const beforePrint = () => watcher.upgradeAll()
    window.addEventListener('beforeprint', beforePrint)
    return () => {
      window.removeEventListener('beforeprint', beforePrint)
      watcher.dispose()
    }
  }, [watcher])
  return useMemo(
    () => ({
      register: watcher ? watcher.register : null,
      check: () => watcher?.check(),
      scheduleCheck: () => watcher?.scheduleCheck(),
    }),
    [watcher],
  )
}

/**
 * ref の要素が画面の近くに来たか（一度 true になったら戻らない）。enabled が false の間は見張らない。
 * 見張り役（NearViewportContext）がなければ最初から true。
 */
export function useNearViewport(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const register = useContext(NearViewportContext)
  const [near, setNear] = useState(() => register === null)
  // 画面の近くにあれば描く前に切り替えられるよう、レイアウトの段階で登録する。
  // ただし親の要素（ref）は子の layout effect の時点ではまだ付いていないので、コミットが終わってから（マイクロタスクで）登録する
  useLayoutEffect(() => {
    if (!enabled || near || !register) return
    let live = true
    let stop: (() => void) | undefined
    queueMicrotask(() => {
      if (live && ref.current) stop = register(ref.current, () => setNear(true))
    })
    return () => {
      live = false
      stop?.()
    }
  }, [enabled, near, register, ref])
  return near || register === null
}
