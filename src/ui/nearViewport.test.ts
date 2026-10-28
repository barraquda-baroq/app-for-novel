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

  it('登録した時に画面の近く（前後 200%）にある要素は、IntersectionObserver の知らせを待たずにマイクロタスクで切り替える', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    // 画面は 1024×768（jsdom の innerWidth・innerHeight）
    const at = (top: number, height = 100) => {
      const el = document.createElement('section')
      el.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height }) as DOMRect
      return el
    }
    const w = new NearViewportWatcher()
    const inView = at(100)
    const below = at(768 + 768 * 2 - 50) // 下の余白（画面2つ分）の中
    const far = at(768 * 4)
    const hidden = document.createElement('div') // 大きさ 0（表示されていない）
    const calls: string[] = []
    w.register(inView, () => calls.push('inView'))
    w.register(below, () => calls.push('below'))
    w.register(far, () => calls.push('far'))
    w.register(hidden, () => calls.push('hidden'))
    // 登録したその場では切り替えない（コミットが終わってから）
    expect(calls).toEqual([])
    await Promise.resolve()
    expect(calls).toEqual(['inView', 'below'])
    // 切り替えた要素はもう見張らない。遠い要素は IntersectionObserver で近づいた時に切り替える
    const io = FakeObserver.all.at(-1)!
    expect([...io.observed]).toEqual([far, hidden])
    io.trigger(far)
    expect(calls).toEqual(['inView', 'below', 'far'])

    // 目次で移動した後など: スクロールして近くに来た要素は check() ですぐに切り替える
    const later = at(768 * 5)
    w.register(later, () => calls.push('later'))
    await Promise.resolve()
    expect(calls).toHaveLength(3)
    later.getBoundingClientRect = () => ({ top: 10, bottom: 110, left: 0, right: 600, width: 600, height: 100 }) as DOMRect
    w.check()
    expect(calls.at(-1)).toBe('later')
  })

  it('スクロールする枠を基準にする時は、枠の前後 200% で測る（縦書きは横にスクロールする）', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const box = (left: number, width: number) =>
      ({ top: 0, bottom: 500, left, right: left + width, width, height: 500 }) as DOMRect
    const root = document.createElement('article')
    root.getBoundingClientRect = () => box(100, 400)
    const w = new NearViewportWatcher()
    w.setRoot(root)
    const near = document.createElement('section')
    near.getBoundingClientRect = () => box(-650, 300) // 枠の左（読み進める側）の余白（枠2つ分 = 800px）の中
    const far = document.createElement('section')
    far.getBoundingClientRect = () => box(-1500, 300)
    const calls: string[] = []
    w.register(near, () => calls.push('near'))
    w.register(far, () => calls.push('far'))
    await Promise.resolve()
    expect(calls).toEqual(['near'])
  })
})
