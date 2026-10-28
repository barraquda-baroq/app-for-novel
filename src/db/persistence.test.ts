// 端末内の保存と送信待ち: 同期の規則（どちらの文章も黙って消さない）が、ほかの画面の保存・クラウドからの反映の
// どちらでも守られること。
import { describe, expect, it } from 'vitest'
import { addMemo, addSubmission, createTitle, recordSubmissionSnapshot } from '../domain/entityOps'
import { addEpisode, updateVersion } from '../domain/storyOps'
import { emptyData, type AppData, type Version } from '../domain/types'
import { newId } from '../domain/util'
import { conflictTrash, conflictVersionCopy } from '../sync/conflicts'
import { createPersistence, type AnyRecord, type Change, type ConflictHooks, type Persistence } from './persistence'

let n = 0
const fresh = () => createPersistence(`persistence-test-${++n}`)

function hooks(context: () => AppData): ConflictHooks & { notes: string[] } {
  const notes: string[] = []
  return {
    notes,
    device: 'テスト端末',
    versionCopy: (mine) => conflictVersionCopy(mine as unknown as Version, 'テスト端末', newId(), 1) as unknown as AnyRecord,
    trashCopy: (table, record): Change[] => {
      const r = conflictTrash(context(), table as never, record, { now: 1, newId })
      if (!r) return []
      return [
        { table: 'trashEntries', id: r.entry.id, record: r.entry as unknown as AnyRecord },
        ...r.records.map((x) => ({ table: 'trashRecords' as const, id: x.id, record: x as unknown as AnyRecord })),
      ]
    },
    report: (note) => notes.push(note.kind),
  }
}

/** クラウドと揃っている状態で置く */
async function seed(p: Persistence, data: AppData): Promise<void> {
  await p.replaceAll(data)
  await p.completeUpload((await p.readOutbox(1000)).map((i) => ({ table: i.table, id: i.id, record: i.local })))
  await p.setMeta('authoritative', null)
}

function sample() {
  const t = createTitle(emptyData(), '作品')
  const e = addEpisode(t.data, t.result)
  const versionId = e.data.pieces[e.result].versionIds[0]
  const m = addMemo(updateVersion(e.data, versionId, { body: '元の本文' }), t.result, 'メモ')
  return { data: m.data, titleId: t.result, pieceId: e.result, versionId, memoId: m.result }
}

describe('ほかの画面（同期を受け持つ画面が別の端末の変更を反映した後）の保存', () => {
  it('本文が両方で変わっていたら、保存先の本文を採り、この画面の本文を別の稿として残す', async () => {
    const { data, pieceId, versionId } = sample()
    const p = fresh()
    await seed(p, data)
    // 同期を受け持つ画面が、別の端末の本文を反映した
    const remote = { ...data.versions[versionId], body: '別の端末の本文', updatedAt: 50 }
    await p.applyRemote(
      [{ table: 'versions', id: versionId, record: remote }],
      hooks(() => data),
    )
    // この画面は古い内容のまま本文を書き換えて保存する
    const next = updateVersion(data, versionId, { body: 'この画面の本文' })
    const h = hooks(() => data)
    const outcome = await p.save(data, next, h)
    const disk = await p.load()
    expect(disk.versions[versionId].body).toBe('別の端末の本文')
    const piece = disk.pieces[pieceId]
    expect(piece.versionIds).toHaveLength(2)
    expect(disk.versions[piece.versionIds[1]].body).toBe('この画面の本文')
    expect(h.notes).toEqual(['versionCopy'])
    expect(outcome.extra.length).toBeGreaterThan(0)
  })

  it('別の端末で削除されたメモへのこの画面の編集はゴミ箱に控え、削除前に書き換えられたメモを消す時はその内容を控える', async () => {
    const { data, memoId } = sample()
    const p = fresh()
    await seed(p, data)
    await p.applyRemote(
      [{ table: 'memos', id: memoId, record: null }],
      hooks(() => data),
    )
    const edited = { ...data, memos: { ...data.memos, [memoId]: { ...data.memos[memoId], body: '書き足し' } } }
    const h = hooks(() => data)
    const outcome = await p.save(data, edited, h)
    expect(outcome.dropped.memos).toEqual([memoId])
    let disk = await p.load()
    expect(Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)).toContain('書き足し')

    const { data: d2, memoId: m2 } = sample()
    const p2 = fresh()
    await seed(p2, d2)
    const remoteMemo = { ...d2.memos[m2], body: '別の端末の追記', updatedAt: 9 }
    await p2.applyRemote(
      [{ table: 'memos', id: m2, record: remoteMemo }],
      hooks(() => d2),
    )
    const { [m2]: _gone, ...memos } = d2.memos
    void _gone
    await p2.save(
      d2,
      { ...d2, memos },
      hooks(() => d2),
    )
    disk = await p2.load()
    expect(disk.memos[m2]).toBeUndefined()
    expect(Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)).toContain('別の端末の追記')
  })
})

