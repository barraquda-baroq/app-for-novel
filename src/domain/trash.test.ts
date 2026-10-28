import { describe, expect, it } from 'vitest'
import { parseBackup } from './backup'
import {
  addEntry,
  addIdea,
  addMemo,
  addSubmission,
  categoriesOf,
  createTitle,
  deleteCategory,
  deleteEntry,
  deleteIdea,
  deleteMemo,
  deleteSubmission,
  deleteTitle,
  entriesOf,
  ideaSections,
  memosOf,
  moveMemoStep,
  recordSubmissionSnapshot,
  snapshotPieceBody,
  submissionsOf,
  updateMemo,
} from './entityOps'
import { repairData } from './repair'
import {
  addChapter,
  addEpisode,
  addSpecial,
  addVersion,
  deletePiece,
  deleteVersion,
  duplicateVersion,
  movePiece,
  moveChapterStep,
  removeChapter,
  setActiveVersion,
  setChaptersEnabled,
  updatePiece,
  updateVersion,
} from './storyOps'
import { episodeNumbers, flatten, pieceFullLabel } from './structure'
import {
  DAY_MS,
  RESTORED_COPY_SUFFIX,
  TRASH_RETENTION_MS,
  deleteTrashEntry,
  emptyTrash,
  listTrash,
  purgeExpiredTrash,
  restoreTrashEntry,
  trashDaysLeft,
  trashNotice,
} from './trash'
import { DomainError, emptyData, type AppData, type ID, type TrashEntry, type TrashRecord } from './types'

// ---------- 用意 ----------

/** ゴミ箱以外の表から updatedAt を除いたもの（戻した結果を元と比べる用） */
function live(data: AppData): Record<string, unknown> {
  const { trashEntries: _e, trashRecords: _r, ...rest } = data
  void _e
  void _r
  const out: Record<string, unknown> = {}
  for (const [table, rows] of Object.entries(rest)) {
    out[table] = Object.fromEntries(
      Object.entries(rows as unknown as Record<string, Record<string, unknown>>).map(([id, r]) => {
        const { updatedAt: _u, ...without } = r
        void _u
        return [id, without]
      }),
    )
  }
  return out
}

function trashCount(data: AppData): { entries: number; records: number } {
  return { entries: Object.keys(data.trashEntries).length, records: Object.keys(data.trashRecords).length }
}

/** 直前に入れたゴミ箱の1件（同じミリ秒に続けて削除することがあるので、入れた順で見る） */
function lastEntry(data: AppData): TrashEntry {
  return Object.values(data.trashEntries).at(-1)!
}

function restore(data: AppData, entry: TrashEntry = lastEntry(data)): AppData {
  return restoreTrashEntry(data, entry.id).data
}

function labels(data: AppData, titleId: ID): string[] {
  const nums = episodeNumbers(data, titleId)
  return flatten(data, titleId).map((f) => pieceFullLabel(data, data.pieces[f.pieceId], nums))
}

/**
 * 章あり（第1章: 第1〜3話、第2章: 第4〜5話）・タイトル直下にエピローグ。
 * 第1話には稿が3つ（第2稿を採用）。メモ3つ、キャラクターにエントリ3つ、応募計画2つ（A賞は応募時の原稿を記録）、
 * アイデアはタイトルに2つ・どのタイトルにも属さないものが1つ。別のタイトル「B」もある。
 */
