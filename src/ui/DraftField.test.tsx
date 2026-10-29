// 下書きの反映（自動保存の画面: メモ・設定項目・戦略・アイデアなど）
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftInput, DraftTextarea, type DraftHandle } from './DraftField'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DraftTextarea', () => {
  it('入力は少し待ってから（または flush で）まとめて onCommit に渡す', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    const ref = { current: null as DraftHandle | null }
    render(<DraftTextarea ref={ref} data-testid="body" value="元の本文" delay={10_000} onCommit={onCommit} />)
    await user.type(screen.getByTestId('body'), '。追記')
    expect(onCommit).not.toHaveBeenCalled()
    act(() => ref.current?.flush())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('元の本文。追記')
  })

  it('編集していない間は、別の操作で変わった値に追従する', () => {
    const onCommit = vi.fn()
    const view = render(<DraftTextarea data-testid="body" value="あ" onCommit={onCommit} />)
    view.rerender(<DraftTextarea data-testid="body" value="別の端末の本文" onCommit={onCommit} />)
    expect((screen.getByTestId('body') as HTMLTextAreaElement).value).toBe('別の端末の本文')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('ふつうの欄は打ち続けていても、最初の入力から 1.5 秒以内に反映する（閉じた時に失わないため）', () => {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<DraftTextarea data-testid="body" value="" onCommit={onCommit} />)
    const el = screen.getByTestId('body')
    // 0.4 秒おきに打ち続ける（0.5 秒の間が空かない）。最後の入力は 1.2 秒の時点
    let text = ''
    for (let i = 0; i < 4; i++) {
      if (i > 0) act(() => vi.advanceTimersByTime(400))
      text += 'あ'
      fireEvent.change(el, { target: { value: text } })
    }
    act(() => vi.advanceTimersByTime(299))
    expect(onCommit).not.toHaveBeenCalled()
    // 最初の入力から 1.5 秒で反映される（最後の入力から 0.5 秒は待たない）
    act(() => vi.advanceTimersByTime(1))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('ああああ')
  })
})

describe('DraftInput', () => {
  it('確定した時だけ保存する欄（長い delay）は、日本語入力で変換している途中に区切って保存しない', () => {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<DraftInput data-testid="limit" value="" delay={10 * 60 * 1000} onCommit={onCommit} />)
    const el = screen.getByTestId('limit') as HTMLInputElement
    el.focus()
    fireEvent.compositionStart(el)
    fireEvent.change(el, { target: { value: '１０' } })
    fireEvent.change(el, { target: { value: '１０ま' } })
    act(() => vi.advanceTimersByTime(2000))
    expect(onCommit).not.toHaveBeenCalled()
    // 作り直されず、変換中の文字もフォーカスもそのまま
    expect(screen.getByTestId('limit')).toBe(el)
    expect(el.value).toBe('１０ま')
    expect(document.activeElement).toBe(el)

    fireEvent.compositionEnd(el)
    fireEvent.change(el, { target: { value: '１０万' } })
    fireEvent.keyDown(el, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('１０万')
  })

  it('確定した時だけ保存する欄も、Enter を押さずにフォーカスを外せば保存する', () => {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<DraftInput data-testid="limit" value="" delay={10 * 60 * 1000} onCommit={onCommit} />)
    const el = screen.getByTestId('limit')
    el.focus()
    fireEvent.change(el, { target: { value: '800' } })
    act(() => vi.advanceTimersByTime(5000))
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(el)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('800')
  })
})
