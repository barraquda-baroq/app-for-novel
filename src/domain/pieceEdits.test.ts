// 原稿画面の保存: 画面の中で持っていた編集をまとめて書き込む・本文が競合したら別の稿として残す
import { describe, expect, it } from 'vitest'
import { joinActWithNext, separatePiece } from './acts'
import { createTitle } from './entityOps'
import { applyPieceEdits, keepOrphanedEdits, type PieceEdit } from './pieceEdits'
import { addEpisode, addSpecial, deleteVersion, updatePiece, updateVersion } from './storyOps'
import { restoreTrashEntry } from './trash'
import { emptyData, type AppData } from './types'

const opts = { conflictName: (n: string) => `${n || '無題の稿'}（競合: この端末での編集）` }

function setup() {
  let data: AppData = emptyData()
  const t = createTitle(data, '作品')
  data = t.data
  const e = addEpisode(data, t.result)
  data = e.data
  const pieceId = e.result
  const v1 = data.pieces[pieceId].versionIds[0]
  data = updateVersion(data, v1, { body: '元の本文', note: '元のメモ' })
  return { data, titleId: t.result, pieceId, v1 }
}

const edit = (target: 'version' | 'piece', id: string, field: PieceEdit['field'], base: string, value: string): PieceEdit => ({
  target,
  id,
  field,
  base,
  value,
})

