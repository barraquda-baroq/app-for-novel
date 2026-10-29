// アプリの起動時の準備: Android の「戻る」・裏に回る／戻る（Capacitor は偽物）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'android' as 'ios' | 'android' | null,
  listeners: new Map<string, (e?: { canGoBack: boolean }) => void>(),
  minimizeApp: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  saveBeforeLeave: vi.fn(async () => true),
  noteAppHidden: vi.fn(),
  noteAppVisible: vi.fn(),
  startIosKeyboard: vi.fn(async () => {}),
}))
vi.mock('./platform', () => ({ nativePlatform: () => h.platform }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (name: string, fn: (e?: { canGoBack: boolean }) => void) => {
      h.listeners.set(name, fn)
      return { remove: async () => {} }
    }),
    minimizeApp: h.minimizeApp,
  },
}))
vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: { hide: h.hide } }))
vi.mock('../store/lifecycle', () => ({ saveBeforeLeave: h.saveBeforeLeave }))
vi.mock('../sync/controller', () => ({ noteAppHidden: h.noteAppHidden, noteAppVisible: h.noteAppVisible }))
vi.mock('./keyboard', () => ({ startIosKeyboard: h.startIosKeyboard }))

import { closeTopLayer, handleBackButton, hideSplash, initNative } from './nativeInit'

const deps = () => ({ back: vi.fn(), minimize: vi.fn(async () => {}), save: vi.fn(async () => true) })

beforeEach(() => {
  h.platform = 'android'
  vi.clearAllMocks()
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('closeTopLayer', () => {
  it('開いているメニュー（無ければいちばん上のダイアログ）に Esc を送る', () => {
    document.body.innerHTML =
      '<div class="modal-backdrop"><div class="modal" id="m1"></div></div><div class="modal-backdrop"><div class="modal" id="m2"></div></div>'
    const keys: string[] = []
    document.addEventListener('keydown', (e) => keys.push(`${(e.target as HTMLElement).id}:${e.key}`))
    expect(closeTopLayer()).toBe(true)
    expect(keys).toEqual(['m2:Escape'])
    document.body.insertAdjacentHTML('beforeend', '<div role="menu" id="menu"></div>')
    expect(closeTopLayer()).toBe(true)
    expect(keys).toEqual(['m2:Escape', 'menu:Escape'])
  })

  it('何も開いていなければ false', () => {
    expect(closeTopLayer()).toBe(false)
  })
})

describe('handleBackButton', () => {
  it('ダイアログが開いていれば閉じるだけ', async () => {
    document.body.innerHTML = '<div class="modal-backdrop"><div class="modal"></div></div>'
    const d = deps()
    await handleBackButton(true, d)
    expect(d.back).not.toHaveBeenCalled()
    expect(d.minimize).not.toHaveBeenCalled()
  })

  it('戻れる画面があれば戻る', async () => {
    const d = deps()
    await handleBackButton(true, d)
    expect(d.back).toHaveBeenCalledTimes(1)
    expect(d.minimize).not.toHaveBeenCalled()
  })

  it('最初の画面では保存してから裏に回す（閉じない）', async () => {
    const order: string[] = []
    const d = {
      back: vi.fn(),
      save: vi.fn(async () => {
        order.push('save')
        return true
      }),
      minimize: vi.fn(async () => {
        order.push('minimize')
      }),
    }
    await handleBackButton(false, d)
    expect(order).toEqual(['save', 'minimize'])
    // 保存に失敗しても裏に回す
    d.save.mockRejectedValueOnce(new Error('x'))
    await handleBackButton(false, d)
    expect(d.minimize).toHaveBeenCalledTimes(2)
  })
})

describe('initNative', () => {
  it('裏に回る時は保存して送り、戻ったら知らせる。戻るボタンも受け取る。iPhone だけキーボードを受け取る', () => {
    initNative()
    h.listeners.get('pause')!()
    expect(h.saveBeforeLeave).toHaveBeenCalledTimes(1)
    expect(h.noteAppHidden).toHaveBeenCalledTimes(1)
    h.listeners.get('resume')!()
    expect(h.noteAppVisible).toHaveBeenCalledTimes(1)
    expect(h.listeners.has('backButton')).toBe(true)
    expect(h.startIosKeyboard).not.toHaveBeenCalled()
    // 二度目は何もしない
    initNative()
    expect(h.listeners.size).toBe(3)
  })

  it('起動の画面は一度だけ消す', () => {
    hideSplash()
    hideSplash()
    expect(h.hide).toHaveBeenCalledTimes(1)
  })
})
