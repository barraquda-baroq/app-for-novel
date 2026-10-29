// 端末内の保存と送信待ち: 同期の規則（どちらの文章も黙って消さない）が、ほかの画面の保存・クラウドからの反映の
// どちらでも守られること。
import { describe, expect, it, vi } from 'vitest'
import { joinActWithNext, separatePiece } from '../domain/acts'
import { addMemo, addSubmission, createTitle, recordSubmissionSnapshot } from '../domain/entityOps'
import { addEpisode, addVersion, deleteVersion, setActiveVersion, updatePiece, updateVersion } from '../domain/storyOps'
import { TABLE_NAMES, emptyData, type AppData, type Version } from '../domain/types'
import { newId } from '../domain/util'
import { conflictTrash, conflictVersionCopy, createConflictHooks } from '../sync/conflicts'
import { groupOutbox } from '../sync/acts'
import { deepEqual } from '../sync/merge'
import {
  createPersistence,
  tableSendRank,
  type AnyRecord,
  type Change,
  type ConflictHooks,
  type ConflictNote,
  type Persistence,
} from './persistence'

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

  it('同期したことのある端末の復元・すべて削除は、クラウドに当てるまで反映しない。当てる送信待ちは「必ず上書き」になる', async () => {
    const { data, memoId } = sample()
    const p = fresh()
    await p.setMeta('uid', 'someone')
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
    // その後、別のアカウントで初めて同期する時は、突き合わせるだけにする（クラウドを消さない）
    await p.markAllDirty()
    expect(await p.getMeta('authoritative')).toBeFalsy()
    expect((await p.readOutbox(1000)).some((i) => i.force)).toBe(false)
  })

  it('まだ同期したことの無い端末で復元しても、初めてのログインでほかの端末の内容を消さない', async () => {
    const { data } = sample()
    const p = fresh()
    await p.replaceAll(data)
    expect(await p.getMeta('authoritative')).toBeFalsy()
    expect((await p.readOutbox(1000)).some((i) => i.force)).toBe(false)
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

describe('第2回の見直しで直したこと', () => {
  it('この端末が書いた版（返事を受け取れなかった書き込み）が届いても、端末内の新しい内容と競合させない', async () => {
    const { data, pieceId, versionId } = sample()
    const p = fresh()
    await seed(p, data)
    const l1 = updateVersion(data, versionId, { body: '一回目' })
    await p.save(
      data,
      l1,
      hooks(() => data),
    )
    const l2 = updateVersion(l1, versionId, { body: '一回目、二回目' })
    await p.save(
      l1,
      l2,
      hooks(() => l1),
    )
    // 一回目を送った返事を受け取れず、その書き込みが届いた
    const h = hooks(() => l2)
    await p.applyRemote([{ table: 'versions', id: versionId, record: l1.versions[versionId], own: true }], h)
    const disk = await p.load()
    expect(disk.versions[versionId].body).toBe('一回目、二回目')
    expect(disk.pieces[pieceId].versionIds).toHaveLength(1)
    expect(h.notes).toEqual([])
    const row = (await p.readOutbox(100)).find((i) => i.id === versionId)
    expect((row?.base as { body?: string }).body).toBe('一回目')
  })

  it('ほかの端末の復元・すべて削除はその内容を正とし、この端末で送っていない文章だけ控える。子は控えずに片付ける', async () => {
    const { data, titleId, pieceId, memoId, versionId } = sample()
    const p = fresh()
    await seed(p, data)
    const edited = { ...data, memos: { ...data.memos, [memoId]: { ...data.memos[memoId], body: '送っていない追記' } } }
    await p.save(
      data,
      edited,
      hooks(() => data),
    )
    const h = hooks(() => edited)
    // 復元は、クラウドにあったものをすべて（子から先に）消す
    await p.applyRemote(
      [
        { table: 'versions', id: versionId, record: null, reset: true },
        { table: 'memos', id: memoId, record: null, reset: true },
        { table: 'pieces', id: pieceId, record: null, reset: true },
        { table: 'titles', id: titleId, record: null, reset: true },
      ],
      h,
    )
    const disk = await p.load()
    expect(disk.memos[memoId]).toBeUndefined()
    expect(disk.versions[versionId]).toBeUndefined()
    const kept = Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)
    expect(kept).toEqual(['送っていない追記'])
  })

  it('ほかの端末の復元で親が消えた時、この端末だけの子（送っていない稿）はゴミ箱に控える', async () => {
    const { data, titleId, pieceId, memoId, versionId } = sample()
    const p = fresh()
    await seed(p, data)
    const added = addVersion(data, pieceId, { body: '送っていない稿' })
    await p.save(
      data,
      added.data,
      hooks(() => data),
    )
    const h = hooks(() => added.data)
    await p.applyRemote(
      [
        { table: 'versions', id: versionId, record: null, reset: true },
        { table: 'memos', id: memoId, record: null, reset: true },
        { table: 'pieces', id: pieceId, record: null, reset: true },
        { table: 'titles', id: titleId, record: null, reset: true },
      ],
      h,
    )
    const disk = await p.load()
    expect(disk.versions[added.result]).toBeUndefined()
    const kept = Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)
    expect(kept).toEqual(['送っていない稿'])
    expect(h.notes).toEqual(['trash'])
  })

  it('同じまとまりで応募計画と一緒に消された本文の控えは消す（使っている計画が無くなるので）', async () => {
    const { data, titleId } = sample()
    const s = addSubmission(data, titleId, '文学賞')
    const d = recordSubmissionSnapshot(s.data, s.result)
    const key = Object.keys(d.snapshotTexts)[0]
    const p = fresh()
    await seed(p, d)
    await p.applyRemote(
      [
        { table: 'snapshotTexts', id: key, record: null },
        { table: 'submissions', id: s.result, record: null },
      ],
      hooks(() => d),
    )
    expect((await p.load()).snapshotTexts[key]).toBeUndefined()
    expect(await p.outboxCount()).toBe(0)
  })

  it('ゴミ箱の中身・子を先に、親を後に送る', async () => {
    const { data } = sample()
    const p = fresh()
    await p.replaceAll(data)
    const order = (await p.readOutbox(1000)).map((i) => i.table)
    expect(order.indexOf('versions')).toBeLessThan(order.indexOf('pieces'))
    expect(order.indexOf('pieces')).toBeLessThan(order.indexOf('titles'))
    expect(order[order.length - 1]).toBe('titles')
  })

  it('別の端末で消されたタイトルの下に、古い表示のまま作ったメモは、ゴミ箱に控えて片付ける', async () => {
    const { data, titleId } = sample()
    const p = fresh()
    await seed(p, data)
    await p.applyRemote(
      [{ table: 'titles', id: titleId, record: null }],
      hooks(() => data),
    )
    const m = addMemo(data, titleId, '古い画面で作ったメモ')
    const withBody = { ...m.data, memos: { ...m.data.memos, [m.result]: { ...m.data.memos[m.result], body: '大事' } } }
    await p.save(
      data,
      withBody,
      hooks(() => data),
    )
    const disk = await p.load()
    expect(disk.memos[m.result]).toBeUndefined()
    expect(Object.values(disk.trashRecords).map((r) => (r.record as { body?: string }).body)).toContain('大事')
  })
})

