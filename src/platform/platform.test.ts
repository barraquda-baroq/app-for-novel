// どこで動いているかの見分け（Capacitor は偽物）
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ platform: 'web' }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => h.platform } }))

import { isNative, isNativeIos, nativePlatform } from './platform'

beforeEach(() => {
  h.platform = 'web'
})

describe('nativePlatform', () => {
  it('ブラウザは null', () => {
    expect(nativePlatform()).toBeNull()
    expect(isNative()).toBe(false)
    expect(isNativeIos()).toBe(false)
  })

  it('iPhone のアプリ', () => {
    h.platform = 'ios'
    expect(nativePlatform()).toBe('ios')
    expect(isNative()).toBe(true)
    expect(isNativeIos()).toBe(true)
  })

  it('Android のアプリ', () => {
    h.platform = 'android'
    expect(nativePlatform()).toBe('android')
    expect(isNative()).toBe(true)
    expect(isNativeIos()).toBe(false)
  })

  it('知らない値はブラウザ扱い', () => {
    h.platform = 'electron'
    expect(nativePlatform()).toBeNull()
  })
})
