// 同期の競合で作るゴミ箱の控えが、ゴミ箱の「元に戻す」でそのまま戻せること
import { describe, expect, it } from 'vitest'
import { joinActWithNext, separatePiece, unseparatePiece } from '../domain/acts'
import { addMemo, addSubmission, createTitle, recordSubmissionSnapshot } from '../domain/entityOps'
import { addEpisode, setActiveVersion, updateVersion } from '../domain/storyOps'
import { restoreTrashEntry } from '../domain/trash'
import { emptyData, type AppData, type ID, type TrashEntry, type TrashRecord, type Version } from '../domain/types'
import { newId } from '../domain/util'
import { actsConflictTrash, actsVersionCopy, actsVersionName, conflictTrash, conflictVersionCopy } from './conflicts'

function putTrash(data: AppData, r: { entry: TrashEntry; records: TrashRecord[] }): AppData {
  return {
    ...data,
    trashEntries: { ...data.trashEntries, [r.entry.id]: r.entry },
    trashRecords: { ...data.trashRecords, ...Object.fromEntries(r.records.map((x) => [x.id, x])) },
  }
}

describe('同期の競合のゴミ箱の控え', () => {
  it('別の端末で消されたメモの編集は、元に戻すと編集した内容で戻る', () => {
    const t = createTitle(emptyData(), '作品')
    const m = addMemo(t.data, t.result, 'メモ')
    const edited = { ...m.data.memos[m.result], body: 'この端末で書き足した' }
    // 別の端末で削除された（ゴミ箱にも入っていない状態で届いた）
    const { [m.result]: _gone, ...memos } = m.data.memos
    void _gone
    let d: AppData = { ...m.data, memos }
    const r = conflictTrash(d, 'memos', edited, { now: 1, newId })!
    expect(r.entry.reason).toBe('conflict')
    d = putTrash(d, r)
    const restored = restoreTrashEntry(d, r.entry.id).data
    expect(restored.memos[m.result].body).toBe('この端末で書き足した')
  })

  it('同じ id が残っていれば、複製として戻す（元のものを上書きしない）', () => {
    const t = createTitle(emptyData(), '作品')
    const e = addEpisode(t.data, t.result)
    const vid = e.data.pieces[e.result].versionIds[0]
    const d0 = updateVersion(e.data, vid, { body: '今の本文' })
    const conflicted = { ...d0.versions[vid], body: '競合した本文' }
    const r = conflictTrash(d0, 'versions', conflicted, { now: 1, newId })!
    expect(r.entry.parentLabel).toBe('第1話')
    const restored = restoreTrashEntry(putTrash(d0, r), r.entry.id).data
    expect(restored.versions[vid].body).toBe('今の本文')
    const piece = restored.pieces[e.result]
    expect(piece.versionIds).toHaveLength(2)
    expect(restored.versions[piece.versionIds[1]].body).toBe('競合した本文')
  })

  it('応募計画は応募時の原稿の本文も一緒に控える', () => {
    const t = createTitle(emptyData(), '作品')
    const e = addEpisode(t.data, t.result)
    const d1 = updateVersion(e.data, e.data.pieces[e.result].versionIds[0], { body: '応募した本文' })
    const s = addSubmission(d1, t.result, '星降る文学賞')
    const d2 = recordSubmissionSnapshot(s.data, s.result)
    const r = conflictTrash(d2, 'submissions', d2.submissions[s.result], { now: 1, newId })!
    expect(r.records.map((x) => x.table)).toEqual(['submissions', 'snapshotTexts'])
    // 削除されて本文の控えも整理された後でも戻せる
    const gone = withoutSubmission(d2, s.result)
    const restored = restoreTrashEntry(putTrash(gone, r), r.entry.id).data
    const snap = restored.submissions[s.result].snapshot!
    const key = Object.values(snap.pieces!)[0].textKey!
    expect(restored.snapshotTexts[key].body).toBe('応募した本文')
  })
})

/** 第1話（'ABCDEFGHI'）を3幕に分けた作品 */
function splitSample() {
  const t = createTitle(emptyData(), '作品')
  const e = addEpisode(t.data, t.result)
  const vid = e.data.pieces[e.result].versionIds[0]
  const d0 = setActiveVersion(updateVersion(e.data, vid, { body: 'ABCDEFGHI' }), e.result, vid)
  const s = separatePiece(d0, e.result, [3, 6])
  return { data: s.data, ep: e.result, acts: s.result }
}

const without = (d: AppData, pieceId: ID): AppData => {
  const { [pieceId]: _gone, ...pieces } = d.pieces
  void _gone
  return { ...d, pieces }
}

