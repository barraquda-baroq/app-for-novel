// 行の操作メニュー: 外側を押すと閉じるだけ（下のリンクは開かない）。高さだけの変化では閉じず、幅が変わったら閉じる。
// 記号バーの括弧の一覧（上に開く・本文のフォーカスを動かさない・横一列）も確かめる
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetNativeKeyboardForTests, setNativeKeyboardHeight } from '../platform/keyboard'
import { closeTopLayer } from '../platform/nativeInit'
import { PopupMenu, type PopupMenuProps } from './PopupMenu'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Harness({ onLink }: { onLink: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <a
        href="#/elsewhere"
        data-testid="row-link"
        onClick={(e) => {
          e.preventDefault()
          onLink()
        }}
      >
        別の行
      </a>
      {open ? (
        <PopupMenu
          label="操作"
          items={[{ label: '開く', onSelect: () => {}, testId: 'menu-open' }]}
          placement={{ point: { x: 10, y: 10 } }}
          onClose={() => setOpen(false)}
          testId="row-menu"
        />
      ) : null}
    </>
  )
}

const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

describe('PopupMenu', () => {
  it('外側を押して閉じた時は、続くクリック（下の行のリンク）を取り消す。次に押した時はふつうに届く', () => {
    const onLink = vi.fn()
    render(<Harness onLink={onLink} />)
    const link = screen.getByTestId('row-link')
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    fireEvent.pointerDown(link)
    expect(screen.queryByTestId('row-menu')).toBeNull()
    fireEvent.click(link)
    expect(onLink).not.toHaveBeenCalled()
    // 次に触れた時のクリックは取り消さない
    fireEvent.pointerDown(link)
    fireEvent.click(link)
    expect(onLink).toHaveBeenCalledTimes(1)
  })

  it('クリックが届かなければ、取り消しは少し経つと終わる', () => {
    vi.useFakeTimers()
    const onLink = vi.fn()
    render(<Harness onLink={onLink} />)
    const link = screen.getByTestId('row-link')
    fireEvent.pointerDown(link)
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    fireEvent.click(link)
    expect(onLink).toHaveBeenCalledTimes(1)
  })

  it('長押しした所が画面キーボードに隠れる所なら、キーボードの上に置く', () => {
    setWindowSize(400, 800)
    fakeLayout({ top: 0, bottom: 0, left: 0, right: 0 })
    setNativeKeyboardHeight(300)
    try {
      render(
        <PopupMenu
          label="操作"
          items={[{ label: '開く', onSelect: () => {} }]}
          placement={{ point: { x: 10, y: 700 } }}
          onClose={() => {}}
          testId="row-menu"
        />,
      )
      // 下端はキーボードの上端（800 - 300）から 8px 離す
      expect(screen.getByTestId('row-menu').style.top).toBe(`${800 - 300 - 60 - 8}px`)
    } finally {
      resetNativeKeyboardForTests()
    }
  })

  it('画面の高さだけが変わった時（画面キーボードの開閉）は閉じず、幅が変わった時（回転）は閉じる', () => {
    setWindowSize(360, 400)
    render(<Harness onLink={() => {}} />)
    act(() => setWindowSize(360, 740))
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    act(() => setWindowSize(740, 360))
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })
})

/** 押した要素の位置とメニューの大きさ（jsdom は測らないので差し替える） */
function fakeLayout(rect: { top: number; bottom: number; left: number; right: number }, size = { w: 200, h: 60 }) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pm-menu') ? size.w : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pm-menu') ? size.h : 0
  })
  const box = { ...rect }
  const anchorRect = () =>
    ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) as DOMRect
  return { box, anchorRect }
}

/** 本文の入力欄と、それに働く上向きのメニュー（記号バーの括弧と同じ使い方） */
function FieldHarness({
  menu,
  onFieldEscape = () => {},
  onSymbol = () => {},
  rect,
}: {
  menu: Partial<PopupMenuProps>
  onFieldEscape?: () => void
  onSymbol?: () => void
  rect?: () => DOMRect
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <textarea
        data-testid="field"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onFieldEscape()
        }}
      />
      <button
        type="button"
        data-testid="anchor"
        ref={(el) => {
          anchor.current = el
          if (el && rect) el.getBoundingClientRect = rect
        }}
        onClick={() => setOpen((o) => !o)}
      >
        括弧
      </button>
      <button type="button" data-testid="other-symbol" onClick={onSymbol}>
        ――
      </button>
      {open && anchor.current ? (
        <PopupMenu
          label="括弧"
          items={[
            { label: '「」', ariaLabel: 'かぎ括弧（「」）', onSelect: () => {}, testId: 'item-a' },
            { label: '『』', onSelect: () => {}, testId: 'item-b' },
            { label: '（）', onSelect: () => {}, testId: 'item-c' },
          ]}
          placement={{ anchor: anchor.current, side: 'above' }}
          onClose={() => setOpen(false)}
          testId="field-menu"
          {...menu}
        />
      ) : null}
    </>
  )
}

