import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../db/persistence'
import { actions } from './actions'
import { applyRecoveryJournal, flushNow, initStore, replaceAllData, resetStoreForTests, useApp, writeRecoveryJournal } from './appStore'
import { markDraftDirty } from './draftRegistry'
import { saveBeforeLeave } from './lifecycle'
import { emptyData, type AppData } from '../domain/types'

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

describe('閉じる直前の変更の復旧', () => {
  it('保存が終わる前に閉じても、控えから次回起動時に復元される', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('復旧テスト')
    await flushNow()
    // 保存が終わらないうちに閉じたことにする（控えだけ書いて、保存は待たない）
    actions.updateTitle(titleId, { synopsis: '閉じる直前に書いたあらすじ' })
    writeRecoveryJournal()
    resetStoreForTests()

    await initStore(createPersistence(name))
    expect(useApp.getState().data.titles[titleId].synopsis).toBe('閉じる直前に書いたあらすじ')
    expect(useApp.getState().recoveredCount).toBe(1)
    await flushNow()
    // 保存が終わると控えは消え、次の起動では何も復元しない
    resetStoreForTests()
    await initStore(createPersistence(name))
    expect(useApp.getState().recoveredCount).toBe(0)
    expect(useApp.getState().data.titles[titleId].synopsis).toBe('閉じる直前に書いたあらすじ')
  })

  it('控えより新しい保存済みの内容は上書きしない', async () => {
    const base = emptyData()
    const t = { id: 't1', name: '新', synopsis: '新しい', updatedAt: 200 } as unknown as AppData['titles'][string]
    const loaded: AppData = { ...base, titles: { t1: t } }
    localStorage.setItem(
      'novel-studio:recovery:other-tab',
      JSON.stringify({ at: 150, puts: { titles: [{ ...t, synopsis: '古い', updatedAt: 100 }] }, dels: {} }),
    )
    const r = applyRecoveryJournal(loaded)
    expect(r.count).toBe(0)
    expect(r.data.titles.t1.synopsis).toBe('新しい')
    localStorage.clear()
  })

  it('入力欄の下書きは、閉じる時にストアの保存より先に反映される', async () => {
    const save = vi.fn(async () => {})
    await initStore({ load: async () => emptyData(), save, replaceAll: async () => {}, close: () => {} })
    const titleId = actions.createTitle('下書き')
    let draft = ''
    markDraftDirty(Symbol('t'), () => actions.updateTitle(titleId, { synopsis: draft }))
    draft = '未反映の下書き'
    await saveBeforeLeave()
    expect(useApp.getState().data.titles[titleId].synopsis).toBe('未反映の下書き')
    const lastCall = save.mock.calls.at(-1) as unknown as [AppData, AppData]
    expect(lastCall[1].titles[titleId].synopsis).toBe('未反映の下書き')
  })
})