// ---------- 幕（2.2） ----------

/** 第1話（'ABCDEFGHI'）を3幕に分けた作品 */
function actsSample() {
  const t = createTitle(emptyData(), '作品')
  const e = addEpisode(t.data, t.result)
  const vid = e.data.pieces[e.result].versionIds[0]
  const d0 = setActiveVersion(updateVersion(e.data, vid, { body: 'ABCDEFGHI' }), e.result, vid)
  const s = separatePiece(d0, e.result, [3, 6])
  const m = addMemo(s.data, t.result, 'メモ')
  return { data: m.data, ep: e.result, acts: s.result, memoId: m.result }
}

/** 送信待ちの約束: 送信待ちに無いレコードは端末内 = クラウド、あれば base = クラウド */
async function outboxProblems(p: Persistence, cloud: AppData): Promise<string[]> {
  const disk = await p.load()
  const rows = new Map((await p.readOutbox(10_000)).map((r) => [r.k, r]))
  const out: string[] = []
  for (const t of Object.keys(disk) as (keyof AppData)[]) {
    const ids = new Set([...Object.keys(disk[t]), ...Object.keys(cloud[t])])
    for (const id of ids) {
      const c = (cloud[t] as Record<string, AnyRecord>)[id] ?? null
      const row = rows.get(`${t}/${id}`)
      if (row && !deepEqual(row.base, c)) out.push(`${t}/${id}: base がクラウドと違う`)
      if (!row && !deepEqual((disk[t] as Record<string, AnyRecord>)[id] ?? null, c))
        out.push(`${t}/${id}: 端末内がクラウドと違う`)
    }
  }
  return out
}