describe('幕（2.2）の稿の同期の競合の控え', () => {
  it('幕の稿は、幕の属する話も控える（幕がまだあれば幕の表記、無くなっていれば話の表記）', () => {
    const { data, ep, acts } = splitSample()
    const v = { ...data.versions[data.pieces[acts[1]].activeVersionId!], body: '書き換えた' }
    const r = conflictTrash(data, 'versions', v, { now: 1, newId })!
    expect(r.entry.origin.parentId).toBe(ep)
    expect(r.entry.parentLabel).toBe('第1話　第2幕')
    // 幕がもう無い（別の端末でつながれた）: 消える前の幕を渡す
    const gone = without(data, acts[1])
    const r2 = conflictTrash(gone, 'versions', v, { now: 1, newId, piece: data.pieces[acts[1]] })!
    expect(r2.entry.origin.parentId).toBe(ep)
    expect(r2.entry.origin.index).toBe(-1)
    expect(r2.entry.parentLabel).toBe('第1話の幕')
  })

  it('幕がつないだ・解除したことで無くなっていても、話（分けていれば最初の幕）へ戻せる', () => {
    const { data, ep, acts } = splitSample()
    const v = { ...data.versions[data.pieces[acts[2]].activeVersionId!], body: '第3幕の書き換え' }
    const r = conflictTrash(data, 'versions', v, { now: 1, newId })!
    // 後で第2幕と第3幕をつないだ（第3幕が無くなる）
    const joined = putTrash(joinActWithNext(data, acts[1]).data, r)
    const back = restoreTrashEntry(joined, r.entry.id).data
    const first = back.pieces[acts[0]]
    expect(first.versionIds.map((id) => back.versions[id].body)).toContain('第3幕の書き換え')
    expect(back.versions[first.activeVersionId!].body).toBe('ABC')
    // 後でセパレートを解除した（幕がすべて無くなる）: 話の稿として戻る（採用しない）
    const unsplit = putTrash(unseparatePiece(data, ep).data, r)
    const back2 = restoreTrashEntry(unsplit, r.entry.id).data
    const episode = back2.pieces[ep]
    expect(episode.versionIds.map((id) => back2.versions[id].body)).toContain('第3幕の書き換え')
    expect(back2.versions[episode.activeVersionId!].body).toBe('ABCDEFGHI')
  })

  it('幕の構成の競合で残した稿の件は、稿の幕（残っていれば）か残し先の稿として、採用せずに戻る', () => {
    const { data, ep, acts } = splitSample()
    const own = { ...data.versions[data.pieces[acts[1]].activeVersionId!], id: newId(), body: 'DEF別稿' }
    const lost: Version = { ...own, id: newId(), pieceId: 'gone-act', body: 'XYZ' }
    const r = actsConflictTrash(
      data,
      [
        { record: own, actNumber: 2 },
        { record: lost, actNumber: 4 },
      ],
      { episodeId: ep, episode: data.pieces[ep], target: data.pieces[acts[0]], deleted: false },
      { now: 1, newId },
    )
    expect(r.entry.label).toBe('幕の分け方の競合で残した稿（2稿）')
    expect(r.entry.origin).toMatchObject({ pieceId: acts[0], parentId: ep, wasActive: false })
    expect(r.records.map((x) => (x.record as Version).name)).toEqual(['第2幕の第1稿', '第4幕の第1稿'])
    const back = restoreTrashEntry(putTrash(data, r), r.entry.id).data
    expect(back.pieces[acts[1]].versionIds).toContain(own.id)
    expect(back.pieces[acts[0]].versionIds).toContain(lost.id)
    expect(back.versions[back.pieces[acts[1]].activeVersionId!].body).toBe('DEF')
    expect(back.versions[back.pieces[acts[0]].activeVersionId!].body).toBe('ABC')
    // 削除された話の幕の稿
    const d = actsConflictTrash(
      data,
      [{ record: own, actNumber: null }],
      { episodeId: ep, episode: null, target: null, deleted: true },
      { now: 1, newId },
    )
    expect(d.entry.label).toBe('削除された話の幕の稿（1稿）')
    expect(d.entry.origin).toMatchObject({ pieceId: ep, parentId: ep })
  })

  it('控えの稿の名前と、分けた・つないだ時の本文の指紋を引き継がないこと', () => {
    expect(actsVersionName('第1稿', { device: 'iPhone', mine: true, reason: 'edit', actNumber: 2 })).toBe(
      '第2幕の第1稿（競合: iPhoneでの編集）',
    )
    expect(actsVersionName(' ', { device: 'iPhone', mine: false, reason: 'acts', actNumber: null })).toBe(
      '無題の稿（競合: 別の端末での幕の操作）',
    )
    const { data, acts } = splitSample()
    const v = data.versions[data.pieces[acts[0]].activeVersionId!]
    expect(v.sourceHash).toBeTypeOf('string')
    expect(conflictVersionCopy(v, 'iPhone', 'c', 1).sourceHash).toBeUndefined()
    const moved = actsVersionCopy(v, data.pieces[acts[1]], '名前', 'n', 5)
    expect(moved).toMatchObject({ id: 'n', pieceId: acts[1], name: '名前', sourceVersionId: v.id, createdAt: 5 })
    expect(moved.sourceHash).toBeUndefined()
    const stay = actsVersionCopy(v, data.pieces[acts[0]], '名前', v.id, 5)
    expect(stay).toMatchObject({ id: v.id, pieceId: acts[0], name: '名前', createdAt: v.createdAt })
  })
})

/** 応募計画と、その本文の控えを消した状態にする（別の端末で完全に削除された想定） */
function withoutSubmission(d: AppData, submissionId: string): AppData {
  const { [submissionId]: _s, ...submissions } = d.submissions
  void _s
  return { ...d, submissions, snapshotTexts: {} }
}
