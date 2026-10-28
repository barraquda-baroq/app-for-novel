import { describe, expect, it } from 'vitest'
import { addIdea, createTitle, ideaSections, moveIdeaStep } from './entityOps'
import { repairData } from './repair'
import { addChapter, addEpisode, setChaptersEnabled } from './storyOps'
import { flatten } from './structure'
import { emptyData, type AppData } from './types'

function sample() {
  const t = createTitle(emptyData(), '作品')
  let data = addEpisode(t.data, t.result).data
  data = addEpisode(data, t.result).data
  data = setChaptersEnabled(data, t.result, true)
  data = addChapter(data, t.result).data
  return { data, titleId: t.result }
}

describe('データの修復', () => {
  it('正常なデータはそのまま返す', () => {
    const { data } = sample()
    const r = repairData(data)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(data)
  })

  it('存在しない章・話への参照、二重に入った話、構成から外れた話を直す', () => {
    const { data, titleId } = sample()
    const [c1, c2] = data.titles[titleId].structure.map((n) => n.id)
    const [p1, p2] = data.chapters[c1].pieceIds
    const broken: AppData = {
      ...data,
      titles: {
        ...data.titles,
        [titleId]: {
          ...data.titles[titleId],
          structure: [
            { type: 'chapter', id: c1 },
            { type: 'chapter', id: 'nope' },
            { type: 'piece', id: 'ghost' },
            { type: 'chapter', id: c2 },
          ],
        },
      },
      chapters: {
        ...data.chapters,
        [c1]: { ...data.chapters[c1], pieceIds: [p1, 'ghost'] },
        [c2]: { ...data.chapters[c2], pieceIds: [p1] },
      },
    }
    const r = repairData(broken)
    expect(r.fixes.length).toBeGreaterThan(0)
    const flat = flatten(r.data, titleId).map((f) => f.pieceId)
    expect(flat).toEqual([p1, p2])
    expect(r.data.chapters[c2].pieceIds).toEqual([])
  })

  it('採用中の稿が存在しない話は採用なしにし、タイトルのないレコードを消す', () => {
    const { data, titleId } = sample()
    const pid = flatten(data, titleId)[0].pieceId
    const broken: AppData = {
      ...data,
      pieces: { ...data.pieces, [pid]: { ...data.pieces[pid], activeVersionId: 'missing', versionIds: ['missing'] } },
      memos: { m1: { id: 'm1', titleId: 'gone', name: 'x', body: '', order: 0, createdAt: 0, updatedAt: 0 } },
    }
    const r = repairData(broken)
    expect(r.data.pieces[pid].activeVersionId).toBeNull()
    expect(r.data.pieces[pid].versionIds).toHaveLength(1)
    expect(r.data.memos).toEqual({})
  })

  it('存在しないタイトルを指すアイデアは「どのタイトルにも属さない」に移り、並べ替えられる', () => {
    let data = emptyData()
    data = addIdea(data, null, 'a').data
    data = addIdea(data, null, 'b').data
    const orphanId = 'orphan'
    data = {
      ...data,
      ideas: {
        ...data.ideas,
        [orphanId]: { id: orphanId, titleId: 'gone', heading: 'o', body: '', order: 0, createdAt: 0, updatedAt: 0 },
      },
    }
    const r = repairData(data)
    expect(r.data.ideas[orphanId].titleId).toBeNull()
    const moved = moveIdeaStep(r.data, orphanId, -1)
    expect(ideaSections(moved)[0].ideas.map((i) => i.heading)).toEqual(['a', 'o', 'b'])
  })
})

describe('壊れたバックアップの修復（項目の欠け）', () => {
  it('どの種類のレコードでも、文字列・数値・配列の欠けを補う', () => {
    const { data, titleId } = sample()
    const pid = flatten(data, titleId)[0].pieceId
    const vid = data.pieces[pid].versionIds[0]
    const chapterId = data.titles[titleId].structure[0].id
    const catId = Object.values(data.settingCategories)[0].id
    const broken = {
      ...data,
      ideas: { i1: { id: 'i1', titleId: null, heading: '思いつき', body: '本文', order: 0 } },
      memos: { m1: { id: 'm1', titleId } },
      versions: { ...data.versions, [vid]: { ...data.versions[vid], name: undefined, note: null } },
      chapters: { ...data.chapters, [chapterId]: { ...data.chapters[chapterId], name: undefined } },
      submissions: { s1: { id: 's1', titleId } },
      settingCategories: { ...data.settingCategories, [catId]: { ...data.settingCategories[catId], name: undefined } },
      settingEntries: { e1: { id: 'e1', titleId, categoryId: catId, fields: [null, { id: 'f', key: 1 }] } },
    } as unknown as AppData
    const r = repairData(broken)
    const d = r.data
    expect(d.ideas.i1).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(d.memos.m1).toMatchObject({ name: '', body: '', order: 0 })
    expect(d.versions[vid]).toMatchObject({ name: '', note: '' })
    expect(d.chapters[chapterId].name).toBe('')
    expect(d.submissions.s1).toMatchObject({ contestName: '', status: 'considering', minChars: null, snapshot: null })
    expect(d.settingCategories[catId].name).toBe('')
    expect(d.settingEntries.e1.fields).toEqual([{ id: 'f', key: '', value: '' }])
    expect(d.settingEntries.e1).toMatchObject({ name: '', body: '' })
  })

  it('存在しない章・話への参照だけが壊れている時も、直した内容を返す', () => {
    const { data, titleId } = sample()
    const broken: AppData = {
      ...data,
      titles: {
        ...data.titles,
        [titleId]: {
          ...data.titles[titleId],
          structure: [...data.titles[titleId].structure, { type: 'piece', id: 'gone' }, { type: 'chapter', id: 'gone2' }],
        },
      },
    }
    const r = repairData(broken)
    expect(r.fixes.length).toBeGreaterThan(0)
    expect(r.data.titles[titleId].structure).toEqual(data.titles[titleId].structure)
  })
})

describe('同期で届いたレコード（キーが並べ替えてある）', () => {
  it('内容が正しければ直したことにせず、同じオブジェクトのまま使う', async () => {
    const { createTitle } = await import('./entityOps')
    const { addEpisode } = await import('./storyOps')
    const { stableStringify } = await import('../sync/merge')
    const t = createTitle(emptyData(), '作品')
    const e = addEpisode(t.data, t.result)
    // クラウドから届いた形（キーの順番が違う）にする
    const sorted = JSON.parse(stableStringify(e.data)) as typeof e.data
    const r = repairData(sorted)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(sorted)
  })
})
