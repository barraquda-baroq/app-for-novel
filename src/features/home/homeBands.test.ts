// ホームの帯の開け閉め（2.9）: 起動した時は4つとも閉じている。開けた帯はモジュールの中で覚えていて、保存はしない
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isBandOpen, openBand, resetHomeBandsForTests, toggleBand, useHomeBand, useOpenBands } from './homeBands'

afterEach(() => {
  cleanup()
  resetHomeBandsForTests()
})

describe('ホームの帯', () => {
  it('起動した時は4つとも閉じている', () => {
    for (const area of ['titles', 'ideas', 'bench', 'materials'] as const) expect(isBandOpen(area)).toBe(false)
    const { result } = renderHook(() => useOpenBands())
    expect([...result.current]).toEqual([])
  })

  it('開く・切り替える（開いている帯を開いても閉じない）', () => {
    openBand('bench')
    expect(isBandOpen('bench')).toBe(true)
    openBand('bench')
    expect(isBandOpen('bench')).toBe(true)
    toggleBand('bench')
    expect(isBandOpen('bench')).toBe(false)
    toggleBand('ideas')
    expect(isBandOpen('ideas')).toBe(true)
    expect(isBandOpen('titles')).toBe(false)
  })

  it('帯ごとに自分の状態だけを読む（ほかの帯を開け閉めしても値は変わらない）。全体は開け閉めのたびに新しい Set', () => {
    const titles = renderHook(() => useHomeBand('titles'))
    const all = renderHook(() => useOpenBands())
    const first = all.result.current
    expect(titles.result.current).toBe(false)
    act(() => openBand('titles'))
    expect(titles.result.current).toBe(true)
    expect(all.result.current).not.toBe(first)
    expect([...all.result.current]).toEqual(['titles'])
    act(() => toggleBand('materials'))
    expect(titles.result.current).toBe(true)
    expect([...all.result.current].sort()).toEqual(['materials', 'titles'])
  })

  it('開いていれば、開いても知らせない（描き直さない）', () => {
    openBand('ideas')
    const renders = vi.fn()
    renderHook(() => {
      renders()
      return useOpenBands()
    })
    renders.mockClear()
    act(() => openBand('ideas'))
    expect(renders).not.toHaveBeenCalled()
  })

  it('保存はしない（localStorage・sessionStorage に書かない）', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem')
    openBand('titles')
    toggleBand('ideas')
    expect(local).not.toHaveBeenCalled()
    local.mockRestore()
  })

  it('resetHomeBandsForTests で起動した時と同じ（4つとも閉じる）', () => {
    const { result } = renderHook(() => useHomeBand('bench'))
    act(() => openBand('bench'))
    expect(result.current).toBe(true)
    act(() => resetHomeBandsForTests())
    expect(result.current).toBe(false)
  })
})
