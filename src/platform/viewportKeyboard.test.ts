// 画面キーボードに隠れる高さ（--kb・--kb-top）: visualViewport で測った高さとアプリから届いた高さをまとめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetNativeKeyboardForTests, setNativeKeyboardHeight } from './keyboard'
import {
  isKeyboardTarget,
  keyboardCover,
  KEYBOARD_MIN_COVER,
  measureCover,
  refreshKeyboard,
  resetViewportKeyboardForTests,
  startViewportKeyboard,
} from './viewportKeyboard'

const H = 844
const KB = 336

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name)

/** requestAnimationFrame を手で進める（フォーカスの移り変わりを1回にまとめることを確かめる） */
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
function flush(): void {
  for (let i = 0; i < 5 && frames.size > 0; i++) {
    const list = [...frames.values()]
    frames.clear()
    for (const cb of list) cb(0)
  }
}

/** iPhone の Safari と同じく、画面は縮まず見えている範囲だけが縮む visualViewport */
function fakeViewport() {
  const vv = Object.assign(new EventTarget(), { height: H, offsetTop: 0, scale: 1 })
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  const set = (kb: number, top = 0) => {
    vv.height = H - kb
    vv.offsetTop = top
    vv.dispatchEvent(new Event('resize'))
  }
  return { vv, set }
}

let stop: (() => void) | null = null

beforeEach(() => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  Object.defineProperty(window, 'innerHeight', { value: H, configurable: true })
  resetNativeKeyboardForTests()
  resetViewportKeyboardForTests()
})

afterEach(() => {
  stop?.()
  stop = null
  document.body.innerHTML = ''
  resetNativeKeyboardForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('measureCover', () => {
  const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale })

  it('キーボードが無ければ 0', () => {
    expect(measureCover(H, vv(H), true)).toEqual({ bottom: 0, top: 0 })
    expect(measureCover(H, null, true)).toEqual({ bottom: 0, top: 0 })
  })

  it('見えている範囲の下に隠れた高さを bottom に入れる', () => {
    expect(measureCover(H, vv(H - KB), true)).toEqual({ bottom: KB, top: 0 })
  })

  it('Safari が見えている範囲を下げた分（offsetTop）は top に入れ、下からは除く', () => {
    expect(measureCover(H, vv(H - KB, 120), true)).toEqual({ bottom: KB - 120, top: 120 })
  })

  it('ツールバーほどの差（KEYBOARD_MIN_COVER 未満）は数えない。差は上と下の合計で見る', () => {
    expect(measureCover(H, vv(H - 60), true)).toEqual({ bottom: 0, top: 0 })
    expect(measureCover(H, vv(H - KEYBOARD_MIN_COVER + 1), true)).toEqual({ bottom: 0, top: 0 })
    // 大きく下げて下に残るのが少しでも、合計がキーボードの高さなら数える
    expect(measureCover(H, vv(H - KB, KB - 40), true)).toEqual({ bottom: 40, top: KB - 40 })
  })

  it('拡大している時（ピンチ）と、入力欄もダイアログも無い時は測らない', () => {
    expect(measureCover(H, vv(H / 2, 0, 2), true)).toEqual({ bottom: 0, top: 0 })
    expect(measureCover(H, vv(H - KB), false)).toEqual({ bottom: 0, top: 0 })
  })
})

describe('isKeyboardTarget', () => {
  it('文字を打つ欄と選ぶ欄だけ', () => {
    document.body.innerHTML =
      '<input id="t"><input id="s" type="search"><input id="c" type="checkbox"><input id="r" type="range">' +
      '<textarea id="a"></textarea><select id="sel"></select><button id="b">押す</button>'
    const el = (id: string) => document.getElementById(id)
    expect(isKeyboardTarget(el('t'))).toBe(true)
    expect(isKeyboardTarget(el('s'))).toBe(true)
    expect(isKeyboardTarget(el('a'))).toBe(true)
    expect(isKeyboardTarget(el('sel'))).toBe(true)
    expect(isKeyboardTarget(el('c'))).toBe(false)
    expect(isKeyboardTarget(el('r'))).toBe(false)
    expect(isKeyboardTarget(el('b'))).toBe(false)
    expect(isKeyboardTarget(document.body)).toBe(false)
    expect(isKeyboardTarget(null)).toBe(false)
  })
})

