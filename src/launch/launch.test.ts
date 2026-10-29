// 外観と起動アニメーション（src/launch/launch.js。index.html に埋め込むスクリプト）。
// 埋め込むのと同じ中身（?raw）をこのページで動かして確かめる。canvas は jsdom に無いので、何も描かない偽物にする
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import source from './launch.js?raw'

type Appearance = 'white' | 'dark' | 'deep-dark'
interface Env {
  enabled: boolean
  native: boolean
  webdriver: boolean
  forced: boolean
  shownInSession: boolean
  hidden?: boolean
  reducedMotion: boolean
}
interface ControllerOptions {
  still?: boolean
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  onFadeOut: (reason: string) => void
  onRemove: () => void
}
interface Controller {
  start(): void
  animationEnded(): void
  stillShown(): void
  appReady(): void
  skip(): void
  state(): string
}
interface LaunchApi {
  boot(): Appearance
  appReady(): void
  active(): boolean
  resolveAppearance(prefs: unknown, systemDark: boolean): Appearance
  animationTheme(appearance: string): string
  decide(env: Env): 'none' | 'play' | 'still'
  createController(o: ControllerOptions): Controller
  workerSource(): string
  TIMING: { stillMs: number; capMs: number; fadeMs: number }
  DURATION: number
  PALETTES: Record<string, { bg: string }>
}

const PREFS_KEY = 'novel-studio:prefs'
const w = window as unknown as {
  NovelStudioLaunch?: LaunchApi
  Capacitor?: unknown
}

/** ページを開き直したことにする（スクリプトを読み込み直す。sessionStorage・localStorage は残る） */
function load(): LaunchApi {
  delete w.NovelStudioLaunch
  new Function('window', 'document', source)(window, document)
  return w.NovelStudioLaunch!
}

/** canvas の偽物（描く命令の数だけ数える） */
let draws = 0
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} }
  const props: Record<string, unknown> = {}
  return new Proxy(props, {
    get(t, key: string) {
      if (key in t) return t[key]
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient
      if (key === 'drawImage') return () => void draws++
      return () => undefined
    },
    set(t, key: string, v) {
      t[key] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

/** 端末の設定（prefers-color-scheme・prefers-reduced-motion） */
function media({ dark = false, reduced = false } = {}) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('dark') ? dark : q.includes('reduced-motion') ? reduced : false,
  })) as unknown as typeof window.matchMedia
}

function setWebdriver(on: boolean) {
  Object.defineProperty(navigator, 'webdriver', { value: on, configurable: true })
}

const overlay = () => document.getElementById('ns-launch')
/** 時計を進める（setTimeout・requestAnimationFrame） */
const t = (ms: number) => vi.advanceTimersByTime(ms)

beforeEach(() => {
  draws = 0
  localStorage.clear()
  sessionStorage.clear()
  media()
  setWebdriver(false)
  delete w.Capacitor
  window.history.replaceState(null, '', '/')
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff">'
  document.documentElement.removeAttribute('data-theme')
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext as never)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  overlay()?.remove()
})

describe('外観（最初の描画の前）', () => {
  it('設定の外観を、端末の設定によらずそのまま使う。「端末の設定に合わせる」は端末がダークならダーク', () => {
    const api = load()
    for (const dark of [false, true]) {
      expect(api.resolveAppearance({ theme: 'white' }, dark)).toBe('white')
      expect(api.resolveAppearance({ theme: 'dark' }, dark)).toBe('dark')
      expect(api.resolveAppearance({ theme: 'deep-dark' }, dark)).toBe('deep-dark')
    }
    expect(api.resolveAppearance({ theme: 'system' }, true)).toBe('dark')
    expect(api.resolveAppearance({ theme: 'system' }, false)).toBe('white')
    // 設定が無い・壊れている・知らない値は「端末の設定に合わせる」
    expect(api.resolveAppearance({}, true)).toBe('dark')
    expect(api.resolveAppearance(null, false)).toBe('white')
    expect(api.resolveAppearance({ theme: 'sepia' }, true)).toBe('dark')
    // 1.x の「ライト」はホワイト
    expect(api.resolveAppearance({ theme: 'light' }, true)).toBe('white')
  })

  it('外観 → アニメーションの色: ホワイトは light（白地に赤）、ダークは dark（黒地に緑）、ディープダークは deep（暗い緑）', () => {
    const api = load()
    expect(api.animationTheme('white')).toBe('light')
    expect(api.animationTheme('dark')).toBe('dark')
    expect(api.animationTheme('deep-dark')).toBe('deep')
    expect(api.PALETTES.light.bg).toBe('#fbfcfe')
    expect(api.PALETTES.dark.bg).toBe('#050607')
  })

  it('boot は <html data-theme> とブラウザの枠の色を決める（起動アニメーションを出さない時も）', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'deep-dark', launchAnimation: false }))
    expect(load().boot()).toBe('deep-dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('deep-dark')
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#0e0f11')
    expect(overlay()).toBeNull()

    media({ dark: true })
    localStorage.setItem(PREFS_KEY, '{壊れた')
    setWebdriver(true)
    expect(load().boot()).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#17181b')
  })
})