const apply = (cloud: AppData, changes: Change[]): AppData => {
  const out = { ...cloud } as unknown as Record<string, Record<string, AnyRecord>>
  for (const c of changes) {
    out[c.table] = { ...out[c.table] }
    if (c.record) out[c.table][c.id] = c.record
    else delete out[c.table][c.id]
  }
  return out as unknown as AppData
}

function actsHooks(data: AppData, notes: ConflictNote[]) {
  return createConflictHooks({ device: 'テスト端末', data: () => data, newId, now: () => 1, report: (n) => notes.push(n) })
}

describe('幕（2.2）の送信待ちと反映', () => {
  it('幕の構成を変えた話は、話・幕・稿・ゴミ箱の件を続けて1つのまとまりとして並べる（上限を超えてもまとまりは切らない）', async () => {
    const { data, ep, acts, memoId } = actsSample()
    const p = fresh()
    await seed(p, data)
    const withLeftover = addVersion(data, acts[1], { body: 'DEF別稿' }).data
    await p.save(data, withLeftover)
    await p.completeUpload((await p.readOutbox(100)).map((i) => ({ table: i.table, id: i.id, record: i.local })))
    const joined = joinActWithNext(withLeftover, acts[0]).data
    const next = { ...joined, memos: { ...joined.memos, [memoId]: { ...joined.memos[memoId], body: '別の変更' } } }
    await p.save(withLeftover, next)
    const items = await p.readOutbox(1)
    const group = items.filter((i) => i.group === `pieces/${ep}`)
    expect(items.length).toBeGreaterThan(1)
    expect(group.map((i) => i.table)).toEqual(expect.arrayContaining(['pieces', 'versions', 'trashEntries', 'trashRecords']))
    expect(group.map((i) => i.id)).toEqual(expect.arrayContaining([ep, acts[0], acts[1]]))
    // まとまりは続けて並び、まとまりでない変更（メモ）はまとまりに入らない
    const all = await p.readOutbox(100)
    const idx = all.map((i, n) => (i.group ? n : -1)).filter((n) => n >= 0)
    expect(idx[idx.length - 1] - idx[0] + 1).toBe(idx.length)
    expect(all.find((i) => i.id === memoId)?.group).toBeUndefined()
    // 幕の構成を変えていなければ、まとまりは無い
    const q = fresh()
    await seed(q, data)
    await q.save(data, updatePiece(data, ep, { subtitle: '題' }))
    expect((await q.readOutbox(100)).every((i) => !i.group)).toBe(true)
  })

  it('送信待ちは1回の読み取りで読む（読んでいる途中に幕の操作が保存されても、操作の前と後が混ざらない）', async () => {
    const { data, ep, acts } = actsSample()
    for (let round = 0; round < 5; round++) {
      // まだ送っていない分けた話（話・幕・稿がすべて送信待ち）で、読み出しと同時に第1幕と第2幕をつなぐ
      const p = fresh()
      await p.save(emptyData(), data)
      const joined = joinActWithNext(data, acts[0])
      const [items] = await Promise.all([p.readOutbox(100), p.save(data, joined.data)])
      const local = new Map(items.map((i) => [`${i.table}/${i.id}`, i.local]))
      const episode = local.get(`pieces/${ep}`) as { actIds?: string[] } | null
      // 話の幕の並びに載る幕と、その採用稿が、読んだ中にそろっている
      for (const id of episode?.actIds ?? []) {
        const act = local.get(`pieces/${id}`) as { activeVersionId?: string } | null | undefined
        expect(act, `幕 ${id}`).toBeTruthy()
        expect(local.get(`versions/${act!.activeVersionId}`), `幕 ${id} の採用稿`).toBeTruthy()
      }
      // つないだ後の話なら、つないだ稿も読んでいる
      if (episode?.actIds?.length === 2) expect(local.get(`versions/${joined.result}`)).toBeTruthy()
      p.close()
    }
  })

  it('クラウドから直接読んだ話が知らない幕を指していれば、その話は合わせずに購読で届くのを待つ', async () => {
    const { data, ep, acts } = actsSample()
    const p = fresh()
    await seed(p, data)
    const mine = joinActWithNext(data, acts[0]).data
    await p.save(data, mine)
    const cloudEp = { ...data.pieces[ep], actIds: [acts[0], 'unknown-act', acts[1], acts[2]], updatedAt: 99 }
    const notes: ConflictNote[] = []
    await p.applyRemote([{ table: 'pieces', id: ep, record: cloudEp as AnyRecord }], { ...actsHooks(mine, notes), direct: true })
    const disk = await p.load()
    expect(disk.pieces[ep].actIds).toEqual(mine.pieces[ep].actIds)
    expect((await p.readOutbox(100)).find((i) => i.id === ep)?.base).toEqual(data.pieces[ep])
    expect(notes).toEqual([])
  })

  it('この端末でつないで消した幕に、別の端末で足した稿が届いたら、残る幕の稿として残して消す（送信待ちの約束を守る）', async () => {
    const { data, ep, acts } = actsSample()
    const p = fresh()
    await seed(p, data)
    const mine = joinActWithNext(data, acts[0]).data
    await p.save(data, mine)
    const added: Version = {
      ...data.versions[data.pieces[acts[1]].activeVersionId!],
      id: newId(),
      name: '第2稿',
      body: 'Yの第2稿',
    }
    const change: Change = { table: 'versions', id: added.id, record: added as unknown as AnyRecord }
    const notes: ConflictNote[] = []
    await p.applyRemote([change], actsHooks(mine, notes))
    const disk = await p.load()
    expect(disk.versions[added.id]).toBeUndefined()
    const copy = Object.values(disk.versions).find((v) => v.body === 'Yの第2稿')!
    expect(copy.pieceId).toBe(acts[0])
    expect(copy.name).toBe('第2幕の第2稿（競合: 別の端末での編集）')
    expect(disk.pieces[acts[0]].versionIds).toContain(copy.id)
    expect(notes).toEqual([{ kind: 'acts', table: 'pieces', id: ep, detail: 'theirsDropped', kept: { versions: 1, trash: 0 } }])
    expect(await outboxProblems(p, apply(data, [change]))).toEqual([])
  })
})

