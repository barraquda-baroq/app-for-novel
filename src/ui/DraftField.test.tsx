// 下書きの反映（自動保存の画面: メモ・設定項目・戦略・アイデアなど）
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftTextarea, type DraftHandle } from './DraftField'

afterEach(cleanup)

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
})