describe('出すかどうか（decide）', () => {
  const base: Env = { enabled: true, native: false, webdriver: false, forced: false, shownInSession: false, reducedMotion: false }

  it('Web 版はウインドウ・タブの最初の1回だけ（再読み込みでは出さない）', () => {
    const { decide } = load()
    expect(decide(base)).toBe('play')
    expect(decide({ ...base, shownInSession: true })).toBe('none')
  })

  it('Web 版で見えていないタブ（裏で開いた・ブラウザの先読み）では出さない（印はそのタブが見えた時に付ける。boot のテスト）', () => {
    const { decide } = load()
    expect(decide({ ...base, hidden: true })).toBe('none')
    expect(decide({ ...base, hidden: true, forced: true, webdriver: true })).toBe('none')
    expect(decide({ ...base, hidden: true, native: true })).toBe('play')
  })

  it('アプリは起動のたびに出す', () => {
    const { decide } = load()
    expect(decide({ ...base, native: true })).toBe('play')
    expect(decide({ ...base, native: true, shownInSession: true })).toBe('play')
  })

  it('設定でオフにすると出さない（強制しても、アプリでも）', () => {
    const { decide } = load()
    expect(decide({ ...base, enabled: false })).toBe('none')
    expect(decide({ ...base, enabled: false, forced: true, webdriver: true })).toBe('none')
    expect(decide({ ...base, enabled: false, native: true })).toBe('none')
  })

  it('テスト（navigator.webdriver）では、強制した時だけ出す', () => {
    const { decide } = load()
    expect(decide({ ...base, webdriver: true })).toBe('none')
    expect(decide({ ...base, webdriver: true, forced: true })).toBe('play')
    // 強制しても、同じウインドウの再読み込みでは出さない
    expect(decide({ ...base, webdriver: true, forced: true, shownInSession: true })).toBe('none')
  })

  it('視差効果を減らす設定では、動かさずに最後の絵だけ出す', () => {
    const { decide } = load()
    expect(decide({ ...base, reducedMotion: true })).toBe('still')
    expect(decide({ ...base, reducedMotion: true, native: true })).toBe('still')
    expect(decide({ ...base, reducedMotion: true, shownInSession: true })).toBe('none')
  })
})

