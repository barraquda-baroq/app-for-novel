import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../db/persistence'
import { actions } from './actions'
import { flushNow, initStore, replaceAllData, resetStoreForTests, useApp } from './appStore'
import { emptyData } from '../domain/types'

let n = 0
const freshDb = () => createPersistence(`test-db-${++n}`)

afterEach(() => resetStoreForTests())

describe('自動保存', () => {
  it('変更が IndexedDB に保存され、読み込み直すと復元される', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('保存テスト')
    const pieceId = actions.addEpisode(titleId)
    const versionId = useApp.getState().data.pieces[pieceId].versionIds[0]
    actions.updateVersion(versionId, { body: '本文です' })
    await flushNow()
    expect(useApp.getState().saveStatus).toBe('saved')

    resetStoreForTests()
    await initStore(createPersistence(name))
    const data = useApp.getState().data
    expect(data.titles[titleId].name).toBe('保存テスト')
    expect(data.versions[versionId].body).toBe('本文です')

    // 削除も反映される
    actions.deleteTitle(titleId)
    await flushNow()
    resetStoreForTests()
    await initStore(createPersistence(name))
    expect(useApp.getState().data).toEqual(emptyData())
  })

  it('バックアップの読み込みで全データを置き換える', async () => {
    await initStore(freshDb())
    actions.createTitle('消える作品')
    await flushNow()
    const replacement = emptyData()
    await replaceAllData(replacement)
    expect(Object.keys(useApp.getState().data.titles)).toHaveLength(0)
  })
})

describe('保存のタイミング', () => {
  it('操作が続いても、最初の変更から一定時間内に保存される', async () => {
    const save = vi.fn(async () => {})
    await initStore({ load: async () => emptyData(), save, replaceAll: async () => {}, close: () => {} })
    vi.useFakeTimers()
    try {
      const titleId = actions.createTitle('連続編集')
      // 300ms ごとに編集し続ける（毎回 400ms の待ちがリセットされる）
      for (let i = 0; i < 8; i++) {
        actions.updateTitle(titleId, { synopsis: `あらすじ${i}` })
        await vi.advanceTimersByTimeAsync(300)
      }
      expect(save).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