function fixture() {
  let data = emptyData()
  const t = createTitle(data, '作品A')
  data = createTitle(t.data, 'B').data
  const titleId = t.result
  const pieces: ID[] = []
  for (let i = 0; i < 3; i++) {
    const r = addEpisode(data, titleId)
    data = updatePiece(r.data, r.result, { subtitle: `題${i + 1}` })
    pieces.push(r.result)
  }
  data = setChaptersEnabled(data, titleId, true)
  const ch1 = data.titles[titleId].structure[0].id
  const c2 = addChapter(data, titleId)
  data = c2.data
  for (let i = 3; i < 5; i++) {
    const r = addEpisode(data, titleId, c2.result)
    data = updatePiece(r.data, r.result, { subtitle: `題${i + 1}` })
    pieces.push(r.result)
  }
  const epi = addSpecial(data, titleId, { chapterId: null, index: 2 }, 'エピローグ')
  data = epi.data
  const v1 = data.pieces[pieces[0]].versionIds[0]
  data = updateVersion(data, v1, { body: '第一稿の本文' })
  const v2 = duplicateVersion(data, v1)
  data = updateVersion(v2.data, v2.result, { body: '第二稿の本文' })
  const v3 = addVersion(data, pieces[0], { body: '第三稿の本文' })
  data = setActiveVersion(v3.data, pieces[0], v2.result)
  const memos: ID[] = []
  for (const name of ['メモ1', 'メモ2', 'メモ3']) {
    const r = addMemo(data, titleId, name)
    data = updateMemo(r.data, r.result, { body: `${name}の本文` })
    memos.push(r.result)
  }
  const chara = categoriesOf(data, titleId)[0].id
  const entries: ID[] = []
  for (const name of ['アオイ', 'クロ', 'ベニ']) {
    const r = addEntry(data, chara, name)
    data = r.data
    entries.push(r.result)
  }
  const s1 = addSubmission(data, titleId, 'A賞')
  const s2 = addSubmission(s1.data, titleId, 'B賞')
  data = recordSubmissionSnapshot(s2.data, s1.result)
  const i1 = addIdea(data, titleId, '案1')
  const i2 = addIdea(i1.data, titleId, '案2')
  const i3 = addIdea(i2.data, null, 'どこにも属さない案')
  data = i3.data
  return {
    data,
    titleId,
    otherTitleId: Object.values(data.titles).find((x) => x.name === 'B')!.id,
    pieces,
    ch1,
    ch2: c2.result,
    epilogue: epi.result,
    versions: [v1, v2.result, v3.result],
    memos,
    chara,
    entries,
    submissions: [s1.result, s2.result],
    ideas: [i1.result, i2.result, i3.result],
  }
}

// ---------- 削除してから戻す ----------