// ---------- 読む量（大きな作品で、反映・送信待ちの読み出しが話の数の2乗にならない） ----------

/** fn の間に IndexedDB を表ごとに読んだ回数（scan = 表を全件読んだ、get = 1件ずつ読んだ） */
async function countReads(fn: () => Promise<unknown>): Promise<Record<string, { scan: number; get: number }>> {
  const counts: Record<string, { scan: number; get: number }> = {}
  const proto = IDBObjectStore.prototype as unknown as Record<'openCursor' | 'getAll' | 'get', (...a: unknown[]) => unknown>
  const spies = (['openCursor', 'getAll', 'get'] as const).map((m) => {
    const orig = proto[m]
    return vi.spyOn(proto, m).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
      const c = (counts[this.name] ??= { scan: 0, get: 0 })
      if (m === 'get') c.get += 1
      else if (args[0] == null) c.scan += 1
      return orig.apply(this, args)
    })
  })
  try {
    await fn()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return counts
}

/** n 話（どれも稿が2つ。split 話ごとに1話を幕に分ける）の作品 */
function largeTitle(n: number, split: number): { data: AppData; titleId: string; episodes: string[] } {
  const t = createTitle(emptyData(), '長編')
  let data = t.data
  const episodes: string[] = []
  for (let i = 0; i < n; i++) {
    const e = addEpisode(data, t.result)
    episodes.push(e.result)
    const v0 = e.data.pieces[e.result].versionIds[0]
    data = updateVersion(e.data, v0, { body: `第${i}話ABCDEF` })
    data = setActiveVersion(addVersion(data, e.result, { body: `第${i}話の別稿` }).data, e.result, v0)
    if (i % split === 0) data = separatePiece(data, e.result, [3]).data
  }
  return { data, titleId: t.result, episodes }
}

