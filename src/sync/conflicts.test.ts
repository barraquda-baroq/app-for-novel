// 同期の競合で作るゴミ箱の控えが、ゴミ箱の「元に戻す」でそのまま戻せること
import { describe, expect, it } from 'vitest'
import { addMemo, addSubmission, createTitle, recordSubmissionSnapshot } from '../domain/entityOps'
import { addEpisode, updateVersion } from '../domain/storyOps'
import { restoreTrashEntry } from '../domain/trash'
import { emptyData, type AppData, type TrashEntry, type TrashRecord } from '../domain/types'
import { newId } from '../domain/util'
import { conflictTrash } from './conflicts'

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

/** 応募計画と、その本文の控えを消した状態にする（別の端末で完全に削除された想定） */
function withoutSubmission(d: AppData, submissionId: string): AppData {
  const { [submissionId]: _s, ...submissions } = d.submissions
  void _s
  return { ...d, submissions, snapshotTexts: {} }
}