describe('削除するとゴミ箱へ移り、戻すと元どおりになる', () => {
  it('話（稿ごと）', () => {
    const f = fixture()
    let data = deletePiece(f.data, f.pieces[4])
    expect(data.pieces[f.pieces[4]]).toBeUndefined()
    const entry = lastEntry(data)
    expect(entry).toMatchObject({
      kind: 'piece',
      label: '第5話　題5',
      titleName: '作品A',
      parentLabel: '第2章',
      origin: { titleId: f.titleId, chapterId: f.ch2, index: 1, prevId: f.pieces[3] },
    })
    expect(data.trashRecords[entry.recordIds[0]]).toMatchObject({ table: 'pieces', record: { id: f.pieces[4] } })
    expect(entry.recordIds).toHaveLength(2)
    data = restore(data)
    expect(live(data)).toEqual(live(f.data))
    expect(trashCount(data)).toEqual({ entries: 0, records: 0 })
  })

  it('稿が3つある話・特殊ブロック（話数は並び順から振り直される）', () => {
    const f = fixture()
    let data = deletePiece(f.data, f.epilogue)
    expect(lastEntry(data)).toMatchObject({ label: 'エピローグ', origin: { chapterId: null, index: 2, prevId: f.ch2 } })
    data = restore(data)
    expect(live(data)).toEqual(live(f.data))

    // 第1話は途中の話なので消せない（ルールは変わらない）
    expect(() => deletePiece(f.data, f.pieces[0])).toThrow(DomainError)
  })

  it('推敲バージョン（採用中だった稿は、ほかに採用がなければ採用に戻る）', () => {
    const f = fixture()
    let data = deleteVersion(f.data, f.versions[1])
    expect(data.pieces[f.pieces[0]].activeVersionId).toBeNull()
    expect(lastEntry(data)).toMatchObject({
      kind: 'version',
      label: '第2稿（第1稿を複製）',
      parentLabel: '第1話　題1',
      origin: { pieceId: f.pieces[0], index: 1, prevId: f.versions[0], wasActive: true },
    })
    data = restore(data)
    expect(live(data)).toEqual(live(f.data))
    expect(data.pieces[f.pieces[0]].activeVersionId).toBe(f.versions[1])
  })

  it('採用中だった稿を戻しても、その間に別の稿を採用していればそちらのまま', () => {
    const f = fixture()
    let data = deleteVersion(f.data, f.versions[1])
    data = setActiveVersion(data, f.pieces[0], f.versions[2])
    data = restore(data)
    expect(data.pieces[f.pieces[0]].versionIds).toEqual(f.versions)
    expect(data.pieces[f.pieces[0]].activeVersionId).toBe(f.versions[2])
  })

  it('タイトル（配下すべてと応募時の原稿の控え）。アイデアは「どのタイトルにも属さない」に残る', () => {
    const f = fixture()
    let data = deleteTitle(f.data, f.titleId)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(0)
    expect(Object.values(data.pieces)).toHaveLength(0)
    expect(
      ideaSections(data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['どこにも属さない案', '案1', '案2'])
    expect(lastEntry(data)).toMatchObject({ kind: 'title', label: '作品A', origin: { titleId: null, index: 0, prevId: null } })
    data = restore(data)
    const { ideas: restoredIdeas, ...rest } = live(data)
    const { ideas: _originalIdeas, ...original } = live(f.data)
    void _originalIdeas
    expect(rest).toEqual(original)
    expect(Object.values(restoredIdeas as Record<string, { titleId: ID | null }>).every((i) => i.titleId === null)).toBe(true)
    const snap = data.submissions[f.submissions[0]].snapshot!
    expect(snapshotPieceBody(data, snap.pieces![f.pieces[0]])).toBe('第二稿の本文')
  })

  it('章の解除（章を元の位置に作り直し、今もタイトル直下にある話を章へ戻す）', () => {
    const f = fixture()
    let data = removeChapter(f.data, f.ch2)
    expect(labels(data, f.titleId)).toEqual(labels(f.data, f.titleId))
    expect(lastEntry(data)).toMatchObject({
      kind: 'chapter',
      label: '第2章',
      origin: { chapterId: null, index: 1, prevId: f.ch1 },
    })
    data = restore(data)
    expect(live(data)).toEqual(live(f.data))
  })

  it('章の解除を戻す時、別の章へ移した話はそのまま', () => {
    const f = fixture()
    let data = removeChapter(f.data, f.ch2)
    data = movePiece(data, f.pieces[3], { chapterId: f.ch1, index: 3 })
    data = restore(data)
    expect(data.chapters[f.ch2].pieceIds).toEqual([f.pieces[4]])
    expect(data.chapters[f.ch1].pieceIds).toEqual([...f.pieces.slice(0, 4)])
    expect(data.titles[f.titleId].structure).toEqual([
      { type: 'chapter', id: f.ch1 },
      { type: 'chapter', id: f.ch2 },
      { type: 'piece', id: f.epilogue },
    ])
  })

  it('メモ・アイデア・設定項目（エントリごと）・設定エントリ・応募計画', () => {
    const f = fixture()
    const cases: [string, (d: AppData) => AppData, Partial<TrashEntry>][] = [
      [
        'memo',
        (d) => deleteMemo(d, f.memos[1]),
        { kind: 'memo', label: 'メモ2', origin: { titleId: f.titleId, index: 1, prevId: f.memos[0] } },
      ],
      [
        'idea',
        (d) => deleteIdea(d, f.ideas[1]),
        { kind: 'idea', label: '案2', titleName: '作品A', origin: { titleId: f.titleId, index: 1, prevId: f.ideas[0] } },
      ],
      [
        'unassigned idea',
        (d) => deleteIdea(d, f.ideas[2]),
        { kind: 'idea', titleName: '', origin: { titleId: null, index: 0, prevId: null } },
      ],
      ['category', (d) => deleteCategory(d, f.chara), { kind: 'settingCategory', label: 'キャラクター' }],
      [
        'entry',
        (d) => deleteEntry(d, f.entries[2]),
        {
          kind: 'settingEntry',
          label: 'ベニ',
          parentLabel: 'キャラクター',
          origin: { titleId: f.titleId, categoryId: f.chara, index: 2, prevId: f.entries[1] },
        },
      ],
      [
        'submission',
        (d) => deleteSubmission(d, f.submissions[0]),
        { kind: 'submission', label: 'A賞', origin: { titleId: f.titleId, index: 0, prevId: null } },
      ],
    ]
    for (const [name, del, expected] of cases) {
      const deleted = del(f.data)
      expect(lastEntry(deleted), name).toMatchObject(expected)
      expect(live(restore(deleted)), name).toEqual(live(f.data))
      expect(trashCount(restore(deleted)), name).toEqual({ entries: 0, records: 0 })
    }
  })

  it('設定項目はエントリごと1件になる', () => {
    const f = fixture()
    const data = deleteCategory(f.data, f.chara)
    expect(entriesOf(data, f.chara)).toHaveLength(0)
    expect(lastEntry(data).recordIds).toHaveLength(4)
  })

  it('応募計画を削除しても応募時の原稿の控えはゴミ箱に残り、戻すとまた読める', () => {
    const f = fixture()
    let data = deleteSubmission(f.data, f.submissions[0])
    expect(Object.keys(data.snapshotTexts)).toHaveLength(0)
    data = restore(data)
    const snap = data.submissions[f.submissions[0]].snapshot!
    expect(snapshotPieceBody(data, snap.pieces![f.pieces[0]])).toBe('第二稿の本文')
  })

  it('別の応募記録と共有している控えは、削除しても消さない', () => {
    const f = fixture()
    let data = recordSubmissionSnapshot(f.data, f.submissions[1])
    const keys = Object.keys(data.snapshotTexts)
    data = deleteSubmission(data, f.submissions[0])
    expect(Object.keys(data.snapshotTexts)).toEqual(keys)
    data = restore(data)
    expect(Object.keys(data.snapshotTexts)).toEqual(keys)
  })
})

// ---------- 戻す位置 ----------

describe('戻す位置', () => {
  it('並びが変わっていても、直前にあった要素の直後へ戻す', () => {
    const f = fixture()
    let data = deleteMemo(f.data, f.memos[1])
    data = moveMemoStep(data, f.memos[2], -1) // メモ3, メモ1
    data = restore(data)
    expect(memosOf(data, f.titleId).map((m) => m.name)).toEqual(['メモ3', 'メモ1', 'メモ2'])

    let s = deletePiece(f.data, f.epilogue)
    s = moveChapterStep(s, f.ch2, -1) // 第2章, 第1章
    s = restore(s)
    expect(s.titles[f.titleId].structure.map((n) => n.id)).toEqual([f.ch2, f.epilogue, f.ch1])
  })

  it('直前にあった要素が無くなっていたら、控えた位置（範囲内に収める）へ戻す', () => {
    const f = fixture()
    // 稿: 第2稿を消し、続けてその前の第1稿も消してから第2稿だけ戻すと、控えた位置（2番目）に戻る
    let data = deleteVersion(f.data, f.versions[1])
    const v2Entry = lastEntry(data)
    data = deleteVersion(data, f.versions[0])
    const v1Entry = lastEntry(data)
    const onlyV2 = restore(data, v2Entry)
    expect(onlyV2.pieces[f.pieces[0]].versionIds).toEqual([f.versions[2], f.versions[1]])
    // 消した逆の順に戻せば元どおり
    data = restore(restore(data, v1Entry), v2Entry)
    expect(live(data)).toEqual(live(f.data))

    // 並び（order）のもの: 間が欠けていても元の順番になる
    let m = deleteMemo(f.data, f.memos[1])
    const m2 = lastEntry(m)
    m = deleteMemo(m, f.memos[0])
    m = restore(m, m2)
    expect(memosOf(m, f.titleId).map((x) => x.name)).toEqual(['メモ2', 'メモ3'])
    m = restore(m)
    expect(memosOf(m, f.titleId).map((x) => x.name)).toEqual(['メモ1', 'メモ2', 'メモ3'])
    expect(live(m)).toEqual(live(f.data))
  })

  it('話を逆の順番で戻しても元の並びになる', () => {
    const f = fixture()
    let data = deletePiece(f.data, f.pieces[4])
    const e5 = lastEntry(data)
    data = deletePiece(data, f.pieces[3])
    data = restore(data, e5)
    expect(data.chapters[f.ch2].pieceIds).toEqual([f.pieces[4]])
    data = restore(data)
    expect(live(data)).toEqual(live(f.data))
  })

  it('元の章が解除されていたら、直前にあった話の後ろ（タイトル直下）へ戻す', () => {
    const f = fixture()
    let data = deletePiece(f.data, f.pieces[4])
    const pieceEntry = lastEntry(data)
    data = removeChapter(data, f.ch2)
    data = restore(data, pieceEntry)
    expect(data.titles[f.titleId].structure).toEqual([
      { type: 'chapter', id: f.ch1 },
      { type: 'piece', id: f.pieces[3] },
      { type: 'piece', id: f.pieces[4] },
      { type: 'piece', id: f.epilogue },
    ])
    expect(labels(data, f.titleId)).toEqual(labels(f.data, f.titleId))
    // 続けて章を戻すと、章の中身も元どおり（解除した時点の中身 = 第4話だけ）
    data = restore(data)
    expect(data.chapters[f.ch2].pieceIds).toEqual([f.pieces[3]])
  })

  it('途中の位置に戻した話は、並び順どおりに話数が振り直される', () => {
    let data = emptyData()
    const t = createTitle(data, 't')
    data = t.data
    const ids: ID[] = []
    for (let i = 0; i < 3; i++) {
      const r = addEpisode(data, t.result)
      data = updatePiece(r.data, r.result, { subtitle: String.fromCharCode(65 + i) })
      ids.push(r.result)
    }
    data = deletePiece(data, ids[2]) // C
    data = movePiece(data, ids[0], { chapterId: null, index: 1 }) // B, A
    data = restore(data)
    // C は直前にあった B の後ろへ戻り、第2話になる
    expect(labels(data, t.result)).toEqual(['第1話　B', '第2話　C', '第3話　A'])
  })
})

// ---------- 戻せない時・複製として戻す時 ----------

describe('戻せない時', () => {
  it('元の話がない稿・元のタイトルがない話・元の設定項目がないエントリは、先に親を戻すよう伝える', () => {
    const f = fixture()
    let data = deleteVersion(f.data, f.versions[2])
    const versionEntry = lastEntry(data)
    data = deletePiece(data, f.pieces[4])
    // 稿の話は消えていない（第1話）ので戻せる。第5話の稿は話ごと消したので話の件に入っている
    expect(() => restore(data, versionEntry)).not.toThrow()

    let v = deleteVersion(f.data, f.versions[2])
    const vEntry = lastEntry(v)
    // 話を消すには最後の話にする
    v = movePiece(v, f.pieces[0], { chapterId: f.ch2, index: 2 })
    v = deletePiece(v, f.pieces[0])
    expect(() => restore(v, vEntry)).toThrow('元の話がないため戻せません。先に話を戻してください。')
    // 話を戻せば稿も戻せる
    v = restore(v)
    v = restore(v, vEntry)
    expect(v.pieces[f.pieces[0]].versionIds).toEqual(f.versions)

    let p = deletePiece(f.data, f.pieces[4])
    const pEntry = lastEntry(p)
    p = deleteTitle(p, f.titleId)
    expect(() => restore(p, pEntry)).toThrow('元のタイトルがないため戻せません。先にタイトルを戻してください。')
    p = restore(p)
    p = restore(p, pEntry)
    expect(labels(p, f.titleId)).toEqual(labels(f.data, f.titleId))

    let e = deleteEntry(f.data, f.entries[0])
    const eEntry = lastEntry(e)
    e = deleteCategory(e, f.chara)
    expect(() => restore(e, eEntry)).toThrow('元の設定項目がないため戻せません。先に設定項目を戻してください。')

    // タイトルごと消えていれば、タイトルを先に戻すよう伝える
    let v2 = deleteVersion(f.data, f.versions[2])
    const v2Entry = lastEntry(v2)
    v2 = deleteTitle(v2, f.titleId)
    expect(() => restore(v2, v2Entry)).toThrow('元のタイトルがないため戻せません')
  })

  it('元のタイトルがないアイデアは「どのタイトルにも属さない」へ戻す', () => {
    const f = fixture()
    let data = deleteIdea(f.data, f.ideas[0])
    const entry = lastEntry(data)
    data = deleteTitle(data, f.titleId)
    const r = restoreTrashEntry(data, entry.id)
    expect(r.result).toMatchObject({ movedToUnassigned: true, titleId: null })
    expect(
      ideaSections(r.data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['どこにも属さない案', '案2', '案1'])
  })

  it('ゴミ箱にないものは戻せない', () => {
    expect(() => restoreTrashEntry(emptyData(), 'nope')).toThrow(DomainError)
  })
})

/** 同期の競合で残した内容（中身は1件だけ） */
function conflictEntry(
  data: AppData,
  table: TrashRecord['table'],
  record: TrashRecord['record'],
  entry: Partial<TrashEntry>,
): AppData {
  const ts = 1_000
  const rec: TrashRecord = { id: `rec-${record.id}`, entryId: `entry-${record.id}`, table, record, createdAt: ts, updatedAt: ts }
  const e: TrashEntry = {
    id: rec.entryId,
    kind: 'version',
    label: '',
    titleName: '',
    origin: { titleId: null, index: 0 },
    recordIds: [rec.id],
    reason: 'conflict',
    deletedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    ...entry,
  }
  return {
    ...data,
    trashEntries: { ...data.trashEntries, [e.id]: e },
    trashRecords: { ...data.trashRecords, [rec.id]: rec },
  }
}

describe('同じ id のものが残っていれば、新しい id の複製として戻す', () => {
  it('稿（同期の競合で残した内容）: 名前に「（ゴミ箱から復元）」を付け、残っている稿は上書きしない', () => {
    const f = fixture()
    const edited = { ...f.data.versions[f.versions[1]], body: '別の端末で書き足した本文' }
    let data = conflictEntry(f.data, 'versions', edited, {
      kind: 'version',
      label: '第2稿（第1稿を複製）',
      titleName: '作品A',
      origin: { titleId: f.titleId, pieceId: f.pieces[0], index: 1, prevId: f.versions[0], wasActive: true },
    })
    const r = restoreTrashEntry(data, `entry-${f.versions[1]}`)
    data = r.data
    expect(r.result.copied).toBe(true)
    expect(r.result.id).not.toBe(f.versions[1])
    expect(data.versions[f.versions[1]]).toEqual(f.data.versions[f.versions[1]])
    expect(data.versions[r.result.id]).toMatchObject({
      pieceId: f.pieces[0],
      name: `第2稿（第1稿を複製）${RESTORED_COPY_SUFFIX}`,
      body: '別の端末で書き足した本文',
    })
    expect(data.pieces[f.pieces[0]].versionIds).toEqual([f.versions[0], r.result.id, f.versions[1], f.versions[2]])
    // 採用中の稿があるので、複製は採用しない
    expect(data.pieces[f.pieces[0]].activeVersionId).toBe(f.versions[1])
    expect(trashCount(data)).toEqual({ entries: 0, records: 0 })
  })

  it('稿（同期の競合で残した内容）: 同じ id が無ければそのまま戻す', () => {
    const f = fixture()
    let data = deleteVersion(f.data, f.versions[2])
    const v3 = { ...f.data.versions[f.versions[2]], body: '編集された第三稿' }
    data = emptyTrash(data)
    data = conflictEntry(data, 'versions', v3, {
      kind: 'version',
      origin: { titleId: f.titleId, pieceId: f.pieces[0], index: 2, prevId: f.versions[1] },
    })
    const r = restoreTrashEntry(data, `entry-${f.versions[2]}`)
    expect(r.result).toMatchObject({ copied: false, id: f.versions[2] })
    expect(r.data.versions[f.versions[2]].body).toBe('編集された第三稿')
    expect(r.data.pieces[f.pieces[0]].versionIds).toEqual(f.versions)
  })

  it('メモ・設定エントリ・応募計画（同期の競合で残した内容）', () => {
    const f = fixture()
    const memo = { ...f.data.memos[f.memos[0]], body: '別の端末の本文' }
    let data = conflictEntry(f.data, 'memos', memo, {
      kind: 'memo',
      origin: { titleId: f.titleId, index: 0, prevId: null },
    })
    const r = restoreTrashEntry(data, `entry-${f.memos[0]}`)
    data = r.data
    expect(data.memos[f.memos[0]].body).toBe('メモ1の本文')
    expect(memosOf(data, f.titleId).map((m) => m.body)).toEqual(['別の端末の本文', 'メモ1の本文', 'メモ2の本文', 'メモ3の本文'])

    const entry = { ...f.data.settingEntries[f.entries[1]], body: '競合' }
    let e = conflictEntry(f.data, 'settingEntries', entry, {
      kind: 'settingEntry',
      origin: { titleId: f.titleId, categoryId: f.chara, index: 1, prevId: f.entries[0] },
    })
    e = restoreTrashEntry(e, `entry-${f.entries[1]}`).data
    expect(entriesOf(e, f.chara).map((x) => x.name)).toEqual(['アオイ', 'クロ', 'クロ', 'ベニ'])
    expect(entriesOf(e, f.chara)[1].body).toBe('競合')

    const sub = { ...f.data.submissions[f.submissions[1]], result: '一次通過' }
    let s = conflictEntry(f.data, 'submissions', sub, {
      kind: 'submission',
      origin: { titleId: f.titleId, index: 1, prevId: f.submissions[0] },
    })
    s = restoreTrashEntry(s, `entry-${f.submissions[1]}`).data
    expect(submissionsOf(s, f.titleId).map((x) => x.result)).toEqual(['', '一次通過', ''])
  })

  it('削除した話が別の経路で戻っていても、話と稿を複製として戻す（参照も付け替える）', () => {
    const f = fixture()
    let data = deletePiece(f.data, f.pieces[4])
    const entry = lastEntry(data)
    // 例えばバックアップの復元などで、同じ id の話と稿が戻ってきた
    const piece = f.data.pieces[f.pieces[4]]
    const vid = piece.versionIds[0]
    data = {
      ...data,
      pieces: { ...data.pieces, [piece.id]: piece },
      versions: { ...data.versions, [vid]: f.data.versions[vid] },
      chapters: { ...data.chapters, [f.ch2]: f.data.chapters[f.ch2] },
    }
    const r = restoreTrashEntry(data, entry.id)
    expect(r.result.copied).toBe(true)
    const copy = r.data.pieces[r.result.id]
    expect(copy.versionIds).toHaveLength(1)
    expect(copy.versionIds[0]).not.toBe(vid)
    expect(copy.activeVersionId).toBe(copy.versionIds[0])
    expect(r.data.versions[copy.versionIds[0]]).toMatchObject({ pieceId: copy.id, name: `第1稿${RESTORED_COPY_SUFFIX}` })
    expect(r.data.chapters[f.ch2].pieceIds).toEqual([f.pieces[3], copy.id, f.pieces[4]])
  })
})

// ---------- 完全に削除・30日 ----------

describe('完全に削除', () => {
  it('30日たったものだけを中身ごと消す（ちょうど30日で消える）', () => {
    const f = fixture()
    let data = deleteMemo(f.data, f.memos[0])
    const old = lastEntry(data)
    data = deleteMemo(data, f.memos[1])
    const recent = lastEntry(data)
    const t0 = old.deletedAt
    data = {
      ...data,
      trashEntries: { ...data.trashEntries, [recent.id]: { ...recent, deletedAt: t0 + DAY_MS } },
    }
    expect(purgeExpiredTrash(data, t0 + TRASH_RETENTION_MS - 1)).toBe(data)
    const purged = purgeExpiredTrash(data, t0 + TRASH_RETENTION_MS)
    expect(Object.keys(purged.trashEntries)).toEqual([recent.id])
    expect(Object.values(purged.trashRecords).map((r) => r.entryId)).toEqual([recent.id])
    expect(trashCount(purgeExpiredTrash(purged, t0 + DAY_MS + TRASH_RETENTION_MS))).toEqual({ entries: 0, records: 0 })
  })

  it('残り日数は切り上げで、30日を超えない', () => {
    const t0 = 1_700_000_000_000
    expect(trashDaysLeft({ deletedAt: t0 }, t0)).toBe(30)
    expect(trashDaysLeft({ deletedAt: t0 }, t0 + 29.5 * DAY_MS)).toBe(1)
    expect(trashDaysLeft({ deletedAt: t0 }, t0 + TRASH_RETENTION_MS)).toBe(0)
    expect(trashDaysLeft({ deletedAt: t0 + 5 * DAY_MS }, t0)).toBe(30)
  })

  it('1件ずつ・すべてを完全に削除でき、一覧は新しい順', () => {
    const f = fixture()
    let data = deleteMemo(f.data, f.memos[0])
    const first = lastEntry(data)
    data = deleteIdea(data, f.ideas[0])
    const second = lastEntry(data)
    data = { ...data, trashEntries: { ...data.trashEntries, [second.id]: { ...second, deletedAt: first.deletedAt + 1 } } }
    expect(listTrash(data.trashEntries).map((e) => e.id)).toEqual([second.id, first.id])
    const one = deleteTrashEntry(data, first.id)
    expect(Object.keys(one.trashEntries)).toEqual([second.id])
    expect(Object.values(one.trashRecords).every((r) => r.entryId === second.id)).toBe(true)
    expect(deleteTrashEntry(one, first.id)).toBe(one)
    expect(trashCount(emptyTrash(data))).toEqual({ entries: 0, records: 0 })
    const empty = emptyTrash(data)
    expect(emptyTrash(empty)).toBe(empty)
  })

  it('確認文の結び', () => {
    expect(trashNotice()).toBe('ゴミ箱に移します。30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。')
  })
})

// ---------- 修復・バックアップ ----------

describe('ゴミ箱の修復', () => {
  it('壊れた中身・件のない中身・中身のない件を取り除き、項目を補う', () => {
    const f = fixture()
    let data = deleteMemo(f.data, f.memos[0])
    const entry = lastEntry(data)
    const rec = data.trashRecords[entry.recordIds[0]]
    data = {
      ...data,
      trashEntries: {
        ...data.trashEntries,
        [entry.id]: { ...entry, recordIds: [...entry.recordIds, 'missing'], reason: 'odd' as never, label: 1 as never },
        empty: { ...entry, id: 'empty', recordIds: [] },
        strange: { ...entry, id: 'strange', kind: 'unknown' as never },
      },
      trashRecords: {
        ...data.trashRecords,
        badTable: { ...rec, id: 'badTable', table: 'trashEntries' as never },
        badRecord: { ...rec, id: 'badRecord', record: 'text' as never },
        noId: { ...rec, id: 'noId', record: { name: 'x' } as never },
        orphan: { ...rec, id: 'orphan', entryId: 'gone' },
        strangeRec: { ...rec, id: 'strangeRec', entryId: 'strange' },
        unlisted: { ...rec, id: 'unlisted' },
      },
    }
    const { data: repaired, fixes } = repairData(data)
    expect(fixes.length).toBeGreaterThan(0)
    expect(Object.keys(repaired.trashEntries)).toEqual([entry.id])
    expect(Object.keys(repaired.trashRecords).sort()).toEqual([entry.recordIds[0], 'unlisted'].sort())
    expect(repaired.trashEntries[entry.id]).toMatchObject({
      recordIds: [entry.recordIds[0], 'unlisted'],
      reason: 'deleted',
      label: 'メモ',
    })
    // 正しいゴミ箱はそのまま
    const clean = deleteMemo(f.data, f.memos[0])
    expect(repairData(clean).fixes).toEqual([])
  })

  it('ゴミ箱の表がない古いバックアップも読み込める', () => {
    const f = fixture()
    const { trashEntries: _e, trashRecords: _r, ...old } = f.data
    void _e
    void _r
    const parsed = parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 1, exportedAt: '', data: old }))
    expect(parsed.trashEntries).toEqual({})
    expect(parsed.trashRecords).toEqual({})
    expect(Object.keys(parsed.titles)).toHaveLength(2)
    // ゴミ箱ごと書き出したものも読み込める
    const withTrash = deletePiece(f.data, f.pieces[4])
    const again = parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 1, exportedAt: '', data: withTrash }))
    expect(again).toEqual(withTrash)
  })
})