describe('保存', () => {
  it('本文・稿の名前・推敲メモ・話の題をまとめて書き込む', () => {
    const { data, pieceId, v1 } = setup()
    const r = applyPieceEdits(
      data,
      pieceId,
      [
        edit('version', v1, 'body', '元の本文', '書き直した本文'),
        edit('version', v1, 'name', '第1稿', '初稿'),
        edit('version', v1, 'note', '元のメモ', '冒頭を直した'),
        edit('piece', pieceId, 'subtitle', '', '旅立ち'),
      ],
      opts,
    )
    expect(r.result.conflicts).toEqual([])
    expect(r.data.versions[v1]).toMatchObject({ body: '書き直した本文', name: '初稿', note: '冒頭を直した' })
    expect(r.data.pieces[pieceId].subtitle).toBe('旅立ち')
    expect(r.data.pieces[pieceId].versionIds).toHaveLength(1)
  })

  it('変わっていない項目は書かない（レコードも更新日時もそのまま）', () => {
    const { data, pieceId, v1 } = setup()
    const r = applyPieceEdits(data, pieceId, [edit('version', v1, 'body', '元の本文', '元の本文')], opts)
    expect(r.data).toBe(data)
  })

  it('編集を始めた後で本文が別の端末で書き換えられていたら、上書きせずにこの端末の本文を新しい稿として残す', () => {
    const { data: d0, pieceId, v1 } = setup()
    // 同期で別の端末の本文が届いた
    const data = updateVersion(d0, v1, { body: '別の端末の本文' })
    const r = applyPieceEdits(
      data,
      pieceId,
      [edit('version', v1, 'body', '元の本文', 'この端末の本文'), edit('version', v1, 'note', '元のメモ', 'この端末のメモ')],
      opts,
    )
    // 保存先の本文はそのまま。推敲メモはこの端末の編集を正とする
    expect(r.data.versions[v1].body).toBe('別の端末の本文')
    expect(r.data.versions[v1].note).toBe('この端末のメモ')
    expect(r.result.conflicts).toHaveLength(1)
    const c = r.result.conflicts[0]
    expect(c).toMatchObject({ reason: 'changed', versionId: v1, originalName: '第1稿', name: '第1稿（競合: この端末での編集）' })
    const copy = r.data.versions[c.newVersionId]
    expect(copy).toMatchObject({ body: 'この端末の本文', pieceId, sourceVersionId: v1, name: '第1稿（競合: この端末での編集）' })
    // 同じ話の稿の一覧の末尾に入る。採用は変えない
    expect(r.data.pieces[pieceId].versionIds).toEqual([v1, c.newVersionId])
    expect(r.data.pieces[pieceId].activeVersionId).toBe(v1)
  })

  it('稿の名前も一緒に変えていたら、控えの名前は変えた後の名前から作る', () => {
    const { data: d0, pieceId, v1 } = setup()
    const data = updateVersion(d0, v1, { body: '別の端末の本文' })
    const r = applyPieceEdits(
      data,
      pieceId,
      [edit('version', v1, 'body', '元の本文', 'この端末の本文'), edit('version', v1, 'name', '第1稿', '改稿')],
      opts,
    )
    expect(r.data.versions[v1].name).toBe('改稿')
    expect(r.result.conflicts[0].name).toBe('改稿（競合: この端末での編集）')
  })

  it('届いた本文がこの端末の編集と同じなら、競合にしない', () => {
    const { data: d0, pieceId, v1 } = setup()
    const data = updateVersion(d0, v1, { body: '同じ本文' })
    const r = applyPieceEdits(data, pieceId, [edit('version', v1, 'body', '元の本文', '同じ本文')], opts)
    expect(r.result.conflicts).toEqual([])
    expect(r.data.pieces[pieceId].versionIds).toHaveLength(1)
  })

  it('話の題・見出しは、別の端末で変わっていてもこの端末の編集を正とする', () => {
    let { data, titleId } = setup()
    const s = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = updatePiece(s.data, s.result, { label: '序', subtitle: '別の端末の題' })
    const r = applyPieceEdits(
      data,
      s.result,
      [edit('piece', s.result, 'label', 'プロローグ', '序章'), edit('piece', s.result, 'subtitle', '', 'この端末の題')],
      opts,
    )
    expect(r.data.pieces[s.result]).toMatchObject({ label: '序章', subtitle: 'この端末の題' })
    expect(r.result.conflicts).toEqual([])
  })

  it('第n話の見出しは書かない', () => {
    const { data, pieceId } = setup()
    const r = applyPieceEdits(data, pieceId, [edit('piece', pieceId, 'label', '', '勝手な見出し')], opts)
    expect(r.data.pieces[pieceId].label).toBe('')
    expect(r.result.dropped).toHaveLength(1)
  })

  it('保存する前に稿が削除されていたら、本文と推敲メモを新しい稿として残す（どちらの文章も消さない）', () => {
    const { data: d0, pieceId, v1 } = setup()
    const data = deleteVersion(d0, v1)
    const r = applyPieceEdits(
      data,
      pieceId,
      [
        { ...edit('version', v1, 'body', '元の本文', 'この端末の本文'), label: '第1稿' },
        edit('version', v1, 'note', '元のメモ', 'メモ'),
      ],
      opts,
    )
    expect(r.result.conflicts).toHaveLength(1)
    expect(r.result.conflicts[0]).toMatchObject({ reason: 'deleted', name: '第1稿（競合: この端末での編集）' })
    const kept = r.data.versions[r.result.conflicts[0].newVersionId]
    expect(kept).toMatchObject({ body: 'この端末の本文', note: 'メモ', pieceId })
    expect(r.result.dropped).toEqual([])
  })

  it('推敲メモ・稿の名前だけを編集していた稿が削除されていても、新しい稿として残す', () => {
    const { data: d0, pieceId, v1 } = setup()
    const data = deleteVersion(d0, v1)
    const noteOnly = applyPieceEdits(
      data,
      pieceId,
      [{ ...edit('version', v1, 'note', '元のメモ', '長い推敲メモ'), label: '第1稿' }],
      opts,
    )
    expect(noteOnly.result.conflicts).toEqual([
      expect.objectContaining({
        reason: 'deleted',
        versionId: v1,
        originalName: '第1稿',
        name: '第1稿（競合: この端末での編集）',
      }),
    ])
    expect(noteOnly.data.versions[noteOnly.result.conflicts[0].newVersionId]).toMatchObject({ body: '', note: '長い推敲メモ' })
    expect(noteOnly.result.dropped).toEqual([])

    // 稿の名前を変えていたら、その名前で残す
    const renamed = applyPieceEdits(
      data,
      pieceId,
      [edit('version', v1, 'name', '第1稿', '改稿'), edit('version', v1, 'note', '元のメモ', 'メモ')],
      opts,
    )
    expect(renamed.result.conflicts[0]).toMatchObject({ originalName: '改稿', name: '改稿（競合: この端末での編集）' })
    expect(renamed.data.versions[renamed.result.conflicts[0].newVersionId].note).toBe('メモ')
  })

  it('削除されていた稿の編集が空にしただけなら、残すものはない（書き込めなかった編集にもしない）', () => {
    const { data: d0, pieceId, v1 } = setup()
    const data = deleteVersion(d0, v1)
    const r = applyPieceEdits(data, pieceId, [edit('version', v1, 'note', '元のメモ', '')], opts)
    expect(r.result).toEqual({ conflicts: [], dropped: [] })
    expect(r.data.pieces[pieceId].versionIds).toEqual(data.pieces[pieceId].versionIds)
  })
})

