// 下書きの反映: 編集中に保存先が別の端末の編集で書き換えられたら、上書きせずに控える。
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftTextarea, type DraftHandle } from './DraftField'

afterEach(cleanup)

describe('DraftTextarea の競合の扱い', () => {
  it('編集中に保存先が変わっていたら onCommit せずに onConflict へ渡し、届いた内容を表示する', async () => {
    const user = userEvent.setup()
    let stored = '元の本文'
    const onCommit = vi.fn((v: string) => {
      stored = v
    })
    const onConflict = vi.fn()
    const ref = { current: null as DraftHandle | null }
    const view = render(
      <DraftTextarea
        ref={ref}
        data-testid="body"
        value={stored}
        delay={10_000}
        onCommit={onCommit}
        conflictGuard={{ read: () => stored, onConflict }}
      />,
    )
    await user.type(screen.getByTestId('body'), '。追記')
    // 同期で別の端末の本文が届いた
    stored = '別の端末の本文'
    view.rerender(
      <DraftTextarea
        ref={ref}
        data-testid="body"
        value={stored}
        delay={10_000}
        onCommit={onCommit}
        conflictGuard={{ read: () => stored, onConflict }}
      />,
    )
    act(() => ref.current?.flush())
    expect(onCommit).not.toHaveBeenCalled()
    expect(onConflict).toHaveBeenCalledWith('元の本文。追記')
    expect((screen.getByTestId('body') as HTMLTextAreaElement).value).toBe('別の端末の本文')
  })

  it('自分の反映の後に続けて書いた分は、競合にしない', async () => {
    const user = userEvent.setup()
    let stored = 'あ'
    const onConflict = vi.fn()
    const ref = { current: null as DraftHandle | null }
    const props = () => ({
      value: stored,
      delay: 10_000,
      onCommit: (v: string) => {
        stored = v
      },
      conflictGuard: { read: () => stored, onConflict },
    })
    const view = render(<DraftTextarea ref={ref} data-testid="body" {...props()} />)
    await user.type(screen.getByTestId('body'), 'い')
    act(() => ref.current?.flush())
    expect(stored).toBe('あい')
    await user.type(screen.getByTestId('body'), 'う')
    view.rerender(<DraftTextarea ref={ref} data-testid="body" {...props()} />)
    act(() => ref.current?.flush())
    expect(onConflict).not.toHaveBeenCalled()
    expect(stored).toBe('あいう')
  })
})