describe('クラウドからの反映', () => {
  it('使っている応募時の原稿の本文は、別の端末の整理で消されても残して送り直す', async () => {
    const { data, titleId } = sample()
    const s = addSubmission(data, titleId, '文学賞')
    const d = recordSubmissionSnapshot(s.data, s.result)
    const key = Object.keys(d.snapshotTexts)[0]
    const p = fresh()
    await seed(p, d)
    await p.applyRemote(
      [{ table: 'snapshotTexts', id: key, record: null }],
      hooks(() => d),
    )
    expect((await p.load()).snapshotTexts[key]).toBeDefined()
    const row = (await p.readOutbox(100)).find((i) => i.id === key)
    expect(row?.base).toBeNull()
  })

  it('別の端末で話が削除されたら、この端末で書いた稿はゴミ箱に控えてから片付ける（見えないまま残さない）', async () => {
    const { data, pieceId, versionId } = sample()
    const p = fresh()
    await seed(p, data)
    // この端末で稿を書き換えた（まだ送っていない）
    const next = updateVersion(data, versionId, { body: 'オフラインで書いた本文' })
    await p.save(
      data,
      next,
      hooks(() => data),
    )
    await p.applyRemote(
      [{ table: 'pieces', id: pieceId, record: null }],
      hooks(() => next),
    )
    const disk = await p.load()
    expect(disk.pieces[pieceId]).toBeUndefined()
    expect(disk.versions[versionId]).toBeUndefined()
    expect(Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)).toContain('オフラインで書いた本文')
  })

  it('復元・すべて削除をクラウドに当てるまでは反映しない。当てる送信待ちは「必ず上書き」になる', async () => {
    const { data, memoId } = sample()
    const p = fresh()
    await p.replaceAll(data)
    expect(
      await p.applyRemote(
        [{ table: 'memos', id: memoId, record: null }],
        hooks(() => data),
      ),
    ).toBeNull()
    expect((await p.load()).memos[memoId]).toBeDefined()
    expect((await p.readOutbox(1000)).every((i) => i.force)).toBe(true)
    expect(await p.getMeta('authoritative')).toBeTruthy()
  })

  it('初めてのログインでは、すべてを「共通の履歴が無い」送信待ちにする', async () => {
    const { data, memoId } = sample()
    const p = fresh()
    await seed(p, data)
    await p.markAllDirty()
    const rows = await p.readOutbox(1000)
    expect(rows.length).toBe(Object.values(data).reduce((sum, t) => sum + Object.keys(t).length, 0))
    expect(rows.every((r) => r.noHistory && r.base === null)).toBe(true)
    // クラウドに別の内容があれば、クラウド側を採ってこの端末の文章を控える
    const cloud = { ...data.memos[memoId], body: 'クラウドの本文', updatedAt: 3 }
    await p.applyRemote(
      [{ table: 'memos', id: memoId, record: { ...cloud } }],
      hooks(() => data),
    )
    const disk = await p.load()
    expect(disk.memos[memoId].body).toBe('クラウドの本文')
    expect(Object.values(disk.trashEntries)[0]?.reason).toBe('conflict')
    expect((await p.readOutbox(1000)).find((i) => i.id === memoId)).toBeUndefined()
  })
})
