import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lightTap } from '../platform/haptics'
import '../test/pointerEvent'
import { LIFT_CLICK_MS, LONG_PRESS_MS, PRESS_IGNORE, useMenuTrigger } from './longPress'

vi.mock('../platform/haptics', () => ({ lightTap: vi.fn() }))

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

describe('Android の長押し（contextmenu がタイマーより先に届く）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(lightTap).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('開いて軽く振動し、離した時のクリックは取り消す。タイマーでもう一度開かず、続けて届く contextmenu も無視する', () => {
    const onOpen = vi.fn()
    const onClick = vi.fn()
    render(<Row onOpen={onOpen} onClick={onClick} />)
    const link = screen.getByTestId('link')
    fireEvent.pointerDown(link, { ...touch, clientX: 20, clientY: 30 })
    act(() => vi.advanceTimersByTime(400))
    expect(fireEvent.contextMenu(link, { clientX: 20, clientY: 30 })).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(lightTap).toHaveBeenCalledTimes(1)
    // 続けて届いたもの（1秒以内）はブラウザのメニューも出さず、開き直さない
    expect(fireEvent.contextMenu(link)).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(link, touch)
    fireEvent.click(link)
    expect(onClick).not.toHaveBeenCalled()
  })
})

/** アイデアのカード（2.9）の使い方: 指だけ・中のボタンからは始めない・離した時のクリックはどこに届いても取り消す */
function Card(props: { onOpen: () => void; onMain: () => void; onInner: () => void; onSibling: () => void }) {
  const handlers = useMenuTrigger(() => props.onOpen(), { touchOnly: true, ignore: PRESS_IGNORE, swallowClick: true })
  return (
    <div>
      <div data-testid="main" {...handlers} onClick={props.onMain}>
        <p data-testid="text">本文</p>
        <button type="button" data-testid="inner" onClick={props.onInner}>
          続きを表示
        </button>
        {createPortal(<p data-testid="portaled">ダイアログ</p>, document.body)}
      </div>
      <button type="button" data-testid="sibling" onClick={props.onSibling}>
        ほかのカード
      </button>
    </div>
  )
}

describe('長押しの options（touchOnly・ignore・swallowClick）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(lightTap).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  function setup() {
    const fns = { onOpen: vi.fn(), onMain: vi.fn(), onInner: vi.fn(), onSibling: vi.fn() }
    render(<Card {...fns} />)
    return {
      ...fns,
      text: screen.getByTestId('text'),
      inner: screen.getByTestId('inner'),
      sibling: screen.getByTestId('sibling'),
    }
  }

  /** 指で長押しして開く */
  function longPress(target: HTMLElement) {
    fireEvent.pointerDown(target, { ...touch, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
  }

  it('touchOnly: マウスの右クリック・メニューキーはブラウザのメニューのまま（止めない）で開かない。マウスの押し続けでも開かない', () => {
    const { onOpen, text } = setup()
    expect(fireEvent.contextMenu(text, { clientX: 5, clientY: 6 })).toBe(true)
    expect(fireEvent.contextMenu(text)).toBe(true)
    fireEvent.pointerDown(text, { pointerType: 'mouse', isPrimary: true, button: 0 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('touchOnly: Android の長押し（0.4秒で contextmenu）は止めて開き、振動する。タイマーではもう開かない', () => {
    const { onOpen, text } = setup()
    fireEvent.pointerDown(text, { ...touch, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(400))
    expect(fireEvent.contextMenu(text, { clientX: 10, clientY: 10 })).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(lightTap).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('touchOnly: タイマーで開いた直後に届く contextmenu は止めて、開き直さない', () => {
    const { onOpen, text } = setup()
    longPress(text)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(lightTap).toHaveBeenCalledTimes(1)
    expect(fireEvent.contextMenu(text)).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('ignore: 中のボタンから始めた長押しは何もしない（contextmenu も止めない）。文の所からなら開く', () => {
    const { onOpen, inner, text } = setup()
    fireEvent.pointerDown(inner, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    expect(fireEvent.contextMenu(inner)).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
    longPress(text)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('React の portal で中に描いたもの（ダイアログなど）から届いた押し下げ・右クリックは受けない', () => {
    const { onOpen } = setup()
    const portaled = screen.getByTestId('portaled')
    fireEvent.pointerDown(portaled, touch)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    fireEvent.pointerDown(portaled, touch)
    act(() => vi.advanceTimersByTime(400))
    expect(fireEvent.contextMenu(portaled)).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('swallowClick: 開いた後に指を離した時のクリックは、要素の外（並びが動いて指の下に来たほかのカード）に届いても取り消す。1回だけ', () => {
    const { onOpen, onMain, onSibling, text, sibling } = setup()
    longPress(text)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(sibling, touch)
    expect(fireEvent.click(sibling)).toBe(false)
    expect(onSibling).not.toHaveBeenCalled()
    fireEvent.click(sibling)
    expect(onSibling).toHaveBeenCalledTimes(1)
    // 押した要素に届いた時も
    longPress(text)
    fireEvent.pointerUp(text, touch)
    fireEvent.click(text)
    expect(onMain).not.toHaveBeenCalled()
    // ふつうのタップは取り消さない
    fireEvent.pointerDown(text, touch)
    fireEvent.pointerUp(text, touch)
    fireEvent.click(text)
    expect(onMain).toHaveBeenCalledTimes(1)
  })

  it('swallowClick: 次に触れた時・離してから0.4秒届かなかった時は取り消すのをやめる。離すまでは長く押していても取り消す', () => {
    const { onSibling, text, sibling } = setup()
    // 次に触れた
    longPress(text)
    fireEvent.pointerUp(text, touch)
    fireEvent.pointerDown(sibling, touch)
    fireEvent.pointerUp(sibling, touch)
    fireEvent.click(sibling)
    expect(onSibling).toHaveBeenCalledTimes(1)
    // 離してから0.4秒、クリックが届かなかった（iOS）
    longPress(text)
    fireEvent.pointerUp(text, touch)
    act(() => vi.advanceTimersByTime(LIFT_CLICK_MS))
    fireEvent.click(sibling)
    expect(onSibling).toHaveBeenCalledTimes(2)
    // 2秒押したままにしてから離した
    longPress(text)
    act(() => vi.advanceTimersByTime(2000))
    fireEvent.pointerUp(text, touch)
    fireEvent.click(sibling)
    expect(onSibling).toHaveBeenCalledTimes(2)
    // 押していて指がずれた（pointercancel）後も、0.4秒たてば取り消さない
    longPress(text)
    fireEvent.pointerCancel(text, touch)
    act(() => vi.advanceTimersByTime(LIFT_CLICK_MS))
    fireEvent.click(sibling)
    expect(onSibling).toHaveBeenCalledTimes(3)
  })
})
