import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, useMenuTrigger } from './longPress'

function Row({ onOpen, onClick }: { onOpen: (p: { x: number; y: number }) => void; onClick: () => void }) {
  const handlers = useMenuTrigger((point) => onOpen(point))
  return (
    <div data-testid="row" {...handlers}>
      <a href="#/x" data-testid="link" onClick={(e) => (e.preventDefault(), onClick())}>
        行
      </a>
    </div>
  )
}

const touch = { pointerType: 'touch', isPrimary: true, button: 0 }

// jsdom には PointerEvent がないので、指・マウスの区別（pointerType）を持てるものを用意する
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    pointerType: string
    isPrimary: boolean
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  }
  ;(window as unknown as { PointerEvent: typeof TestPointerEvent }).PointerEvent = TestPointerEvent
}

describe('右クリック・長押しで開くメニュー', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  function setup() {
    const onOpen = vi.fn()
    const onClick = vi.fn()
    render(<Row onOpen={onOpen} onClick={onClick} />)
    return { onOpen, onClick, link: screen.getByTestId('link') }
  }

  it('長押し（0.5秒）で開き、離した時のクリック（リンクの移動）は取り消す', () => {
    const { onOpen, onClick, link } = setup()
    fireEvent.pointerDown(link, { ...touch, clientX: 20, clientY: 30 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 10))
    expect(onOpen).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(20))
    expect(onOpen).toHaveBeenCalledWith({ x: 20, y: 30 })
    fireEvent.pointerUp(link, touch)
    fireEvent.click(link)
    expect(onClick).not.toHaveBeenCalled()
    // 次のタップはふつうに押せる
    fireEvent.pointerDown(link, touch)
    fireEvent.pointerUp(link, touch)
    fireEvent.click(link)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('指が動いた（スクロール）・すぐ離した・スクロールした時は開かない', () => {
    const { onOpen, link } = setup()
    fireEvent.pointerDown(link, { ...touch, clientX: 20, clientY: 30 })
    fireEvent.pointerMove(link, { ...touch, clientX: 20, clientY: 60 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(link, touch)
    fireEvent.pointerUp(link, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(link, touch)
    fireEvent.scroll(window)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(link, touch)
    fireEvent.pointerCancel(link, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('右クリック（マウス）は contextmenu で開き、ブラウザのメニューは出さない。長押しの直後の contextmenu（Android）は二重に開かない', () => {
    const { onOpen, link } = setup()
    const ev = fireEvent.contextMenu(link, { clientX: 5, clientY: 6 })
    expect(ev).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
    // マウスの押下は長押しにならない
    fireEvent.pointerDown(link, { pointerType: 'mouse', isPrimary: true, button: 0 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(onOpen).toHaveBeenCalledTimes(1)
    // 長押しで開いた直後に届く contextmenu は無視する
    fireEvent.pointerDown(link, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(fireEvent.contextMenu(link)).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