describe('PopupMenu（上に開く・本文のフォーカスを動かさない一覧）', () => {
  it('上に開き、上に入らなければ下に開く。今の呼び出し（下に開く）は変えない', () => {
    setWindowSize(400, 800)
    const { anchorRect } = fakeLayout({ top: 700, bottom: 740, left: 180, right: 220 })
    const { unmount } = render(<FieldHarness menu={{ autoFocus: false }} rect={anchorRect} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('field-menu')
    // 下端は押した所の上（8px 空ける）、横は押した所の真ん中に合わせる
    expect(menu.style.top).toBe(`${700 - 60 - 8}px`)
    expect(menu.style.left).toBe(`${200 - 100}px`)
    expect(menu.style.visibility).toBe('visible')
    unmount()

    const top = fakeLayout({ top: 20, bottom: 60, left: 10, right: 50 })
    render(<FieldHarness menu={{ autoFocus: false }} rect={top.anchorRect} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const below = screen.getByTestId('field-menu')
    expect(below.style.top).toBe(`${60 + 4}px`)
    // 画面の左端からはみ出さない
    expect(below.style.left).toBe('8px')
  })

  it('開いている間に画面の高さだけが変わったら（キーボードの開閉）、動いたボタンの上に置き直す', async () => {
    setWindowSize(400, 800)
    const { box, anchorRect } = fakeLayout({ top: 400, bottom: 440, left: 180, right: 220 })
    render(<FieldHarness menu={{ autoFocus: false }} rect={anchorRect} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('field-menu')
    expect(menu.style.top).toBe(`${400 - 68}px`)
    box.top = 700
    box.bottom = 740
    act(() => setWindowSize(400, 800))
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
    expect(menu.style.top).toBe(`${700 - 68}px`)
    expect(screen.getByTestId('field-menu')).toBe(menu)
  })

  it('autoFocus=false: 開いてもフォーカスは本文のまま。Esc は一覧だけを閉じ、本文には届かない', () => {
    const onFieldEscape = vi.fn()
    render(<FieldHarness menu={{ autoFocus: false }} onFieldEscape={onFieldEscape} />)
    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.click(screen.getByTestId('anchor'))
    expect(screen.getByTestId('field-menu')).toBeTruthy()
    expect(document.activeElement).toBe(field)
    // 1回の Esc で閉じるのは一覧だけ（本文の側の Esc の扱い（検索窓など）は動かない）
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByTestId('field-menu')).toBeNull()
    expect(onFieldEscape).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
    // 一覧が無ければ、Esc は本文に届く
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onFieldEscape).toHaveBeenCalledTimes(1)
  })

  it('日本語の変換中の Esc（変換の取り消し）では閉じない', () => {
    render(<FieldHarness menu={{ autoFocus: false }} />)
    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.click(screen.getByTestId('anchor'))
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    expect(screen.getByTestId('field-menu')).toBeTruthy()
  })

  it('Android の「戻る」（closeTopLayer が role=menu に送る Esc）でも閉じる', () => {
    render(<FieldHarness menu={{ autoFocus: false }} />)
    screen.getByTestId('field').focus()
    fireEvent.click(screen.getByTestId('anchor'))
    let closed = false
    act(() => {
      closed = closeTopLayer()
    })
    expect(closed).toBe(true)
    expect(screen.queryByTestId('field-menu')).toBeNull()
    expect(closeTopLayer()).toBe(false)
  })

  it('keepFocus: 押してもフォーカスを奪わない（pointerdown・mousedown を止める）', () => {
    render(<FieldHarness menu={{ autoFocus: false, keepFocus: true }} />)
    screen.getByTestId('field').focus()
    fireEvent.click(screen.getByTestId('anchor'))
    const item = screen.getByTestId('item-a')
    // fireEvent は既定の動きを止められた時に false を返す
    expect(fireEvent.pointerDown(item)).toBe(false)
    expect(fireEvent.mouseDown(item)).toBe(false)
    // keepFocus の無いメニューは止めない
    cleanup()
    render(<FieldHarness menu={{ autoFocus: false }} />)
    fireEvent.click(screen.getByTestId('anchor'))
    expect(fireEvent.mouseDown(screen.getByTestId('item-a'))).toBe(true)
  })

  it('swallowOutsideClick=false: 開いたまま別のボタンを押すと、閉じてそのボタンも1回で働く', () => {
    const onSymbol = vi.fn()
    render(<FieldHarness menu={{ autoFocus: false, swallowOutsideClick: false }} onSymbol={onSymbol} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const other = screen.getByTestId('other-symbol')
    fireEvent.pointerDown(other)
    expect(screen.queryByTestId('field-menu')).toBeNull()
    fireEvent.click(other)
    expect(onSymbol).toHaveBeenCalledTimes(1)
  })

  it('押した所（anchor）を押すと、そのボタンの操作で閉じる（外側として閉じ直さない）', () => {
    render(<FieldHarness menu={{ autoFocus: false }} />)
    const anchor = screen.getByTestId('anchor')
    fireEvent.click(anchor)
    fireEvent.pointerDown(anchor)
    expect(screen.getByTestId('field-menu')).toBeTruthy()
    fireEvent.click(anchor)
    expect(screen.queryByTestId('field-menu')).toBeNull()
  })

  it('layout=row: 横一列（aria-orientation）で、←→ でも動く。ariaLabel は読み上げの名前になる', () => {
    render(<FieldHarness menu={{ layout: 'row' }} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('field-menu')
    expect(menu.className).toContain('is-row')
    expect(menu.getAttribute('aria-orientation')).toBe('horizontal')
    expect(menu.style.getPropertyValue('--pm-cols')).toBe('3')
    expect(screen.getByTestId('item-a').getAttribute('aria-label')).toBe('かぎ括弧（「」）')
    expect(screen.getByTestId('item-b').hasAttribute('aria-label')).toBe(false)
    // 既定（autoFocus）は最初の項目へ
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('item-b'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByTestId('item-c'))
    // Esc で閉じると、開く前の要素（ここでは押した所）へ戻る
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByTestId('field-menu')).toBeNull()
  })

  it('縦のメニュー（既定）では ←→ で動かない', () => {
    render(<FieldHarness menu={{}} />)
    fireEvent.click(screen.getByTestId('anchor'))
    const menu = screen.getByTestId('field-menu')
    expect(menu.className).not.toContain('is-row')
    expect(menu.hasAttribute('aria-orientation')).toBe(false)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('item-a'))
  })
})