const allChanges = (d: AppData, extra: Partial<Change> = {}): Change[] =>
  TABLE_NAMES.flatMap((t) =>
    Object.values(d[t] as Record<string, AnyRecord>).map((r) => ({ table: t, id: r.id, record: r, ...extra })),
  )

describe('大きな作品の反映・送信待ちの読む量', () => {
  it('ほかの端末の復元をまとめて受け取っても、話・稿の表を話ごとに読み直さない', async () => {
    const { data } = largeTitle(30, 3)
    const p = fresh()
    await seed(p, data)
    const restored: AppData = { ...data, pieces: { ...data.pieces }, versions: { ...data.versions } }
    for (const t of ['pieces', 'versions'] as const)
      for (const [id, r] of Object.entries(restored[t])) (restored[t] as Record<string, AnyRecord>)[id] = { ...r, updatedAt: 99 }
    const counts = await countReads(() =>
      p.applyRemote(
        allChanges(restored, { reset: true }),
        hooks(() => data),
      ),
    )
    expect(counts.pieces?.scan ?? 0).toBeLessThanOrEqual(1)
    expect(counts.versions?.scan ?? 0).toBeLessThanOrEqual(1)
    expect(await p.load()).toEqual(restored)
  })

  it('初めてのログインで幕に分けた話があっても、送信待ちを読むたびにすべての稿を読まない（まとまりと並びは同じ）', async () => {
    const { data: base, episodes } = largeTitle(60, 60)
    // 分けた話（第1話）: 第2幕に稿を足してから第1幕とつなぐ（足した稿はゴミ箱へ）。ほかの話の稿も1つゴミ箱へ
    const ep = episodes[0]
    let data = addVersion(base, base.pieces[ep].actIds![1], { body: '第2幕の別稿' }).data
    data = joinActWithNext(data, data.pieces[ep].actIds![0]).data
    data = deleteVersion(data, data.pieces[episodes[5]].versionIds[1])
    const p = fresh()
    await p.save(emptyData(), data)
    await p.markAllDirty()
    // いままでの読み方（すべての送信待ちからまとまりを作る）で期待する並び
    const keyOf = (t: string, id: string) => `${t}/${id}`
    const entries = TABLE_NAMES.flatMap((t) =>
      Object.values(data[t] as Record<string, AnyRecord>).map((r) => ({
        k: keyOf(t, r.id),
        table: t,
        id: r.id,
        base: null,
        local: r,
        noHistory: true,
        force: false,
      })),
    )
    const groups = groupOutbox(entries)
    const keys = entries
      .map((e) => e.k)
      .sort(
        (a, b) =>
          tableSendRank(a.slice(0, a.indexOf('/'))) - tableSendRank(b.slice(0, b.indexOf('/'))) || (a < b ? -1 : a > b ? 1 : 0),
      )
    const limit = 10
    const want: string[] = []
    for (const k of keys) {
      if (want.length >= limit) break
      if (want.includes(k)) continue
      const g = groups.get(k)
      want.push(...(g ? keys.filter((x) => groups.get(x) === g) : [k]))
    }
    const group = [...groups.entries()].filter(([, g]) => g === `pieces/${ep}`).map(([k]) => k)
    expect(group.some((k) => k.startsWith('trashEntries/'))).toBe(true)
    let got: Awaited<ReturnType<Persistence['readOutbox']>> = []
    const counts = await countReads(async () => {
      got = await p.readOutbox(limit)
    })
    expect(got.map((it) => it.k)).toEqual(want)
    expect(got.map((it) => it.group ?? null)).toEqual(want.map((k) => groups.get(k) ?? null))
    // 読んだ稿は、まとまりの稿と、送る分（上限まで）だけ
    const groupVersions = group.filter((k) => k.startsWith('versions/')).length
    expect(counts.versions?.get ?? 0).toBeLessThanOrEqual(groupVersions + limit)
  })

  it('新しい端末が全件を1回で受け取っても、届いた稿を幕に分けた話ごとに読み直さない', async () => {
    const { data } = largeTitle(30, 3)
    const p = fresh()
    const counts = await countReads(() =>
      p.applyRemote(
        allChanges(data),
        hooks(() => emptyData()),
      ),
    )
    const versions = Object.keys(data.versions).length
    expect(counts.versions?.get ?? 0).toBeLessThanOrEqual(3 * versions)
    expect(await p.load()).toEqual(data)
  })
})