describe('消すまでの流れ（createController）', () => {
  function setup(still = false) {
    const events: string[] = []
    const c = load().createController({
      still,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      onFadeOut: (reason) => events.push(`fade:${reason}@${Date.now() - t0}`),
      onRemove: () => events.push(`remove@${Date.now() - t0}`),
    })
    const t0 = Date.now()
    return { c, events }
  }

  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  it('アニメーションの終わりとアプリの知らせの両方がそろってから消し始め、0.25秒で取り除く', () => {
    const { c, events } = setup()
    c.start()
    expect(c.state()).toBe('playing')
    vi.advanceTimersByTime(1750)
    c.animationEnded()
    expect(events).toEqual([])
    vi.advanceTimersByTime(1250)
    c.appReady()
    expect(events).toEqual(['fade:done@3000'])
    expect(c.state()).toBe('fading')
    vi.advanceTimersByTime(249)
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['fade:done@3000', 'remove@3250'])
    expect(c.state()).toBe('removed')
  })

  it('アプリが先に知らせてきたら、アニメーションの終わりを待つ', () => {
    const { c, events } = setup()
    c.start()
    vi.advanceTimersByTime(400)
    c.appReady()
    expect(events).toEqual([])
    vi.advanceTimersByTime(1350)
    c.animationEnded()
    expect(events).toEqual(['fade:done@1750'])
  })

  it('アプリが知らせてこなくても、5秒で消える', () => {
    const { c, events } = setup()
    c.start()
    c.animationEnded()
    vi.advanceTimersByTime(4999)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['fade:cap@5000'])
    vi.advanceTimersByTime(250)
    expect(events).toEqual(['fade:cap@5000', 'remove@5250'])
  })

  it('押した・キーを押した時はすぐ消える（あとの知らせ・5秒の期限は何もしない）', () => {
    const { c, events } = setup()
    c.start()
    vi.advanceTimersByTime(300)
    c.skip()
    expect(events).toEqual(['fade:skip@300'])
    c.skip()
    c.animationEnded()
    c.appReady()
    vi.advanceTimersByTime(10_000)
    expect(events).toEqual(['fade:skip@300', 'remove@550'])
  })

  it('動かさない時は、最後の絵を描いてから0.5秒出して（アプリの知らせも待って）消す', () => {
    const { c, events } = setup(true)
    c.start()
    c.appReady()
    // 描く準備・Worker の立ち上がりの間は数えない
    vi.advanceTimersByTime(200)
    expect(events).toEqual([])
    c.stillShown()
    vi.advanceTimersByTime(499)
    expect(events).toEqual([])
    // 2度目の知らせ（Worker で描けずにページの中で描き直した時など）は数え直さない
    c.stillShown()
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['fade:done@700'])
  })

  it('動かさない時、最後の絵を描けないままなら5秒で消える。動かす時の stillShown は何もしない', () => {
    const still = setup(true)
    still.c.start()
    still.c.appReady()
    vi.advanceTimersByTime(5000)
    expect(still.events).toEqual(['fade:cap@5000'])

    const moving = setup()
    moving.c.start()
    moving.c.appReady()
    moving.c.stillShown()
    vi.advanceTimersByTime(4999)
    expect(moving.events).toEqual([])
    moving.c.animationEnded()
    expect(moving.events).toEqual(['fade:done@4999'])
  })

  it('消し始めた後の stillShown は何もしない', () => {
    const { c, events } = setup(true)
    c.start()
    c.skip()
    c.stillShown()
    c.appReady()
    vi.advanceTimersByTime(10_000)
    expect(events).toEqual(['fade:skip@0', 'remove@250'])
  })
})

