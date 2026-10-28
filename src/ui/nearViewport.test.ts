import { afterEach, describe, expect, it, vi } from 'vitest'
import { NearViewportWatcher } from './nearViewport'

/** 呼ばれ方を覚えておく IntersectionObserver の代わり */
class FakeObserver {
  static all: FakeObserver[] = []
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(
    readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
    readonly options: { root: Element | null; rootMargin: string },
  ) {
    FakeObserver.all.push(this)
  }

  observe(el: Element) {
    this.observed.add(el)
  }

  unobserve(el: Element) {
    this.observed.delete(el)
  }

  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }

  /** el が画面の近くに来た（または離れた） */
  trigger(el: Element, isIntersecting = true) {
    this.callback([{ target: el, isIntersecting }])
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeObserver.all = []
})

describe('画面の近くに来た話だけ切り替える', () => {
  it('近くに来た時に1回だけ知らせ、枠を変えても待っている話を見張り続ける', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const w = new NearViewportWatcher()
    const a = document.createElement('section')
    const b = document.createElement('section')
    const onA = vi.fn()
    const onB = vi.fn()
    w.register(a, onA)
    const stopB = w.register(b, onB)
    const first = FakeObserver.all.at(-1)!
    expect(first.options.root).toBeNull()
    expect([...first.observed]).toEqual([a, b])

    first.trigger(a, false)
    expect(onA).not.toHaveBeenCalled()
    first.trigger(a)
    first.trigger(a)
    expect(onA).toHaveBeenCalledTimes(1)
    expect(first.observed.has(a)).toBe(false)

    // 縦書きにすると本文の枠が基準になる
    const doc = document.createElement('article')
    w.setRoot(doc)
    const second = FakeObserver.all.at(-1)!
    expect(first.disconnected).toBe(true)
    expect(second.options.root).toBe(doc)
    expect([...second.observed]).toEqual([b])

    // 見張りをやめた話は知らせない
    stopB()
    second.trigger(b)
    expect(onB).not.toHaveBeenCalled()
  })

  it('印刷の前などには、待っている話をすべて切り替える', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const w = new NearViewportWatcher()
    const calls: string[] = []
    for (const name of ['a', 'b', 'c']) w.register(document.createElement('div'), () => calls.push(name))
    w.upgradeAll()
    expect(calls).toEqual(['a', 'b', 'c'])
    w.upgradeAll()
    expect(calls).toHaveLength(3)
  })

  it('IntersectionObserver がない環境では、すぐに切り替える', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const w = new NearViewportWatcher()
    const onNear = vi.fn()
    w.register(document.createElement('div'), onNear)
    expect(onNear).toHaveBeenCalledTimes(1)
  })
})
