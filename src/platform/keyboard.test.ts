// iPhone アプリのキーボード（Capacitor の Keyboard は偽物）
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (info?: { keyboardHeight: number }) => void

const h = vi.hoisted(() => ({
  ios: true,
  listeners: new Map<string, (info?: { keyboardHeight: number }) => void>(),
  accessory: [] as boolean[],
}))
vi.mock('./platform', () => ({ isNativeIos: () => h.ios }))
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async (name: string, fn: Listener) => {
      h.listeners.set(name, fn)
      return { remove: async () => {} }
    }),
    setAccessoryBarVisible: vi.fn(async ({ isVisible }: { isVisible: boolean }) => {
      h.accessory.push(isVisible)
    }),
  },
}))

import { useKeyboardInset } from '../features/piece/keyboardInset'
import {
  nativeKeyboardHeight,
  onNativeKeyboard,
  resetNativeKeyboardForTests,
  setNativeKeyboardHeight,
  startIosKeyboard,
  useIosEditorKeyboard,
} from './keyboard'

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name)

beforeEach(() => {
  h.ios = true
  h.listeners.clear()
  h.accessory.length = 0
  resetNativeKeyboardForTests()
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('キーボードの高さ', () => {
  it('--kb-native に入れて知らせる。同じ値では知らせない。0 で消す', () => {
    const fn = vi.fn()
    const off = onNativeKeyboard(fn)
    setNativeKeyboardHeight(336.4)
    expect(nativeKeyboardHeight()).toBe(336)
    expect(cssVar('--kb-native')).toBe('336px')
    setNativeKeyboardHeight(336)
    expect(fn).toHaveBeenCalledTimes(1)
    setNativeKeyboardHeight(0)
    expect(cssVar('--kb-native')).toBe('')
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    setNativeKeyboardHeight(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('おかしな値は 0', () => {
    setNativeKeyboardHeight(200)
    setNativeKeyboardHeight(Number.NaN)
    expect(nativeKeyboardHeight()).toBe(0)
    setNativeKeyboardHeight(-5)
    expect(nativeKeyboardHeight()).toBe(0)
  })
})

describe('startIosKeyboard', () => {
  it('出始めた時に高さを入れ、閉じ始めた・閉じた時に 0 にする。アクセサリーバーは出しておく', async () => {
    await startIosKeyboard()
    expect(h.accessory).toEqual([true])
    h.listeners.get('keyboardWillShow')!({ keyboardHeight: 291 })
    expect(cssVar('--kb-native')).toBe('291px')
    h.listeners.get('keyboardWillHide')!()
    expect(nativeKeyboardHeight()).toBe(0)
    h.listeners.get('keyboardWillShow')!({ keyboardHeight: 291 })
    h.listeners.get('keyboardDidHide')!()
    expect(nativeKeyboardHeight()).toBe(0)
  })

  it('出し終えたら、原稿画面の外の入力欄をキーボードの上まで出す', async () => {
    await startIosKeyboard()
    document.body.innerHTML = '<input id="a"><div class="pw-root"><textarea id="b"></textarea></div>'
    const a = document.getElementById('a') as HTMLInputElement
    const b = document.getElementById('b') as HTMLTextAreaElement
    const scroll = vi.fn()
    a.scrollIntoView = scroll
    b.scrollIntoView = scroll
    a.focus()
    h.listeners.get('keyboardDidShow')!({ keyboardHeight: 300 })
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(nativeKeyboardHeight()).toBe(300)
    scroll.mockClear()
    // 原稿画面は自分でカーソルの行まで動かす
    b.focus()
    h.listeners.get('keyboardDidShow')!({ keyboardHeight: 300 })
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('useIosEditorKeyboard', () => {
  it('原稿画面・セパレート画面の間だけアクセサリーバーを消す（重なっても最後に閉じた時に出す）', () => {
    const one = renderHook(() => useIosEditorKeyboard())
    const two = renderHook(() => useIosEditorKeyboard())
    one.unmount()
    two.unmount()
    expect(h.accessory).toEqual([false, false, false, true])
  })

  it('iPhone のアプリでなければ何もしない', () => {
    h.ios = false
    renderHook(() => useIosEditorKeyboard()).unmount()
    expect(h.accessory).toEqual([])
  })
})

describe('useKeyboardInset（アプリのキーボード）', () => {
  it('visualViewport の値とアプリの高さの大きい方を --kb-inset に入れる（二重に詰めない）', () => {
    const vv = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
    const { unmount } = renderHook(() => useKeyboardInset())
    expect(cssVar('--kb-inset')).toBe('0px')
    act(() => setNativeKeyboardHeight(320))
    expect(cssVar('--kb-inset')).toBe('320px')
    // WebKit もキーボードを扱って見えている範囲が縮んだ: 足さずに大きい方
    vv.height = window.innerHeight - 300
    act(() => setNativeKeyboardHeight(310))
    expect(cssVar('--kb-inset')).toBe('310px')
    vv.height = window.innerHeight - 350
    act(() => setNativeKeyboardHeight(300))
    expect(cssVar('--kb-inset')).toBe('350px')
    vv.height = window.innerHeight
    act(() => setNativeKeyboardHeight(0))
    expect(cssVar('--kb-inset')).toBe('0px')
    unmount()
    expect(cssVar('--kb-inset')).toBe('')
  })

  it('visualViewport が無くても、アプリの高さで詰める', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    const { unmount } = renderHook(() => useKeyboardInset())
    act(() => setNativeKeyboardHeight(280))
    expect(cssVar('--kb-inset')).toBe('280px')
    unmount()
  })
})