describe('起動アニメーション（boot）', () => {
  it('Web 版の最初の読み込み: <html> の直下に画面いっぱいの重なりを出す（読み上げない・押せるものを置かない）', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'dark' }))
    const api = load()
    api.boot()
    const el = overlay()!
    expect(el.parentElement).toBe(document.documentElement)
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.getAttribute('data-testid')).toBe('launch-overlay')
    expect(el.getAttribute('data-launch-theme')).toBe('dark')
    expect(el.getAttribute('data-launch-mode')).toBe('play')
    expect(el.style.position).toBe('fixed')
    // 地の色（アニメーションの最初の絵とほぼ同じ）はその場で出る
    expect(el.style.background).toMatch(/#050607|rgb\(5, 6, 7\)/)
    expect(sessionStorage.getItem('novel-studio:launched')).toBe('1')
    expect(api.active()).toBe(true)
    // 描く準備は HTML を読み終えた後。Worker を使えない所（ここ）ではページの中で描き、下ごしらえは最初の描画の時
    expect(el.getAttribute('data-launch-renderer')).toBeNull()
    t(0)
    expect(el.getAttribute('data-launch-renderer')).toBe('page')
    expect(draws).toBe(0)
    t(16)
    expect(el.querySelectorAll('canvas')).toHaveLength(1)
    expect(draws).toBeGreaterThan(0)
    expect(el.querySelector('a, button, input, [tabindex]')).toBeNull()
  })

  it('アニメーションが終わっても、アプリの知らせまでは消えない。知らせが来たら0.25秒で消えて取り除く', () => {
    const api = load()
    api.boot()
    const el = overlay()!
    t(16)
    const canvas = el.querySelector('canvas')!
    t(3000)
    expect(el.style.opacity).toBe('1')
    expect(el.getAttribute('data-launch-end')).toBeNull()
    api.appReady()
    expect(el.style.opacity).toBe('0')
    expect(el.style.pointerEvents).toBe('none')
    expect(el.getAttribute('data-launch-end')).toBe('done')
    t(250)
    expect(overlay()).toBeNull()
    expect(api.active()).toBe(false)
    // canvas の中身を手放す
    expect(canvas.width).toBe(0)
  })

  it('アプリが先に知らせてきた時は、アニメーションが終わった所で消える', () => {
    const api = load()
    api.boot()
    api.appReady()
    t(1000)
    expect(overlay()!.style.opacity).toBe('1')
    t(1000)
    expect(overlay()!.getAttribute('data-launch-end')).toBe('done')
    t(250)
    expect(overlay()).toBeNull()
  })

  it('押すとすぐ消え、アニメーションも止まる', () => {
    const api = load()
    api.boot()
    t(300)
    window.dispatchEvent(new Event('pointerdown'))
    const el = overlay()!
    expect(el.style.opacity).toBe('0')
    expect(el.getAttribute('data-launch-end')).toBe('skip')
    const before = draws
    t(200)
    expect(draws).toBe(before)
    t(50)
    expect(overlay()).toBeNull()
  })

  it('キーを押してもすぐ消える（下のアプリはすぐ押せる）', () => {
    load().boot()
    t(100)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(overlay()!.getAttribute('data-launch-end')).toBe('skip')
    expect(overlay()!.style.pointerEvents).toBe('none')
  })

  describe('重なりを押した時（指のタップ・長押し）', () => {
    const press = (target: EventTarget, type: string) => {
      const e =
        type === 'click'
          ? new MouseEvent(type, { bubbles: true, cancelable: true })
          : new Event(type, { bubbles: true, cancelable: true })
      target.dispatchEvent(e)
      return e
    }
    let appGot: string[]
    const app = (e: Event) => appGot.push(e.type)
    const PRESS = ['pointerup', 'pointercancel', 'touchend', 'mousedown', 'mouseup', 'click', 'contextmenu']
    beforeEach(() => {
      appGot = []
      for (const type of PRESS) document.addEventListener(type, app)
    })
    afterEach(() => {
      for (const type of PRESS) document.removeEventListener(type, app)
    })

    it('離すまでは押せるまま残し、押す操作の続き（離す・クリック）を止める。離して0.1秒で取り除く', () => {
      load().boot()
      t(300)
      const el = overlay()!
      press(el, 'pointerdown')
      expect(el.getAttribute('data-launch-end')).toBe('skip')
      expect(el.style.opacity).toBe('0')
      // 指を離した後のクリックは、その時に指の下にある所へ送られる。重なりが押せないと、下のアプリが押されてしまう
      expect(el.style.pointerEvents).not.toBe('none')
      t(400)
      expect(overlay()).toBe(el)
      expect(press(el, 'pointerup').defaultPrevented).toBe(true)
      // 指を離したのを止めると、そのタップのクリックは作られない
      expect(press(el, 'touchend').defaultPrevented).toBe(true)
      expect(press(el, 'mouseup').defaultPrevented).toBe(true)
      expect(press(el.querySelector('canvas') ?? el, 'click').defaultPrevented).toBe(true)
      expect(appGot).toEqual([])
      t(99)
      expect(overlay()).toBe(el)
      t(1)
      expect(overlay()).toBeNull()
      // 取り除いた後は、アプリへの操作を止めない
      const click = press(document.body, 'click')
      expect(click.defaultPrevented).toBe(false)
      expect(appGot).toEqual(['click'])
    })

    it('すぐ離した時は、離して0.1秒で押せなくなり、消え始めて0.25秒で取り除く', () => {
      load().boot()
      t(300)
      const el = overlay()!
      press(el, 'pointerdown')
      press(el, 'pointerup')
      press(el, 'click')
      t(99)
      expect(el.style.pointerEvents).not.toBe('none')
      t(1)
      expect(el.style.pointerEvents).toBe('none')
      expect(overlay()).toBe(el)
      t(150)
      expect(overlay()).toBeNull()
      expect(appGot).toEqual([])
    })

    it('押したまま（長押し）でも、消え始めて3秒で取り除く。長押しのメニューも止める', () => {
      load().boot()
      t(300)
      const el = overlay()!
      press(el, 'pointerdown')
      t(1000)
      expect(press(el, 'contextmenu').defaultPrevented).toBe(true)
      t(1999)
      expect(overlay()).toBe(el)
      expect(el.style.pointerEvents).not.toBe('none')
      t(1)
      expect(overlay()).toBeNull()
      expect(appGot).toEqual([])
    })

    it('重なりの外（消え始めた後の下のアプリ）への操作は止めない', () => {
      load().boot()
      t(300)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      expect(press(document.body, 'click').defaultPrevented).toBe(false)
      expect(press(document.body, 'pointerup').defaultPrevented).toBe(false)
      expect(appGot).toEqual(['click', 'pointerup'])
      t(250)
      expect(overlay()).toBeNull()
    })
  })

  it('アプリが知らせてこなくても、5秒で消える', () => {
    load().boot()
    t(4999)
    expect(overlay()!.style.opacity).toBe('1')
    t(1)
    expect(overlay()!.getAttribute('data-launch-end')).toBe('cap')
    t(250)
    expect(overlay()).toBeNull()
  })

  it('同じウインドウで読み込み直すと出さない。新しいウインドウ・タブ（sessionStorage が空）では出す', () => {
    load().boot()
    expect(overlay()).not.toBeNull()
    overlay()!.remove()
    load().boot()
    expect(overlay()).toBeNull()
    sessionStorage.clear()
    load().boot()
    expect(overlay()).not.toBeNull()
  })

  describe('見えていないタブ（裏で開いたタブ・ブラウザの先読み）で開いた時', () => {
    const hide = () => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const show = () => delete (document as { visibilityState?: string }).visibilityState
    const flag = () => sessionStorage.getItem('novel-studio:launched')
    afterEach(show)

    it('出さず、そのタブが見えた時に出したことにする（後の再読み込み・「新しい版にする」でも出さない）', () => {
      hide()
      load().boot()
      expect(overlay()).toBeNull()
      expect(flag()).toBeNull()
      // まだ見えていない間は印を付けない
      document.dispatchEvent(new Event('visibilitychange'))
      expect(flag()).toBeNull()
      show()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(flag()).toBe('1')
      load().boot()
      expect(overlay()).toBeNull()
    })

    it('先読みしたページを開いた時（prerenderingchange）も、出したことにする', () => {
      hide()
      load().boot()
      show()
      document.dispatchEvent(new Event('prerenderingchange'))
      expect(flag()).toBe('1')
    })

    it('見えないうちに読み込み直したら、新しいページが見えた時に印を付ける（前のページを開いた時の分は残らない）', () => {
      hide()
      load().boot()
      load().boot()
      show()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(flag()).toBe('1')
      load().boot()
      expect(overlay()).toBeNull()
    })

    it('設定でオフ・テスト（強制していない）で出さない時は、見えても印を付けない（オンに戻した後・強制した時に出る）', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ launchAnimation: false }))
      hide()
      load().boot()
      show()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(flag()).toBeNull()

      localStorage.clear()
      setWebdriver(true)
      hide()
      load().boot()
      show()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(flag()).toBeNull()
      localStorage.setItem('novel-studio:launch', 'force')
      load().boot()
      expect(overlay()).not.toBeNull()
    })

    it('アプリ（iPhone / Android）は見えていなくても出す', () => {
      w.Capacitor = { isNativePlatform: () => true }
      hide()
      load().boot()
      expect(overlay()).not.toBeNull()
    })
  })

  it('設定でオフにすると出さない', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'white', launchAnimation: false }))
    load().boot()
    expect(overlay()).toBeNull()
    expect(sessionStorage.getItem('novel-studio:launched')).toBeNull()
  })

  it('テスト（navigator.webdriver）では出さない。localStorage の novel-studio:launch = force か URL の launch=1 で出す', () => {
    setWebdriver(true)
    load().boot()
    expect(overlay()).toBeNull()

    localStorage.setItem('novel-studio:launch', 'force')
    load().boot()
    expect(overlay()).not.toBeNull()
    overlay()!.remove()

    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/?launch=1#/settings')
    load().boot()
    expect(overlay()).not.toBeNull()
  })

  it('視差効果を減らす設定: 動かさずに最後の絵（ロゴ）を出し、描いてから0.5秒たってアプリの知らせもあれば消える', () => {
    media({ reduced: true })
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'white' }))
    const api = load()
    api.boot()
    const el = overlay()!
    expect(el.getAttribute('data-launch-mode')).toBe('still')
    expect(el.getAttribute('data-launch-theme')).toBe('light')
    t(16)
    const before = draws
    expect(before).toBeGreaterThan(0)
    api.appReady()
    // ロゴを描いた（16）時から0.5秒（開いてから 516）
    t(499)
    expect(el.style.opacity).toBe('1')
    expect(el.getAttribute('data-launch-end')).toBeNull()
    // 動かさない（描き直さない）
    expect(draws).toBe(before)
    t(1)
    expect(el.getAttribute('data-launch-end')).toBe('done')
  })

  it('アプリ（iPhone / Android）: 起動のたびに出し、最初の絵を描いたら起動の画面（スプラッシュ）を消す', async () => {
    const nativePromise = vi.fn(() => Promise.resolve())
    w.Capacitor = { isNativePlatform: () => true, nativePromise }
    sessionStorage.setItem('novel-studio:launched', '1')
    load().boot()
    expect(overlay()).not.toBeNull()
    expect(nativePromise).not.toHaveBeenCalled()
    t(32)
    expect(nativePromise).toHaveBeenCalledTimes(1)
    expect(nativePromise).toHaveBeenCalledWith('SplashScreen', 'hide', { fadeOutDuration: 150 })
    t(1000)
    expect(nativePromise).toHaveBeenCalledTimes(1)
  })

  it('canvas を使えない時は何も出さずに続ける（外観は決める）', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'dark' }))
    const api = load()
    expect(api.boot()).toBe('dark')
    expect(overlay()).toBeNull()
    expect(api.active()).toBe(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(sessionStorage.getItem('novel-studio:launched')).toBeNull()
    // アプリの知らせは何もしない
    api.appReady()
  })

  it('描く途中で失敗したら、その場で消える（アプリの起動の邪魔をしない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = load()
    api.boot()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    t(16)
    expect(warn).toHaveBeenCalled()
    expect(overlay()!.getAttribute('data-launch-end')).toBe('skip')
    t(250)
    expect(overlay()).toBeNull()
  })

  it('出していない時のアプリの知らせは何もしない', () => {
    setWebdriver(true)
    const api = load()
    api.boot()
    expect(() => api.appReady()).not.toThrow()
    expect(api.active()).toBe(false)
  })
})

