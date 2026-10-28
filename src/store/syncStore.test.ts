// ストアの同期まわり: 修復は表示用の内容にだけ当てる・クラウドの変更の反映・送信待ち
import { afterEach, describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from '../db/persistence'
import { createTitle, addMemo } from '../domain/entityOps'
import { addEpisode, updateVersion } from '../domain/storyOps'
import { emptyData, type AppData, type Piece, type Version } from '../domain/types'
import { actions } from './actions'
import { applyRemoteChanges, flushNow, getData, initStore, rebaseView, resetStoreForTests, useApp } from './appStore'

let n = 0
const dbName = () => `sync-store-${++n}`

afterEach(() => resetStoreForTests())

/** 端末内にデータを置き、クラウドと揃っている状態にする（復元・すべて削除の扱いにはしない） */
async function seedSynced(p: Persistence, data: AppData, { synced = true } = {}): Promise<void> {
  await p.replaceAll(data)
  if (synced) await p.completeUpload((await p.readOutbox(1000)).map((i) => ({ table: i.table, id: i.id, record: i.local })))
  await p.setMeta('authoritative', null)
}

function sample(): { data: AppData; titleId: string; pieceId: string; versionId: string } {
  const t = createTitle(emptyData(), '作品')
  const e = addEpisode(t.data, t.result)
  const versionId = e.data.pieces[e.result].versionIds[0]
  return { data: updateVersion(e.data, versionId, { body: '本文' }), titleId: t.result, pieceId: e.result, versionId }
}

describe('修復は表示用の内容にだけ当てる', () => {
  it('話より先に届いた稿は、表示では隠すが端末内には残し、話が届けば表示される', async () => {
    const { data, pieceId, versionId } = sample()
    const name = dbName()
    const p = createPersistence(name)
    // 稿だけ先に届いた状態（話はまだ無い）
    const { [pieceId]: piece, ...pieces } = data.pieces
    await seedSynced(p, { ...data, pieces }, { synced: false })
    await initStore(p)
    expect(getData().versions[versionId]).toBeUndefined()
    await flushNow()
    // 端末内からは消していない
    const other = createPersistence(name)
    expect((await other.load()).versions[versionId]).toBeDefined()
    // 話が届いた
    await applyRemoteChanges([{ table: 'pieces', id: pieceId, record: piece }])
    expect(getData().versions[versionId]?.body).toBe('本文')
    expect(getData().pieces[pieceId].activeVersionId).toBe(versionId)
    other.close()
  })

  it('利用者が触ったレコードだけを書き、触っていない項目の参照切れは端末内でそのまま', async () => {
    const { data, titleId, pieceId } = sample()
    const name = dbName()
    const p = createPersistence(name)
    // まだ届いていない話を指す構成
    const title = {
      ...data.titles[titleId],
      structure: [...data.titles[titleId].structure, { type: 'piece' as const, id: 'later' }],
    }
    await seedSynced(p, { ...data, titles: { ...data.titles, [titleId]: title } }, { synced: false })
    await initStore(p)
    expect(getData().titles[titleId].structure.map((s) => s.id)).toEqual([pieceId])
    actions.updateTitle(titleId, { synopsis: 'あらすじ' })
    await flushNow()
    const disk = await createPersistence(name).load()
    expect(disk.titles[titleId].synopsis).toBe('あらすじ')
    expect(disk.titles[titleId].structure.map((s) => s.id)).toEqual([pieceId, 'later'])
  })
})

describe('クラウドの変更の反映', () => {
  it('未保存の編集があっても、項目ごとに合わせて両方を残す', async () => {
    const { data, titleId } = sample()
    const p = createPersistence(dbName())
    await seedSynced(p, data)
    await initStore(p)
    actions.updateTitle(titleId, { synopsis: 'この端末のあらすじ' })
    const remote = { ...data.titles[titleId], name: '別の端末の名前', updatedAt: Date.now() + 10 }
    await applyRemoteChanges([{ table: 'titles', id: titleId, record: remote }])
    expect(getData().titles[titleId].name).toBe('別の端末の名前')
    expect(getData().titles[titleId].synopsis).toBe('この端末のあらすじ')
    await flushNow()
    const disk = await p.load()
    expect(disk.titles[titleId].name).toBe('別の端末の名前')
    expect(disk.titles[titleId].synopsis).toBe('この端末のあらすじ')
  })

  it('保存したレコードは送信待ちに積まれ、送り終われば外れる', async () => {
    const p = createPersistence(dbName())
    await initStore(p)
    const titleId = actions.createTitle('作品')
    await flushNow()
    const items = await p.readOutbox(100)
    const title = items.find((i) => i.table === 'titles' && i.id === titleId)
    expect(title?.base).toBeNull()
    expect(title?.local).toEqual(getData().titles[titleId])
    await p.completeUpload(items.map((i) => ({ table: i.table, id: i.id, record: i.local })))
    expect(await p.outboxCount()).toBe(0)
    // 送った後に変えたものは、送った内容を base にして残る
    actions.updateTitle(titleId, { name: '改題' })
    await flushNow()
    const again = await p.readOutbox(100)
    expect(again).toHaveLength(1)
    expect((again[0].base as unknown as { name: string }).name).toBe('作品')
    expect(useApp.getState().saveStatus).toBe('saved')
  })

  it('別の端末で消されたメモをこの端末で編集していたら、削除しつつゴミ箱に控える', async () => {
    const t = createTitle(emptyData(), '作品')
    const m = addMemo(t.data, t.result, 'メモ')
    const p = createPersistence(dbName())
    await seedSynced(p, m.data)
    await initStore(p)
    actions.updateMemo(m.result, { body: '書き足した' })
    await flushNow()
    await applyRemoteChanges([{ table: 'memos', id: m.result, record: null }])
    const d = getData()
    expect(d.memos[m.result]).toBeUndefined()
    const entry = Object.values(d.trashEntries)[0]
    expect(entry.reason).toBe('conflict')
    expect((d.trashRecords[entry.recordIds[0]].record as { body: string }).body).toBe('書き足した')
  })
})

describe('rebaseView', () => {
  it('その後このタブでも本文を変えていたら、届いた本文を採り、このタブの本文を別の稿にする', () => {
    const { data, pieceId, versionId } = sample()
    const latest = updateVersion(data, versionId, { body: 'このタブの本文' })
    const remoteV: Version = { ...data.versions[versionId], body: '届いた本文', updatedAt: Date.now() + 5 }
    const newBase = { ...data, versions: { ...data.versions, [versionId]: remoteV } }
    const out = rebaseView(latest, data, newBase)
    expect(out.versions[versionId].body).toBe('届いた本文')
    const piece: Piece = out.pieces[pieceId]
    expect(piece.versionIds).toHaveLength(2)
    expect(out.versions[piece.versionIds[1]].body).toBe('このタブの本文')
  })
})
