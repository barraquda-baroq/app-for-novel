// 起動アニメーション（src/launch/launch.js）とアプリのつなぎ
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterNextPaint, launchActive, notifyAppReady } from './launchHook'

const w = window as unknown as { NovelStudioLaunch?: unknown }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] })
})
afterEach(() => {
  vi.useRealTimers()
  delete w.NovelStudioLaunch
})

describe('launchHook', () => {
  it('起動アニメーションにアプリの知らせを渡す', () => {
    const appReady = vi.fn()
    w.NovelStudioLaunch = { appReady, active: () => true }
    notifyAppReady()
    expect(appReady).toHaveBeenCalledTimes(1)
    expect(launchActive()).toBe(true)
  })

  it('起動アニメーションが無い（埋め込まれていない・壊れている）時も何もしない', () => {
    expect(() => notifyAppReady()).not.toThrow()
    expect(launchActive()).toBe(false)
    w.NovelStudioLaunch = {
      appReady: () => {
        throw new Error('x')
      },
      active: () => {
        throw new Error('x')
      },
    }
    expect(() => notifyAppReady()).not.toThrow()
    expect(launchActive()).toBe(false)
  })

  it('afterNextPaint: 2回目の描画の時に1回だけ呼ぶ。描画が来なくても時間で呼ぶ', () => {
    const fn = vi.fn()
    afterNextPaint(fn, 500)
    vi.advanceTimersByTime(16)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)

    // requestAnimationFrame が来ない（Android の起動の画面の間・裏のタブ）
    const late = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    afterNextPaint(late, 500)
    vi.advanceTimersByTime(499)
    expect(late).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(late).toHaveBeenCalledTimes(1)
  })
})
