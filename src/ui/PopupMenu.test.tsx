// 行の操作メニュー: 外側を押すと閉じるだけ（下のリンクは開かない）。高さだけの変化では閉じず、幅が変わったら閉じる
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PopupMenu } from './PopupMenu'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

  it('画面の高さだけが変わった時（画面キーボードの開閉）は閉じず、幅が変わった時（回転）は閉じる', () => {
    setWindowSize(360, 400)
    render(<Harness onLink={() => {}} />)
    act(() => setWindowSize(360, 740))
    expect(screen.getByTestId('row-menu')).toBeTruthy()
    act(() => setWindowSize(740, 360))
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })
})
