import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../db/persistence'
import { actions } from './actions'
import {
  applyRecoveryJournal,
  flushNow,
  initStore,
  reloadFromDisk,
  replaceAllData,
  resetStoreForTests,
  useApp,
  writeRecoveryJournal,
} from './appStore'
import { markDraftDirty } from './draftRegistry'
import { saveBeforeLeave } from './lifecycle'
import { toBackup } from '../domain/backup'
import { emptyData, type AppData } from '../domain/types'
import { emptyOutcome, fakePersistence } from '../test/fakePersistence'

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

    // 削除（ゴミ箱へ移す）も反映される
    actions.deleteTitle(titleId)
    await flushNow()
    resetStoreForTests()
    await initStore(createPersistence(name))
    const after = useApp.getState().data
    expect({ ...after, trashEntries: {}, trashRecords: {} }).toEqual(emptyData())
    expect(Object.values(after.trashEntries).map((e) => e.label)).toEqual(['保存テスト'])
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
    const save = vi.fn(async () => emptyOutcome())
    await initStore(fakePersistence({ save }))
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
    const save = vi.fn(async () => emptyOutcome())
    await initStore(fakePersistence({ save }))
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

describe('複数タブ・保存失敗', () => {
  it('別タブが先に変えた項目は上書きせず、このタブが変えた項目だけを重ねて保存する', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('元の名前')
    await flushNow()
    // 別タブ: 名前を変えて保存
    const other = createPersistence(name)
    const disk = await other.load()
    const renamed = { ...disk.titles[titleId], name: '別タブの名前', updatedAt: Date.now() + 1000 }
    await other.save(disk, { ...disk, titles: { ...disk.titles, [titleId]: renamed } })
    // このタブ: 古い内容のまま、あらすじだけ変えて保存
    actions.updateTitle(titleId, { synopsis: 'このタブのあらすじ' })
    expect(await flushNow()).toBe(true)
    const after = await other.load()
    expect(after.titles[titleId].name).toBe('別タブの名前')
    expect(after.titles[titleId].synopsis).toBe('このタブのあらすじ')
    // メモリ上も合わせた内容になる
    expect(useApp.getState().data.titles[titleId].name).toBe('別タブの名前')
    other.close()
  })

  it('修復が表示から外した、知らない項目（新しい版が書いた応募時の記録の項目など）は、そのレコードを書き換えても端末内に残る', async () => {
    // 古い版の端末が、新しい版の書いた項目を持つレコードを書き換えた時と同じ（修復は表示用の内容にだけ当てる）
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('作品')
    const subId = actions.addSubmission(titleId, 'A賞')
    await flushNow()
    resetStoreForTests()
    // 新しい版の端末が書いた内容（応募時の記録の中と、応募計画そのものに、この版の知らない項目がある）
    const writer = createPersistence(name)
    const disk = await writer.load()
    const snapshot = { at: 1, charCount: 0, activeVersions: {}, futureField: '新しい版の控え' }
    const raw = { ...disk.submissions[subId], snapshot, futureTop: '新しい版の項目' }
    await writer.save(disk, { ...disk, submissions: { [subId]: raw } })
    writer.close()

    await initStore(createPersistence(name))
    // 表示用の内容では、修復が記録の知らない項目を外す（応募計画そのものの知らない項目は残る）
    const view = useApp.getState().data.submissions[subId] as unknown as Record<string, unknown>
    expect((view.snapshot as Record<string, unknown>).futureField).toBeUndefined()
    expect(view.futureTop).toBe('新しい版の項目')
    actions.updateSubmission(subId, { overview: '書き換えた概要' })
    expect(await flushNow()).toBe(true)
    const other = createPersistence(name)
    const saved = (await other.load()).submissions[subId] as unknown as Record<string, unknown>
    expect(saved.overview).toBe('書き換えた概要')
    expect(saved.futureTop).toBe('新しい版の項目')
    expect(saved.snapshot).toEqual(snapshot)
    other.close()
  })

  it('まだ届いていないベンチ作品への比べる作品の印は、表示では外しても、タイトルを書き換えた時に端末内に残る（作品が届けばまた見える）', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('作品')
    const workId = actions.addBenchWork({ name: '銀河の果て' })
    actions.addTitleBenchWork(titleId, workId)
    await flushNow()
    resetStoreForTests()
    // 別の端末で比べる作品にした作品が、タイトルより後に届く（この端末にはまだ無い）
    const writer = createPersistence(name)
    const disk = await writer.load()
    await writer.save(disk, { ...disk, titles: { [titleId]: { ...disk.titles[titleId], benchWorkIds: [workId, 'later'] } } })
    writer.close()

    await initStore(createPersistence(name))
    expect(useApp.getState().data.titles[titleId].benchWorkIds).toEqual([workId])
    actions.updateTitle(titleId, { name: '作品（改題）' })
    expect(await flushNow()).toBe(true)
    const other = createPersistence(name)
    const saved = (await other.load()).titles[titleId]
    expect(saved.name).toBe('作品（改題）')
    expect(saved.benchWorkIds).toEqual([workId, 'later'])
    other.close()
  })

  it('ただし修復が表示から外した記録の中の項目は、削除して戻す・バックアップの書き出し・復元では残らない（古い版の端末で応募時の控えが消える仕組み。SPEC-2 の 9.）', async () => {
    // 新しい版の端末が書いた内容を、この版の修復が知らない項目として扱う（2.4 までの端末と `snapshot.synopsis` の関係と同じ）
    const snapshot = { at: 1, charCount: 0, activeVersions: {}, futureField: '新しい版の控え' }
    const seedNewer = async () => {
      const name = `test-db-${++n}`
      await initStore(createPersistence(name))
      const subId = actions.addSubmission(actions.createTitle('作品'), 'A賞')
      await flushNow()
      resetStoreForTests()
      const writer = createPersistence(name)
      const disk = await writer.load()
      const raw = { ...disk.submissions[subId], snapshot, futureTop: '新しい版の項目' }
      const newer = { ...disk, submissions: { [subId]: raw } }
      await writer.save(disk, newer)
      writer.close()
      await initStore(createPersistence(name))
      const loadSaved = async () => {
        const other = createPersistence(name)
        const saved = (await other.load()).submissions[subId] as unknown as Record<string, unknown> | undefined
        other.close()
        return saved
      }
      return { subId, newer, loadSaved }
    }
    const kept = (rec: unknown) => {
      const r = rec as Record<string, unknown>
      // 応募計画そのものの知らない項目は残り、記録の中の知らない項目は消える
      expect(r.futureTop).toBe('新しい版の項目')
      expect((r.snapshot as Record<string, unknown>).futureField).toBeUndefined()
      expect(r.snapshot).toMatchObject({ at: 1, charCount: 0 })
    }

    // 削除してゴミ箱から戻す（ゴミ箱の写しは表示用の内容から作る）
    const a = await seedNewer()
    actions.deleteSubmission(a.subId)
    expect(await flushNow()).toBe(true)
    expect(await a.loadSaved()).toBeUndefined()
    const entryId = Object.keys(useApp.getState().data.trashEntries)[0]
    actions.restoreTrashEntry(entryId)
    expect(await flushNow()).toBe(true)
    kept(await a.loadSaved())
    resetStoreForTests()

    // バックアップの書き出し（表示用の内容を書き出す）
    const b = await seedNewer()
    kept(toBackup(useApp.getState().data).data.submissions[b.subId])
    // バックアップからの復元（修復した内容で端末内を置き換える。同期中ならクラウドも）
    await replaceAllData(b.newer)
    kept(await b.loadSaved())
  })

  it('別タブで削除されたレコードは、このタブの古い内容で復活させない', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('作品')
    const memoId = actions.addMemo(titleId, 'メモ')
    await flushNow()
    const other = createPersistence(name)
    const disk = await other.load()
    const { [memoId]: _gone, ...memos } = disk.memos
    void _gone
    await other.save(disk, { ...disk, memos })
    actions.updateMemo(memoId, { body: '古いタブでの編集' })
    await flushNow()
    expect((await other.load()).memos[memoId]).toBeUndefined()
    expect(useApp.getState().data.memos[memoId]).toBeUndefined()
    other.close()
  })

  it('控えは、このタブで新しく作ったもの以外の「保存先に無いレコード」を復活させない', async () => {
    const name = `test-db-${++n}`
    await initStore(createPersistence(name))
    const titleId = actions.createTitle('作品')
    const memoId = actions.addMemo(titleId, 'メモ')
    await flushNow()
    actions.updateMemo(memoId, { body: '閉じる直前の編集' })
    const newMemo = actions.addMemo(titleId, '閉じる直前に作ったメモ')
    writeRecoveryJournal()
    resetStoreForTests()
    // 別タブがメモを消して保存した
    const other = createPersistence(name)
    const disk = await other.load()
    const { [memoId]: _gone, ...memos } = disk.memos
    void _gone
    await other.save(disk, { ...disk, memos })
    other.close()

    await initStore(createPersistence(name))
    const data = useApp.getState().data
    expect(data.memos[memoId]).toBeUndefined()
    expect(data.memos[newMemo]?.name).toBe('閉じる直前に作ったメモ')
  })

  it('保存に失敗したら false を返し、未保存のまま読み込み直さない', async () => {
    const failing = fakePersistence({
      save: async () => {
        throw new Error('QuotaExceededError')
      },
    })
    await initStore(failing)
    const titleId = actions.createTitle('保存できない')
    expect(await flushNow()).toBe(false)
    expect(useApp.getState().saveStatus).toBe('error')
    expect(await reloadFromDisk()).toBe(false)
    expect(useApp.getState().data.titles[titleId]).toBeDefined()
  })
})