describe('Worker（別のスレッド）で描く', () => {
  interface Posted {
    type: string
    canvas?: unknown
    size?: { width: number; height: number; dpr: number; safe: Record<string, number> }
    theme?: string
    still?: boolean
  }
  class FakeWorker {
    static last: FakeWorker | null = null
    posted: Posted[] = []
    transfers: unknown[][] = []
    terminated = false
    onmessage: ((e: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) {
      FakeWorker.last = this
    }
    postMessage(data: Posted, transfer?: unknown[]) {
      this.posted.push(data)
      this.transfers.push(transfer ?? [])
    }
    terminate() {
      this.terminated = true
    }
  }
  const offscreen = { offscreen: true }

  beforeEach(() => {
    FakeWorker.last = null
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {})
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      value: () => offscreen,
      configurable: true,
    })
    URL.createObjectURL = vi.fn(() => 'blob:launch')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }).transferControlToOffscreen
  })

  it('canvas を Worker に渡して描かせ、ページの中では描かない', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'deep-dark' }))
    load().boot()
    t(0)
    const el = overlay()!
    expect(el.getAttribute('data-launch-renderer')).toBe('worker')
    const worker = FakeWorker.last!
    expect(worker.url).toBe('blob:launch')
    expect(worker.posted[0]).toMatchObject({ type: 'start', canvas: offscreen, theme: 'deep', still: false })
    expect(worker.posted[0].size).toMatchObject({ dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } })
    expect(worker.transfers[0]).toEqual([offscreen])
    t(100)
    expect(draws).toBe(0)
  })

  it('Worker が描き終わり、アプリが知らせたら消える。取り除く時に Worker を止める', () => {
    const api = load()
    api.boot()
    t(0)
    const worker = FakeWorker.last!
    api.appReady()
    t(1000)
    expect(overlay()!.style.opacity).toBe('1')
    worker.onmessage!({ data: { type: 'end' } })
    expect(overlay()!.getAttribute('data-launch-end')).toBe('done')
    t(250)
    expect(overlay()).toBeNull()
    expect(worker.terminated).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:launch')
  })

  it('視差効果を減らす設定: Worker がロゴを描いた（started）時から0.5秒出す（Worker の立ち上がりは数えない）', () => {
    media({ reduced: true })
    const api = load()
    api.boot()
    t(0)
    const worker = FakeWorker.last!
    expect(worker.posted[0]).toMatchObject({ type: 'start', still: true })
    api.appReady()
    // Worker の立ち上がりが遅い（遅い端末）
    t(700)
    expect(overlay()!.style.opacity).toBe('1')
    worker.onmessage!({ data: { type: 'started' } })
    t(499)
    expect(overlay()!.style.opacity).toBe('1')
    expect(overlay()!.getAttribute('data-launch-end')).toBeNull()
    t(1)
    expect(overlay()!.getAttribute('data-launch-end')).toBe('done')
  })

  it('押すと Worker の絵を止めて消える', () => {
    load().boot()
    t(0)
    const worker = FakeWorker.last!
    window.dispatchEvent(new Event('pointerdown'))
    expect(worker.posted.map((m) => m.type)).toEqual(['start', 'stop'])
    t(250)
    expect(worker.terminated).toBe(true)
  })

  it('描く準備の前に押されたら、Worker を作らずに消える', () => {
    load().boot()
    window.dispatchEvent(new Event('pointerdown'))
    t(0)
    expect(FakeWorker.last).toBeNull()
    t(250)
    expect(overlay()).toBeNull()
  })

  it('Worker で描けなかったら、ページの中で描き直す', () => {
    load().boot()
    t(0)
    const worker = FakeWorker.last!
    worker.onerror!()
    expect(worker.terminated).toBe(true)
    const el = overlay()!
    expect(el.getAttribute('data-launch-renderer')).toBe('page')
    t(16)
    expect(el.querySelectorAll('canvas')).toHaveLength(1)
    expect(draws).toBeGreaterThan(0)
  })

  it('Worker のスクリプトはそれだけで動き、最後まで描いたら知らせる', () => {
    const api = load()
    let queue: ((ts: number) => void)[] = []
    const posted: string[] = []
    const scope = {
      OffscreenCanvas: function (this: { width: number; height: number }, w: number, h: number) {
        this.width = w
        this.height = h
        Object.assign(this, { getContext: fakeContext })
      },
      requestAnimationFrame: (cb: (ts: number) => void) => queue.push(cb),
      cancelAnimationFrame: () => {},
      postMessage: (m: { type: string }) => posted.push(m.type),
      onmessage: null as null | ((e: { data: unknown }) => void),
    }
    // ページの window・document を使わない
    new Function('self', 'window', 'document', api.workerSource())(scope, undefined, undefined)
    const target = { width: 0, height: 0, getContext: fakeContext }
    scope.onmessage!({
      data: { type: 'start', canvas: target, size: { width: 360, height: 760, dpr: 2, safe: {} }, theme: 'dark' },
    })
    expect(posted).toEqual(['started'])
    expect(target.width).toBe(720)
    expect(draws).toBeGreaterThan(0)
    for (let now = 16; now <= 2000; now += 16) {
      const q = queue
      queue = []
      q.forEach((cb) => cb(now))
    }
    expect(posted).toEqual(['started', 'end'])
  })
})