describe('保存先が無くなった編集を残す（keepOrphanedEdits）', () => {
  /** 'AAABBB' を2幕に分け、第2幕を第1幕とつないだ（第2幕は無くなった） */
  function joined() {
    const { data: d0, titleId, pieceId } = setup()
    const v = d0.pieces[pieceId].versionIds[0]
    const s = separatePiece(updateVersion(d0, v, { body: 'AAABBB' }), pieceId, [3])
    const [a1, a2] = s.result
    const a2v = s.data.pieces[a2].activeVersionId!
    const data = joinActWithNext(s.data, a1).data
    return { data, titleId, pieceId, a1, a2, a2v }
  }

  it('稿の編集（本文・稿の名前・推敲メモ）を、残し先の新しい稿（採用しない）にする。話の題はふつうに書く', () => {
    const { data, titleId, pieceId, a1, a2, a2v } = joined()
    const before = data.pieces[a1]
    const r = keepOrphanedEdits(
      data,
      [
        { ...edit('version', a2v, 'body', 'BBB', 'BBB追記'), label: '第1稿' },
        { ...edit('version', a2v, 'note', '', '第2幕のメモ'), label: '第1稿' },
        edit('piece', pieceId, 'subtitle', '', '雨'),
      ],
      { pieceId: a1, origin: { titleId, pieceId: a2, parentId: pieceId }, parentLabel: '第1話　第2幕' },
      opts,
    )
    expect(r.result.trashEntryId).toBeNull()
    expect(r.result.names).toEqual(['第1稿（競合: この端末での編集）'])
    const kept = r.data.versions[r.result.versionIds[0]]
    expect(kept).toMatchObject({ pieceId: a1, name: '第1稿（競合: この端末での編集）', body: 'BBB追記', note: '第2幕のメモ' })
    expect(r.data.pieces[a1].activeVersionId).toBe(before.activeVersionId)
    expect(r.data.pieces[pieceId].subtitle).toBe('雨')
  })

  it('残し先が無い・幕に分けた話なら、ゴミ箱に「同期の競合で残した内容」として1件にまとめて残す', () => {
    const { data, titleId, pieceId, a2, a2v } = joined()
    const r = keepOrphanedEdits(
      data,
      [{ ...edit('version', a2v, 'body', 'BBB', 'BBB追記'), label: '第1稿' }],
      { pieceId: pieceId, origin: { titleId, pieceId: a2, parentId: pieceId }, parentLabel: '第1話　第2幕' },
      opts,
    )
    const entry = r.data.trashEntries[r.result.trashEntryId!]
    expect(entry).toMatchObject({ kind: 'version', reason: 'conflict', label: '第1稿（競合: この端末での編集）' })
    expect(entry.origin).toMatchObject({ pieceId: a2, parentId: pieceId, wasActive: false })
    // 戻すと（話をまだ分けていれば）最初の幕の稿として戻る
    const back = restoreTrashEntry(r.data, entry.id).data
    const first = back.pieces[pieceId].actIds![0]
    expect(back.pieces[first].versionIds.map((id) => back.versions[id].body)).toContain('BBB追記')
  })

  it('空にしただけの編集は残さない', () => {
    const { data, titleId, pieceId, a1, a2, a2v } = joined()
    const r = keepOrphanedEdits(
      data,
      [edit('version', a2v, 'note', '元', '')],
      { pieceId: a1, origin: { titleId, pieceId: a2, parentId: pieceId }, parentLabel: '' },
      opts,
    )
    expect(r.result.versionIds).toEqual([])
    expect(r.data.versions).toBe(data.versions)
  })
})
