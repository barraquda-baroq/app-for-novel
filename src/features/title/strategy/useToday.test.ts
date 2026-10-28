import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToday } from './useToday'

afterEach(() => {
  vi.useRealTimers()
})

describe('useToday', () => {
  it('開いたままでも、次の午前0時に「今日」を更新する', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 27, 23, 59, 0))
    const { result, unmount } = renderHook(() => useToday())
    expect(result.current.getDate()).toBe(27)
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(result.current.getDate()).toBe(27)
    act(() => {
      vi.advanceTimersByTime(32_000)
    })
    expect(result.current.getDate()).toBe(28)
    // その次の日付の変わり目にも更新する
    act(() => {
      vi.advanceTimersByTime(24 * 3_600_000)
    })
    expect(result.current.getDate()).toBe(29)
    unmount()
  })

  it('同じ日のうちは同じ値を返し、画面に戻った時（focus）に日付が変わっていれば更新する', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 9, 0))
    const { result } = renderHook(() => useToday())
    const first = result.current
    vi.setSystemTime(new Date(2026, 9, 27, 18, 0))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current).toBe(first)
    vi.setSystemTime(new Date(2026, 9, 29, 8, 0))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current.getDate()).toBe(29)
  })
})
