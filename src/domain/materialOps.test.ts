import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NewRecord } from '../claude/records'
import { conflictTrash } from '../sync/conflicts'
import { LIST_FIELDS, mergeRemote, TEXT_FIELDS, TEXT_TABLES, type Rec } from '../sync/merge'
import { novel } from '../test/claudeFixture'
import { parseBackup, toBackup } from './backup'
import { addBenchWork, deleteBenchWork, sortedBenchWorks } from './benchOps'
import { addClaudeRecords } from './claudeOps'
import { deleteTitle } from './entityOps'
import {
  addMaterial,
  addMaterialNote,
  deleteMaterial,
  deleteMaterialNote,
  MATERIAL_LIMITS,
  MATERIAL_SECTIONS,
  materialName,
  materialSectionSuggestions,
  materialTagsInUse,
  moveMaterialStep,
  moveMaterialTo,
  normalizeMaterialTags,
  removeMaterialTag,
  renameMaterialTag,
  sectionKey,
  setMaterialTags,
  sortedMaterials,
  tagKey,
  updateMaterial,
  updateMaterialNote,
} from './materialOps'
import { repairData } from './repair'
import { listTrash, restoreTrashEntry, trashContents, trashLabel, TRASH_KIND_LABELS } from './trash'
import { DomainError, emptyData, type AppData, type Material, type MaterialNote } from './types'

const errorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.message
    throw e
  }
  throw new Error('DomainError が投げられませんでした')
}