describe('startViewportKeyboard', () => {
  it('入力欄にフォーカスがある時に見えている範囲が縮んだら --kb に入れ、外れたら消す', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    document.body.innerHTML = '<input id="a">'
    const input = document.getElementById('a') as HTMLInputElement
    input.focus()
    set(KB)
    flush()
    expect(cssVar('--kb')).toBe(`${KB}px`)
    expect(cssVar('--kb-top')).toBe('')
    expect(keyboardCover()).toEqual({ bottom: KB, top: 0 })
    // Safari が見えている範囲を下げた
    set(KB, 120)
    flush()
    expect(cssVar('--kb')).toBe(`${KB - 120}px`)
    expect(cssVar('--kb-top')).toBe('120px')
    input.blur()
    flush()
    expect(cssVar('--kb')).toBe('')
    expect(cssVar('--kb-top')).toBe('')
  })

  it('入力欄もダイアログも無い時は測らない', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    set(KB)
    flush()
    expect(cssVar('--kb')).toBe('')
  })

  it('ダイアログを開いている間は、入力欄から外れても測り続ける（［作る］を押してキーボードが閉じていく間もシートが追う）', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    document.body.innerHTML = '<div class="modal-backdrop"><div class="modal"><input id="a"></div></div>'
    const input = document.getElementById('a') as HTMLInputElement
    input.focus()
    set(KB)
    flush()
    expect(cssVar('--kb')).toBe(`${KB}px`)
    input.blur()
    flush()
    expect(cssVar('--kb')).toBe(`${KB}px`)
    set(150)
    flush()
    expect(cssVar('--kb')).toBe('150px')
    set(0)
    flush()
    expect(cssVar('--kb')).toBe('')
  })

  it('次の欄へ移る時（外れてから入る）は1回にまとめ、間で 0 にしない', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    document.body.innerHTML = '<input id="a"><input id="b">'
    ;(document.getElementById('a') as HTMLInputElement).focus()
    set(KB)
    flush()
    const remove = vi.spyOn(document.documentElement.style, 'removeProperty')
    ;(document.getElementById('b') as HTMLInputElement).focus()
    flush()
    expect(remove).not.toHaveBeenCalledWith('--kb')
    expect(cssVar('--kb')).toBe(`${KB}px`)
  })

  it('アプリから届いた高さと測った高さの大きい方（二重に上げない）。アプリの高さはすぐに入れる', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    document.body.innerHTML = '<input id="a">'
    ;(document.getElementById('a') as HTMLInputElement).focus()
    setNativeKeyboardHeight(KB)
    expect(cssVar('--kb')).toBe(`${KB}px`)
    // WebKit もキーボードを扱って見えている範囲が縮んだ: 足さずに大きい方
    setNativeKeyboardHeight(300)
    set(KB)
    flush()
    expect(cssVar('--kb')).toBe(`${KB}px`)
    set(0)
    flush()
    expect(cssVar('--kb')).toBe('300px')
    setNativeKeyboardHeight(0)
    expect(cssVar('--kb')).toBe('')
  })

  it('--kb が増えたら、ダイアログの中でフォーカスしている欄だけを見える所まで出す', () => {
    const { set } = fakeViewport()
    stop = startViewportKeyboard()
    document.body.innerHTML =
      '<input id="out"><div class="modal-backdrop"><div class="modal"><textarea id="in"></textarea></div></div>'
    const out = document.getElementById('out') as HTMLInputElement
    const inside = document.getElementById('in') as HTMLTextAreaElement
    const outScroll = vi.fn()
    const inScroll = vi.fn()
    out.scrollIntoView = outScroll
    inside.scrollIntoView = inScroll
    out.focus()
    set(KB)
    flush()
    expect(outScroll).not.toHaveBeenCalled()
    set(0)
    flush()
    inside.focus()
    set(KB)
    flush()
    expect(inScroll).toHaveBeenCalledWith({ block: 'nearest' })
    // 減った時（キーボードが閉じていく）は動かさない
    inScroll.mockClear()
    set(200)
    flush()
    expect(inScroll).not.toHaveBeenCalled()
  })

  it('始める前は refreshKeyboard は何もしない。止めたら聞くのをやめて変数を消す', () => {
    const { set } = fakeViewport()
    refreshKeyboard()
    expect(frames.size).toBe(0)
    const off = startViewportKeyboard()
    // 2回目は何もしない
    startViewportKeyboard()()
    document.body.innerHTML = '<input id="a">'
    ;(document.getElementById('a') as HTMLInputElement).focus()
    set(KB)
    flush()
    expect(cssVar('--kb')).toBe(`${KB}px`)
    off()
    expect(cssVar('--kb')).toBe('')
    set(200)
    setNativeKeyboardHeight(250)
    flush()
    expect(cssVar('--kb')).toBe('')
  })
})
