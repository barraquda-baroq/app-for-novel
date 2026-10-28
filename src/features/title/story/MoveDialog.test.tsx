import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../../db/persistence'
import * as storyOps from '../../../domain/storyOps'
import { flatten } from '../../../domain/structure'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { MoveDialog } from './MoveDialog'

// 移動先の候補に現在の位置が含まれない（想定外の）場合を作るため、insertOptions だけ差し替えられるようにする
vi.mock('../../../domain/storyOps', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../domain/storyOps')>()
  return { ...mod, insertOptions: vi.fn(mod.insertOptions) }
})

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-move-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  vi.mocked(storyOps.insertOptions).mockReset()
})

function seedThree(): { titleId: ID; ids: ID[] } {
  const titleId = actions.createTitle('作品')
  const ids = [0, 1, 2].map(() => actions.addEpisode(titleId))
  return { titleId, ids }
}

async function useRealInsertOptions() {
  const real = await vi.importActual<typeof import('../../../domain/storyOps')>('../../../domain/storyOps')
  vi.mocked(storyOps.insertOptions).mockImplementation(real.insertOptions)
  return real
}

describe('MoveDialog', () => {
  it('現在の位置が選ばれた状態で開き、移動するは押せない', async () => {
    await useRealInsertOptions()
    const { ids } = seedThree()
    render(<MoveDialog pieceId={ids[1]} onClose={() => {}} />)
    const select = screen.getByTestId<HTMLSelectElement>('move-target')
    expect(select.selectedOptions[0].textContent).toContain('（現在の位置）')
    expect(screen.getByTestId('move-submit')).toHaveProperty('disabled', true)
  })

  it('現在の位置が候補に見つからなければ、先頭を選ばずに移動先を選ぶまで押せない', async () => {
    const real = await useRealInsertOptions()
    // 現在の位置（第2話の位置）を候補から外す
    vi.mocked(storyOps.insertOptions).mockImplementation((data, titleId, exclude) =>
      real.insertOptions(data, titleId, exclude).filter((o) => !(o.slot.chapterId === null && o.slot.index === 1)),
    )
    const user = userEvent.setup()
    const { titleId, ids } = seedThree()
    const onClose = vi.fn()
    render(<MoveDialog pieceId={ids[1]} onClose={onClose} />)

    const select = screen.getByTestId<HTMLSelectElement>('move-target')
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].textContent).toBe('移動先を選んでください')
    expect(screen.getByTestId('move-submit')).toHaveProperty('disabled', true)
    // フォームを送信しても何も動かない
    await user.click(screen.getByTestId('move-submit'))
    expect(flatten(getData(), titleId).map((f) => f.pieceId)).toEqual(ids)
    expect(onClose).not.toHaveBeenCalled()

    // 選べば移動できる
    await user.selectOptions(select, '0')
    expect(screen.getByTestId('move-submit')).toHaveProperty('disabled', false)
    await user.click(screen.getByTestId('move-submit'))
    expect(flatten(getData(), titleId).map((f) => f.pieceId)).toEqual([ids[1], ids[0], ids[2]])
    expect(onClose).toHaveBeenCalled()
  })
})