/** 時刻を1秒ずつ進めながら操作する（記録の並びが作った時刻で決まるため） */
function clock(start = Date.UTC(2026, 10, 2, 3, 0)) {
  let t = start
  vi.useFakeTimers()
  vi.setSystemTime(t)
  return () => {
    t += 1000
    vi.setSystemTime(t)
    return t
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/** 棚に3つの資料（A・B・C）と、タイトル1つ */
function shelf() {
  const tick = clock()
  const n = novel(['本文'], { name: '星の庭' })
  let data = n.data
  const ids: string[] = []
  for (const [name, author] of [
    ['資料A', '著者A'],
    ['資料B', '著者B'],
    ['資料C', ''],
  ]) {
    tick()
    const r = addMaterial(data, { name, author, pdfPlace: 'プロジェクト「資料」' })
    data = r.data
    ids.push(r.result)
  }
  return { data, ids, titleId: n.titleId, tick }
}

const names = (data: AppData) => sortedMaterials(data).map((m) => m.name)

describe('資料', () => {
  it('資料名は必須。著者・出版社・刊行年・PDF の置き場所・メモ・タグ。空の任意項目は持たない', () => {
    const { data, ids } = shelf()
    expect(names(data)).toEqual(['資料A', '資料B', '資料C'])
    const a = data.materials[ids[0]]
    expect(a).toMatchObject({ name: '資料A', author: '著者A', pdfPlace: 'プロジェクト「資料」', note: '', order: 0 })
    expect('publisher' in a).toBe(false)
    expect('tags' in a).toBe(false)
    expect('field' in a).toBe(false)
    expect('source' in a).toBe(false)
    expect(errorOf(() => addMaterial(data, { name: '  ' }))).toBe('資料名を入れてください')
    expect(errorOf(() => addMaterial(data, { name: 'あ'.repeat(81) }))).toBe('資料名は80字までにしてください')
    expect(errorOf(() => addMaterial(data, { name: '本', author: 'あ'.repeat(81) }))).toBe('著者は80字までにしてください')
    expect(errorOf(() => addMaterial(data, { name: '本', year: '1'.repeat(21) }))).toBe('刊行年は20字までにしてください')
    expect(errorOf(() => addMaterial(data, { name: '本', pdfPlace: 'あ'.repeat(201) }))).toBe(
      'PDF の置き場所は200字までにしてください',
    )
    // 上限は相対比較と同じ値（タグは1つ20字・1つの資料に20個まで）
    expect(MATERIAL_LIMITS).toMatchObject({
      materialName: 80,
      author: 80,
      publisher: 80,
      year: 20,
      pdfPlace: 200,
      tag: 20,
      tags: 20,
    })
    expect('field' in MATERIAL_LIMITS).toBe(false)
    let next = updateMaterial(data, ids[0], { publisher: '星の出版', year: '2019', tags: [' 歴史 '], note: 'メモ' })
    expect(next.materials[ids[0]]).toMatchObject({ publisher: '星の出版', year: '2019', tags: ['歴史'], note: 'メモ' })
    next = updateMaterial(next, ids[0], { publisher: '' })
    expect('publisher' in next.materials[ids[0]]).toBe(false)
    // 変わらなければ書かない
    expect(updateMaterial(next, ids[0], { year: '2019' }).materials).toBe(next.materials)
    expect(errorOf(() => updateMaterial(next, ids[0], { name: '' }))).toBe('資料名を入れてください')
    expect(errorOf(() => updateMaterial(next, 'nope', { name: '本' }))).toBe('資料が見つかりません')
    // 相対比較の棚とは別
    expect(next.benchWorks).toEqual({})
    expect(materialName({ name: '  ' })).toBe('無題の資料')
    expect(materialName({ name: ' 江戸の暮らし ' })).toBe('江戸の暮らし')
  })

  it('並べ替え（1つ上・下、位置を選んで移動）', () => {
    const { data, ids } = shelf()
    let next = moveMaterialStep(data, ids[2], -1)
    expect(names(next)).toEqual(['資料A', '資料C', '資料B'])
    next = moveMaterialTo(next, ids[0], 2)
    expect(names(next)).toEqual(['資料C', '資料B', '資料A'])
    expect(sortedMaterials(next).map((m) => m.order)).toEqual([0, 1, 2])
    // 端ではそのまま
    expect(names(moveMaterialStep(next, ids[2], -1))).toEqual(['資料C', '資料B', '資料A'])
    // 無い資料は何もしない
    expect(moveMaterialTo(next, 'nope', 0).materials).toBe(next.materials)
  })

  it('記録を追加・直す・削除（ゴミ箱へ。戻すと戻る）。項目の候補は決まった4つの後に、ほかの項目を多い順', () => {
    const { data: d0, ids, tick } = shelf()
    let data = d0
    const add = (materialId: string, section: string, body = '本文') => {
      tick()
      const r = addMaterialNote(data, materialId, { section, body })
      data = r.data
      return r.result
    }
    expect(MATERIAL_SECTIONS).toEqual(['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン'])
    // 使ったことが無くても、決まった4つは候補に出る
    expect(materialSectionSuggestions(data)).toEqual([...MATERIAL_SECTIONS])
    const n1 = add(ids[0], '要約', '## 要約\n江戸の町の暮らし')
    add(ids[0], '年表')
    add(ids[1], '年表')
    add(ids[1], ' 人物の一覧 ')
    // 決まった項目と同じ名前（前後の空白・正規化の違い）は重ねない
    add(ids[1], ' サンプルシーン ')
    add(ids[1], 'サンプルシーン'.normalize('NFD'))
    expect(data.materialNotes[n1]).toMatchObject({
      materialId: ids[0],
      section: '要約',
      runDate: '2026-11-02',
      source: 'manual',
      v: 1,
    })
    expect(materialSectionSuggestions(data)).toEqual([...MATERIAL_SECTIONS, '年表', '人物の一覧'])
    expect(sectionKey(' サンプルシーン ')).toBe(sectionKey('サンプルシーン'.normalize('NFD')))
    expect(errorOf(() => addMaterialNote(data, ids[0], { section: '' }))).toBe(
      '項目を入れてください（要約・創作に役立つ知識など）',
    )
    expect(errorOf(() => addMaterialNote(data, ids[0], { section: 'あ'.repeat(41) }))).toBe('項目は40字までにしてください')
    expect(errorOf(() => addMaterialNote(data, 'nope', { section: '要約' }))).toBe('資料が見つかりません')
    expect(errorOf(() => addMaterialNote(data, ids[0], { section: '要約', runDate: '11/2' }))).toBe(
      '日付は YYYY-MM-DD で入れてください',
    )
    data = updateMaterialNote(data, n1, { body: '直した', runDate: '2026-10-01' })
    expect(data.materialNotes[n1]).toMatchObject({ body: '直した', runDate: '2026-10-01' })
    // 変わらなければ書かない
    expect(updateMaterialNote(data, n1, { body: '直した' }).materialNotes).toBe(data.materialNotes)
    expect(errorOf(() => updateMaterialNote(data, n1, { runDate: '10/1' }))).toBe('日付は YYYY-MM-DD で入れてください')
    expect(errorOf(() => updateMaterialNote(data, 'nope', { body: 'x' }))).toBe('資料の記録が見つかりません')

    data = deleteMaterialNote(data, n1)
    expect(data.materialNotes[n1]).toBeUndefined()
    const entry = listTrash(data.trashEntries)[0]
    expect(entry).toMatchObject({ kind: 'materialNote', label: '要約（2026-10-01）', parentLabel: '資料A', titleName: '' })
    expect(entry.origin).toMatchObject({ titleId: null, materialId: ids[0] })
    expect(TRASH_KIND_LABELS.material).toBe('資料')
    expect(TRASH_KIND_LABELS.materialNote).toBe('資料の記録')
    const back = restoreTrashEntry(data, entry.id)
    expect(back.data.materialNotes[n1].body).toBe('直した')
    expect(back.result).toMatchObject({ kind: 'materialNote', titleId: null, copied: false })
    // 無い記録の削除は何もしない
    expect(deleteMaterialNote(data, 'nope').materialNotes).toBe(data.materialNotes)
  })

  it('資料の削除は記録といっしょにゴミ箱の1件。戻すと棚の元の位置へ、記録もいっしょに戻る', () => {
    const { data: d0, ids, titleId, tick } = shelf()
    let data = d0
    tick()
    data = addMaterialNote(data, ids[1], { section: '要約', body: 'B の要約' }).data
    tick()
    data = addMaterialNote(data, ids[1], { section: '描写に使える部分', body: 'B の描写' }).data
    const before = data
    data = deleteMaterial(data, ids[1])
    expect(data.materials[ids[1]]).toBeUndefined()
    expect(Object.values(data.materialNotes)).toHaveLength(0)
    // タイトルは書き換えない
    expect(data.titles).toBe(before.titles)
    const entry = listTrash(data.trashEntries)[0]
    expect(entry).toMatchObject({ kind: 'material', label: '資料B', titleName: '' })
    expect(entry.origin).toMatchObject({ titleId: null, index: 1, prevId: ids[0] })
    expect(trashContents(data, entry).map((r) => r.table)).toEqual(['materials', 'materialNotes', 'materialNotes'])

    // タイトルを削除してから戻しても、資料は棚の元の位置へ
    data = deleteTitle(data, titleId)
    const r = restoreTrashEntry(data, entry.id)
    expect(names(r.data)).toEqual(['資料A', '資料B', '資料C'])
    expect(
      Object.values(r.data.materialNotes)
        .map((n) => n.section)
        .sort(),
    ).toEqual(['描写に使える部分', '要約'].sort())
    expect(r.result).toMatchObject({ kind: 'material', titleId: null, copied: false })
    // 無い資料の削除は何もしない
    expect(deleteMaterial(data, 'nope').materials).toBe(data.materials)
  })

  it('資料が無い記録はゴミ箱から戻せない（先に資料を戻す）', () => {
    const { data: d0, ids, tick } = shelf()
    tick()
    let data = addMaterialNote(d0, ids[0], { section: '要約' }).data
    const nid = Object.keys(data.materialNotes)[0]
    data = deleteMaterialNote(data, nid)
    const noteEntry = listTrash(data.trashEntries)[0].id
    tick()
    data = deleteMaterial(data, ids[0])
    expect(errorOf(() => restoreTrashEntry(data, noteEntry))).toBe('元の資料がないため戻せません。先に資料を戻してください。')
    data = restoreTrashEntry(data, listTrash(data.trashEntries)[0].id).data
    expect(restoreTrashEntry(data, noteEntry).data.materialNotes[nid].section).toBe('要約')
  })

  it('タイトルの削除で資料は消えない。相対比較の作品の削除とも関わらない', () => {
    const { data: d0, ids, titleId, tick } = shelf()
    let data = addBenchWork(d0, { name: '資料A' }).data
    const workId = sortedBenchWorks(data)[0].id
    tick()
    data = deleteTitle(data, titleId)
    tick()
    data = deleteBenchWork(data, workId)
    expect(names(data)).toEqual(['資料A', '資料B', '資料C'])
    tick()
    data = deleteMaterial(data, ids[0])
    expect(listTrash(data.trashEntries).map((e) => e.kind)).toEqual(['material', 'benchWork', 'title'])
  })

  it('ゴミ箱の一覧の名前（空なら「無題の資料」「項目なし」）', () => {
    expect(trashLabel.material({ name: ' ' })).toBe('無題の資料')
    expect(trashLabel.materialNote({ section: ' ', runDate: '' })).toBe('項目なし')
    expect(trashLabel.materialNote({ section: 'サンプルシーン', runDate: '2026-11-02' })).toBe('サンプルシーン（2026-11-02）')
  })

  it('Claude の記録として入れる: 資料を先に、記録は資料がある時だけ。もうある・以前に削除したものは入れない', () => {
    const { data: d0, ids } = shelf()
    const material: Material = {
      id: 'cd-claude',
      name: '武器の事典',
      author: '著者D',
      pdfPlace: '',
      note: '',
      order: 3,
      createdAt: 1,
      updatedAt: 1,
      source: 'claude',
    }
    const note = (id: string, materialId: string): MaterialNote => ({
      id,
      materialId,
      section: '要約',
      body: '要約の本文',
      runDate: '2026-11-02',
      source: 'claude',
      v: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const records: NewRecord[] = [
      { table: 'materials', record: material },
      { table: 'materialNotes', record: note('ck-1', material.id) },
      { table: 'materialNotes', record: note('ck-2', ids[0]) },
      { table: 'materialNotes', record: note('ck-3', 'gone') },
    ]
    const r = addClaudeRecords(d0, records)
    expect(r.result).toEqual(['cd-claude', 'ck-1', 'ck-2'])
    expect(r.data.materials['cd-claude']).toEqual(material)
    expect(r.data.materialNotes['ck-3']).toBeUndefined()
    // 2回目は何も入れない
    expect(addClaudeRecords(r.data, records).result).toEqual([])
    // 削除した記録は入れ直さない
    const deleted = deleteMaterialNote(r.data, 'ck-1')
    expect(addClaudeRecords(deleted, records).result).toEqual([])
  })
})

describe('タグ（作者が付けて管理する）', () => {
  /** 資料A〜C にタグを付けた棚 */
  function tagged() {
    const s = shelf()
    let data = setMaterialTags(s.data, s.ids[0], ['ミリタリ', '現代', '戦闘'])
    data = setMaterialTags(data, s.ids[1], ['現代', 'ミリタリー'])
    data = setMaterialTags(data, s.ids[2], ['歴史', '戦闘'])
    return { ...s, data }
  }
  const tagsOf = (data: AppData, id: string) => data.materials[id].tags

  it('付ける: 付けた順のまま、前後の空白を除き、空のもの・refKey が同じもの（全角と半角・空白の違い）の2つ目からは除く', () => {
    const { data: d0, ids, tick } = shelf()
    tick()
    const data = setMaterialTags(d0, ids[0], [' ミリタリ ', '', '現代', 'ﾐﾘﾀﾘ', '特殊　部隊', '特殊 部隊', '  '])
    expect(tagsOf(data, ids[0])).toEqual(['ミリタリ', '現代', '特殊　部隊'])
    expect(data.materials[ids[0]].updatedAt).toBeGreaterThan(d0.materials[ids[0]].updatedAt)
    // ほかの資料・ほかの項目は変えない
    expect(data.materials[ids[1]]).toBe(d0.materials[ids[1]])
    expect(data.materials[ids[0]]).toMatchObject({ name: '資料A', author: '著者A', pdfPlace: 'プロジェクト「資料」' })
    // 変わらなければ書かない
    expect(setMaterialTags(data, ids[0], ['ミリタリ', '現代', '特殊　部隊']).materials).toBe(data.materials)
    // 並べ替えも付け直し
    expect(tagsOf(setMaterialTags(data, ids[0], ['現代', 'ミリタリ']), ids[0])).toEqual(['現代', 'ミリタリ'])
    // 空にすればタグなし（項目ごと持たない）
    const none = setMaterialTags(data, ids[0], [' '])
    expect('tags' in none.materials[ids[0]]).toBe(false)
    // 追加の時にも付けられる
    const added = addMaterial(data, { name: '現代の特殊部隊', tags: ['ミリタリ', '現代', '戦闘', '現代'] })
    expect(added.data.materials[added.result].tags).toEqual(['ミリタリ', '現代', '戦闘'])
    expect(tagKey(' ＳＦ　小説 ')).toBe(tagKey('SF 小説'))
  })

  it('上限: タグ1つは20字まで、1つの資料に20個まで（重なりを除いた後で数える）', () => {
    const { data, ids } = shelf()
    expect(errorOf(() => setMaterialTags(data, ids[0], ['あ'.repeat(21)]))).toBe('タグは20字までにしてください')
    expect(tagsOf(setMaterialTags(data, ids[0], ['あ'.repeat(20)]), ids[0])).toEqual(['あ'.repeat(20)])
    const many = Array.from({ length: 20 }, (_, i) => `タグ${i + 1}`)
    expect(tagsOf(setMaterialTags(data, ids[0], [...many, 'タグ1', ' タグ2 ']), ids[0])).toEqual(many)
    expect(errorOf(() => setMaterialTags(data, ids[0], [...many, 'タグ21']))).toBe('タグは1つの資料に20個までにしてください')
    expect(errorOf(() => addMaterial(data, { name: '本', tags: [...many, 'タグ21'] }))).toBe(
      'タグは1つの資料に20個までにしてください',
    )
    expect(errorOf(() => setMaterialTags(data, 'nope', ['現代']))).toBe('資料が見つかりません')
    expect(normalizeMaterialTags([' a ', 'ａ', 'b', 'A'])).toEqual(['a', 'b', 'A'])
  })

  it('使っているタグ: 資料の数の多い順、同じなら名前の順（refKey が同じものは1つに数え、書き方は棚で先に出る資料のまま）', () => {
    const { data } = tagged()
    expect(materialTagsInUse(data)).toEqual([
      { tag: '現代', count: 2 },
      { tag: '戦闘', count: 2 },
      { tag: 'ミリタリ', count: 1 },
      { tag: 'ミリタリー', count: 1 },
      { tag: '歴史', count: 1 },
    ])
    // 全角と半角の違いは同じタグ（棚で先に出る資料の書き方）
    const s = shelf()
    let d = setMaterialTags(s.data, s.ids[0], ['ＳＦ'])
    d = setMaterialTags(d, s.ids[1], ['SF'])
    expect(materialTagsInUse(d)).toEqual([{ tag: 'ＳＦ', count: 2 }])
    expect(materialTagsInUse(s.data)).toEqual([])
  })

  it('名前を変える: すべての資料で付け替え、付け替えた先と重なれば1つにする（先に付いていた位置のまま）', () => {
    const { data, ids, tick } = tagged()
    tick()
    const r = renameMaterialTag(data, 'ミリタリー', 'ミリタリ')
    expect(r.result).toBe(1)
    expect(tagsOf(r.data, ids[1])).toEqual(['現代', 'ミリタリ'])
    expect(r.data.materials[ids[1]].updatedAt).toBeGreaterThan(data.materials[ids[1]].updatedAt)
    // 付いていない資料は書き換えない
    expect(r.data.materials[ids[0]]).toBe(data.materials[ids[0]])
    expect(r.data.materials[ids[2]]).toBe(data.materials[ids[2]])
    // 重なる: 資料A は「ミリタリ」「現代」を持つ。「現代」を「ミリタリ」にすると1つになる
    const merged = renameMaterialTag(r.data, ' 現代 ', 'ミリタリ')
    expect(merged.result).toBe(2)
    expect(tagsOf(merged.data, ids[0])).toEqual(['ミリタリ', '戦闘'])
    expect(tagsOf(merged.data, ids[1])).toEqual(['ミリタリ'])
    // 書き方だけを変える（全角と半角の違いは同じタグとして照らす）
    const s = shelf()
    const sf = setMaterialTags(setMaterialTags(s.data, s.ids[0], ['ＳＦ', '宇宙']), s.ids[1], ['SF'])
    const fixed = renameMaterialTag(sf, 'SF', 'SF')
    expect(fixed.result).toBe(1)
    expect(tagsOf(fixed.data, s.ids[0])).toEqual(['SF', '宇宙'])
    expect(fixed.data.materials[s.ids[1]]).toBe(sf.materials[s.ids[1]])
    // 無いタグ・同じ名前は何もしない
    expect(renameMaterialTag(data, '料理', '和食')).toMatchObject({ result: 0 })
    expect(renameMaterialTag(data, '料理', '和食').data.materials).toBe(data.materials)
    expect(renameMaterialTag(data, '現代', '現代').data.materials).toBe(data.materials)
    expect(errorOf(() => renameMaterialTag(data, '現代', ' '))).toBe('タグの名前を入れてください')
    expect(errorOf(() => renameMaterialTag(data, '現代', 'あ'.repeat(21)))).toBe('タグは20字までにしてください')
  })

  it('削除: すべての資料から外す（最後のタグを外した資料はタグなし）', () => {
    const { data, ids } = tagged()
    const r = removeMaterialTag(data, '戦闘')
    expect(r.result).toBe(2)
    expect(tagsOf(r.data, ids[0])).toEqual(['ミリタリ', '現代'])
    expect(tagsOf(r.data, ids[2])).toEqual(['歴史'])
    expect(r.data.materials[ids[1]]).toBe(data.materials[ids[1]])
    const last = removeMaterialTag(r.data, ' 歴史 ')
    expect('tags' in last.data.materials[ids[2]]).toBe(false)
    expect(materialTagsInUse(last.data).map((t) => t.tag)).not.toContain('戦闘')
    expect(removeMaterialTag(data, '料理').data.materials).toBe(data.materials)
    expect(removeMaterialTag(data, ' ').result).toBe(0)
    // 削除した資料のタグは数えない
    expect(materialTagsInUse(deleteMaterial(data, ids[2])).find((t) => t.tag === '歴史')).toBeUndefined()
  })
})

describe('修復・バックアップ・同期の設定', () => {
  it('修復: 足りない項目を補い（知らない項目は残す）、資料の無い記録を見えなくする', () => {
    const { data: d0, ids } = shelf()
    const data: AppData = {
      ...d0,
      materials: {
        ...d0.materials,
        broken: { id: 'broken', name: 1, tags: 3, source: 'robot', extra: 'keep' } as unknown as Material,
        tagged: {
          ...d0.materials[ids[1]],
          id: 'tagged',
          tags: [' 現代 ', 'ミリタリ', '', 5, 'ﾐﾘﾀﾘ', 'あ'.repeat(21), ...Array.from({ length: 25 }, (_, i) => `t${i}`)],
        } as unknown as Material,
        clean: { ...d0.materials[ids[2]], id: 'clean', tags: ['戦闘', '現代'] },
      },
      materialNotes: {
        orphan: {
          id: 'orphan',
          materialId: 'gone',
          section: '要約',
          body: '',
          runDate: '',
          source: 'claude',
          v: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        ok: { id: 'ok', materialId: ids[0], section: '要約', model: 5 } as never,
      },
    }
    const r = repairData(data)
    expect(r.data.materials.broken).toMatchObject({ name: '', author: '', pdfPlace: '', note: '', order: 0, extra: 'keep' })
    expect('source' in r.data.materials.broken).toBe(false)
    // タグは文字列の配列だけ（形が違えば外す）。空・重なり（refKey が同じもの）・20字を超えるもの・21個目からは表示から外す
    expect('tags' in r.data.materials.broken).toBe(false)
    expect(r.data.materials.tagged.tags).toEqual(['現代', 'ミリタリ', ...Array.from({ length: 18 }, (_, i) => `t${i}`)])
    expect(r.data.materials.clean).toBe(data.materials.clean)
    expect(r.data.materialNotes.orphan).toBeUndefined()
    expect(r.data.materialNotes.ok).toMatchObject({ body: '', runDate: '', source: 'manual', v: 1 })
    expect('model' in r.data.materialNotes.ok).toBe(false)
    expect(r.fixes).toContain('資料の項目を補いました')
    expect(r.fixes).toContain('資料のない資料の記録を表示から外しました')
    expect(r.fixes).toContain('資料の記録の項目を補いました')
    // 直すものが無ければ元のまま
    expect(repairData(d0).data).toBe(d0)
  })

  it('バックアップ: 版 5 で資料も戻る。版 4（2.6〜2.8）の資料も戻り、版 3（2.5）・版 2・版 1 のバックアップも読める（無い表は空）', () => {
    const { data: d0, ids } = shelf()
    const data = addMaterialNote(d0, ids[0], { section: '要約', body: '要約' }).data
    const file = toBackup(data)
    expect(file.schemaVersion).toBe(5)
    const back = parseBackup(JSON.stringify(file))
    expect(back.materials).toEqual(data.materials)
    expect(back.materialNotes).toEqual(data.materialNotes)
    expect(parseBackup(JSON.stringify({ ...file, schemaVersion: 4 })).materialNotes).toEqual(data.materialNotes)
    for (const v of [1, 2, 3]) {
      const old = parseBackup(
        JSON.stringify({ app: 'novel-studio', schemaVersion: v, exportedAt: '', data: { titles: d0.titles } }),
      )
      expect(old.materials).toEqual({})
      expect(old.materialNotes).toEqual({})
      expect(Object.keys(old.titles)).toHaveLength(1)
    }
    expect(() => parseBackup(JSON.stringify({ ...file, schemaVersion: 6 }))).toThrow()
    expect(() =>
      parseBackup(JSON.stringify({ ...file, data: { ...file.data, materials: [] as unknown as AppData['materials'] } })),
    ).toThrow('バックアップの materials が壊れています')
  })

  it('同期: タグは並びとして合わせる（2台で別々に付けても両方残り、片方で外せば外れる）', () => {
    expect(LIST_FIELDS.materials).toEqual({ tags: expect.any(Function) })
    const rec = (v: object) => v as Rec
    const merge = (base: object, mine: object, theirs: object) =>
      mergeRemote(
        'materials',
        rec({ id: 'd', name: '本', ...base }),
        rec({ id: 'd', name: '本', ...mine }),
        rec({ id: 'd', name: '本', ...theirs }),
        {
          device: 'iPhone',
        },
      ).record as unknown as Material
    // この端末で「戦闘」を足し、別の端末で「現代」を外して「特殊部隊」を足した
    expect(
      merge({ tags: ['ミリタリ', '現代'] }, { tags: ['ミリタリ', '現代', '戦闘'] }, { tags: ['ミリタリ', '特殊部隊'] }).tags,
    ).toEqual(['ミリタリ', '特殊部隊', '戦闘'])
    // タグの無かった資料に、2台で別々に付けた（相手が足したものは、相手の並びの直前の要素の後ろ = 先頭）
    expect(merge({}, { tags: ['ミリタリ'] }, { tags: ['現代'] }).tags).toEqual(['現代', 'ミリタリ'])
    // この端末ですべて外し（項目ごと無くなる）、別の端末で足した
    expect(merge({ tags: ['ミリタリ'] }, {}, { tags: ['ミリタリ', '現代'] }).tags).toEqual(['現代'])
    // 片方だけが変えた
    expect(merge({ tags: ['ミリタリ'] }, { tags: ['ミリタリ'] }, { tags: ['現代'] }).tags).toEqual(['現代'])
    expect('tags' in merge({ tags: ['ミリタリ'] }, {}, { tags: ['ミリタリ'] })).toBe(false)
    // 共通の履歴が無い時は、クラウドの並びに、この端末にしか無いタグを足す（この端末の並びでの直前の要素の後ろ = 先頭）
    const unrelated = mergeRemote(
      'materials',
      null,
      rec({ id: 'd', name: '本', tags: ['戦闘', '現代'] }),
      rec({ id: 'd', name: '本', tags: ['現代'] }),
      {
        device: 'iPhone',
        noHistory: true,
      },
    ).record as unknown as Material
    expect(unrelated.tags).toEqual(['戦闘', '現代'])
  })

  it('同期: メモ・記録の本文は長い文章（両方で変えればつなぐ）、資料名などの短い項目は項目ごとに合わせる', () => {
    expect(TEXT_TABLES.has('materials')).toBe(true)
    expect(TEXT_TABLES.has('materialNotes')).toBe(true)
    expect(TEXT_FIELDS.materials).toEqual(['note'])
    expect(TEXT_FIELDS.materialNotes).toEqual(['body'])
    const rec = (v: object) => v as Rec
    const n = mergeRemote(
      'materialNotes',
      rec({ id: 'k', body: '元', section: '要約' }),
      rec({ id: 'k', body: '元＋この端末', section: '要約' }),
      rec({ id: 'k', body: '元＋別の端末', section: '要約' }),
      { device: 'iPhone' },
    )
    expect(n.joined).toEqual(['body'])
    expect((n.record as unknown as { body: string }).body).toContain('同期の競合: iPhoneで同時に書かれた内容')
    const m = mergeRemote(
      'materials',
      rec({ id: 'd', name: '元', author: '', note: 'メモ' }),
      rec({ id: 'd', name: '元', author: '著者', note: 'メモ＋この端末' }),
      rec({ id: 'd', name: '新しい名前', author: '', note: 'メモ＋別の端末' }),
      { device: 'iPhone' },
    )
    expect(m.record).toMatchObject({ name: '新しい名前', author: '著者' })
    expect(m.joined).toEqual(['note'])
  })

  it('同期の競合で残す控え: 資料は棚へ、記録は資料へ戻す（同じ id が残っていれば新しい id の複製として）', () => {
    const { data: d0, ids, tick } = shelf()
    tick()
    const data = addMaterialNote(d0, ids[0], { section: '描写に使える部分', body: '描写' }).data
    const nid = Object.keys(data.materialNotes)[0]
    let n = 0
    const opts = { now: Date.UTC(2026, 10, 2), newId: () => `id${++n}` }
    const m = conflictTrash(data, 'materials', data.materials[ids[1]] as never, opts)!
    expect(m.entry).toMatchObject({ kind: 'material', label: '資料B', reason: 'conflict', titleName: '' })
    expect(m.entry.origin).toMatchObject({ titleId: null, index: 1 })
    const k = conflictTrash(data, 'materialNotes', data.materialNotes[nid] as never, opts)!
    expect(k.entry).toMatchObject({ kind: 'materialNote', label: '描写に使える部分（2026-11-02）', parentLabel: '資料A' })
    expect(k.entry.origin).toMatchObject({ titleId: null, materialId: ids[0] })
    // 同じ id の記録が残っていれば、新しい id の複製として戻す
    const withTrash: AppData = {
      ...data,
      trashEntries: { [k.entry.id]: k.entry, [m.entry.id]: m.entry },
      trashRecords: Object.fromEntries([...k.records, ...m.records].map((r) => [r.id, r])),
    }
    const back = restoreTrashEntry(withTrash, k.entry.id)
    expect(back.result.copied).toBe(true)
    expect(Object.values(back.data.materialNotes)).toHaveLength(2)
    // 資料も複製として棚へ
    const copy = restoreTrashEntry(withTrash, m.entry.id)
    expect(copy.result.copied).toBe(true)
    expect(names(copy.data)).toEqual(['資料A', '資料B', '資料B', '資料C'])
  })

  it('空のデータにも資料の表がある', () => {
    expect(emptyData().materials).toEqual({})
    expect(emptyData().materialNotes).toEqual({})
  })
})
