import { afterEach, describe, expect, it, vi } from 'vitest'
import { conflictTrash } from '../sync/conflicts'
import { mergeRemote, TEXT_FIELDS, TEXT_TABLES, type Rec } from '../sync/merge'
import { novel } from '../test/claudeFixture'
import { parseBackup, toBackup } from './backup'
import {
  addBenchAnalysis,
  addBenchWork,
  addTitleBenchWork,
  benchViewpointSuggestions,
  benchWorksOfTitle,
  deleteBenchAnalysis,
  deleteBenchWork,
  moveBenchWorkStep,
  moveBenchWorkTo,
  removeTitleBenchWork,
  sortedBenchWorks,
  titlesComparing,
  updateBenchAnalysis,
  updateBenchWork,
} from './benchOps'
import { createTitle, deleteTitle } from './entityOps'
import { repairData } from './repair'
import { listTrash, restoreTrashEntry, trashContents, TRASH_KIND_LABELS } from './trash'
import { DomainError, emptyData, type AppData, type BenchWork } from './types'

const errorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.message
    throw e
  }
  throw new Error('DomainError が投げられませんでした')
}

/** 時刻を1秒ずつ進めながら操作する（分析の並びが作った時刻で決まるため） */
function clock(start = Date.UTC(2026, 9, 30, 3, 0)) {
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

/** 棚に3作品（A・B・C）と、タイトル2つ */
function shelf() {
  const tick = clock()
  const n = novel(['本文'], { name: '星の庭' })
  const t2 = createTitle(n.data, '風の街')
  let data = t2.data
  const ids: string[] = []
  for (const [name, author] of [
    ['作品A', '著者A'],
    ['作品B', '著者B'],
    ['作品C', ''],
  ]) {
    tick()
    const r = addBenchWork(data, { name, author, pdfPlace: 'プロジェクト「資料」' })
    data = r.data
    ids.push(r.result)
  }
  return { data, ids, titleA: n.titleId, titleB: t2.result, tick }
}

const names = (data: AppData) => sortedBenchWorks(data).map((w) => w.name)

describe('ベンチ作品', () => {
  it('作品名は必須。著者・出版社・刊行年・ジャンル・PDF の置き場所・メモ。空の任意項目は持たない', () => {
    const { data, ids } = shelf()
    expect(names(data)).toEqual(['作品A', '作品B', '作品C'])
    const a = data.benchWorks[ids[0]]
    expect(a).toMatchObject({ name: '作品A', author: '著者A', pdfPlace: 'プロジェクト「資料」', note: '', order: 0 })
    expect('publisher' in a).toBe(false)
    expect(errorOf(() => addBenchWork(data, { name: '  ' }))).toBe('作品名を入れてください')
    expect(errorOf(() => addBenchWork(data, { name: 'あ'.repeat(81) }))).toBe('作品名は80字までにしてください')
    let next = updateBenchWork(data, ids[0], { publisher: '星の出版', year: '2019', genre: 'SF', note: 'メモ' })
    expect(next.benchWorks[ids[0]]).toMatchObject({ publisher: '星の出版', year: '2019', genre: 'SF', note: 'メモ' })
    next = updateBenchWork(next, ids[0], { publisher: '' })
    expect('publisher' in next.benchWorks[ids[0]]).toBe(false)
    // 変わらなければ書かない
    expect(updateBenchWork(next, ids[0], { year: '2019' }).benchWorks).toBe(next.benchWorks)
    expect(errorOf(() => updateBenchWork(next, ids[0], { name: '' }))).toBe('作品名を入れてください')
  })

  it('並べ替え（1つ上・下、位置を選んで移動）', () => {
    const { data, ids } = shelf()
    let next = moveBenchWorkStep(data, ids[2], -1)
    expect(names(next)).toEqual(['作品A', '作品C', '作品B'])
    next = moveBenchWorkTo(next, ids[0], 2)
    expect(names(next)).toEqual(['作品C', '作品B', '作品A'])
    expect(sortedBenchWorks(next).map((w) => w.order)).toEqual([0, 1, 2])
    // 端ではそのまま
    expect(names(moveBenchWorkStep(next, ids[2], -1))).toEqual(['作品C', '作品B', '作品A'])
  })

  it('分析を足す・直す・削除（ゴミ箱へ。戻すと戻る）。観点の候補はすべての作品から、多い順', () => {
    const { data: d0, ids, tick } = shelf()
    let data = d0
    const add = (workId: string, viewpoint: string, body = '本文') => {
      tick()
      const r = addBenchAnalysis(data, workId, { viewpoint, body })
      data = r.data
      return r.result
    }
    const a1 = add(ids[0], '構成', '## 構成\n三幕')
    add(ids[0], '文体')
    add(ids[1], '文体')
    add(ids[1], ' 冒頭の掴み ')
    expect(data.benchAnalyses[a1]).toMatchObject({
      workId: ids[0],
      viewpoint: '構成',
      runDate: '2026-10-30',
      source: 'manual',
      v: 1,
    })
    expect(benchViewpointSuggestions(data)).toEqual(['文体', '構成', '冒頭の掴み'])
    expect(errorOf(() => addBenchAnalysis(data, ids[0], { viewpoint: '' }))).toBe('観点を入れてください（構成・文体・人物など）')
    expect(errorOf(() => addBenchAnalysis(data, ids[0], { viewpoint: 'あ'.repeat(41) }))).toBe('観点は40字までにしてください')
    expect(errorOf(() => addBenchAnalysis(data, 'nope', { viewpoint: '構成' }))).toBe('ベンチ作品が見つかりません')
    data = updateBenchAnalysis(data, a1, { body: '直した', runDate: '2026-10-01' })
    expect(data.benchAnalyses[a1]).toMatchObject({ body: '直した', runDate: '2026-10-01' })
    expect(errorOf(() => updateBenchAnalysis(data, a1, { runDate: '10/1' }))).toBe('日付は YYYY-MM-DD で入れてください')

    data = deleteBenchAnalysis(data, a1)
    expect(data.benchAnalyses[a1]).toBeUndefined()
    const entry = listTrash(data.trashEntries)[0]
    expect(entry).toMatchObject({ kind: 'benchAnalysis', label: '構成（2026-10-01）', parentLabel: '作品A' })
    expect(entry.origin.workId).toBe(ids[0])
    expect(TRASH_KIND_LABELS.benchAnalysis).toBe('ベンチ作品の分析')
    const back = restoreTrashEntry(data, entry.id)
    expect(back.data.benchAnalyses[a1].body).toBe('直した')
    expect(back.result.titleId).toBeNull()
  })

  it('作品の削除は分析といっしょに1件。タイトルは書き換えず（無い間は比べる作品に出ない）、戻すとまた出る', () => {
    const { data: d0, ids, titleA, titleB, tick } = shelf()
    let data = d0
    tick()
    data = addBenchAnalysis(data, ids[1], { viewpoint: '構成', body: 'B の構成' }).data
    data = addBenchAnalysis(data, ids[1], { viewpoint: '人物', body: 'B の人物' }).data
    data = addTitleBenchWork(data, titleA, ids[1])
    data = addTitleBenchWork(data, titleA, ids[0])
    data = addTitleBenchWork(data, titleB, ids[1])
    // 同じ作品をもう一度足しても1つ
    expect(addTitleBenchWork(data, titleA, ids[1]).titles).toBe(data.titles)
    expect(benchWorksOfTitle(data, titleA).map((w) => w.name)).toEqual(['作品B', '作品A'])
    expect(titlesComparing(data, ids[1]).map((t) => t.name)).toEqual(['星の庭', '風の街'])

    const before = data
    data = deleteBenchWork(data, ids[1])
    expect(data.benchWorks[ids[1]]).toBeUndefined()
    expect(Object.values(data.benchAnalyses)).toHaveLength(0)
    // タイトルは書き換えない（ほかの端末でタイトルが削除されても「削除と編集が重なった」控えができないように）
    expect(data.titles).toBe(before.titles)
    // 作品が無い間は、比べる作品に出ない（表示用の修復でも外れる）
    expect(benchWorksOfTitle(data, titleA).map((w) => w.name)).toEqual(['作品A'])
    expect(benchWorksOfTitle(data, titleB)).toEqual([])
    expect(repairData(data).data.titles[titleA].benchWorkIds).toEqual([ids[0]])
    const entry = listTrash(data.trashEntries)[0]
    expect(entry).toMatchObject({ kind: 'benchWork', label: '作品B', titleName: '' })
    expect(entry.origin.titleIds).toEqual([titleA, titleB])
    expect(trashContents(data, entry).map((r) => r.table)).toEqual(['benchWorks', 'benchAnalyses', 'benchAnalyses'])

    // 風の街を削除してから戻す: 棚の元の位置へ。タイトルには id が残っているので書き換えない
    data = deleteTitle(data, titleB)
    const r = restoreTrashEntry(data, entry.id)
    expect(names(r.data)).toEqual(['作品A', '作品B', '作品C'])
    expect(
      Object.values(r.data.benchAnalyses)
        .map((a) => a.viewpoint)
        .sort(),
    ).toEqual(['人物', '構成'].sort())
    expect(r.data.titles).toBe(data.titles)
    expect(benchWorksOfTitle(r.data, titleA).map((w) => w.name)).toEqual(['作品B', '作品A'])
    expect(r.result).toMatchObject({ kind: 'benchWork', titleId: null, copied: false })
    // 風の街も戻すと、比べる作品に作品B
    const t = listTrash(r.data.trashEntries).find((e) => e.kind === 'title')!
    expect(benchWorksOfTitle(restoreTrashEntry(r.data, t.id).data, titleB).map((w) => w.name)).toEqual(['作品B'])
  })

  it('作品 → タイトルの順に削除しても、どちらの順に戻しても比べる作品に戻る（間に読み込み直して、表示用の内容から削除しても）', () => {
    const { data: d0, ids, titleA, tick } = shelf()
    const work = ids[1]
    const seeded = addTitleBenchWork(d0, titleA, work)
    const entryOf = (data: AppData, kind: 'benchWork' | 'title') => listTrash(data.trashEntries).find((e) => e.kind === kind)!.id
    const comparing = (data: AppData) => benchWorksOfTitle(data, titleA).map((w) => w.id)
    // reload: 作品を削除した後に読み込み直す（画面の内容は修復を通したもので、無い作品の id は外れている）
    for (const reload of [false, true]) {
      tick()
      let data = deleteBenchWork(seeded, work)
      if (reload) data = repairData(data).data
      tick()
      data = deleteTitle(data, titleA)
      // 作品 → タイトル
      const workFirst = restoreTrashEntry(data, entryOf(data, 'benchWork')).data
      expect(comparing(restoreTrashEntry(workFirst, entryOf(workFirst, 'title')).data)).toEqual([work])
      // タイトル → 作品
      const titleFirst = restoreTrashEntry(data, entryOf(data, 'title')).data
      expect(comparing(titleFirst)).toEqual([])
      expect(comparing(restoreTrashEntry(titleFirst, entryOf(titleFirst, 'benchWork')).data)).toEqual([work])
    }
    // 読み込み直した画面の内容（タイトルから id が抜けている）で作品を戻すと、タイトルに足し直す
    tick()
    const gone = repairData(deleteBenchWork(seeded, work)).data
    expect(gone.titles[titleA].benchWorkIds).toEqual([])
    const back = restoreTrashEntry(gone, entryOf(gone, 'benchWork')).data
    expect(back.titles[titleA].benchWorkIds).toEqual([work])
  })

  it('作品が無い分析はゴミ箱から戻せない（先に作品を戻す）', () => {
    const { data: d0, ids, tick } = shelf()
    tick()
    let data = addBenchAnalysis(d0, ids[0], { viewpoint: '構成' }).data
    const aid = Object.keys(data.benchAnalyses)[0]
    data = deleteBenchAnalysis(data, aid)
    const analysisEntry = listTrash(data.trashEntries)[0].id
    tick()
    data = deleteBenchWork(data, ids[0])
    expect(errorOf(() => restoreTrashEntry(data, analysisEntry))).toBe(
      '元のベンチ作品がないため戻せません。先にベンチ作品を戻してください。',
    )
    data = restoreTrashEntry(data, listTrash(data.trashEntries)[0].id).data
    expect(restoreTrashEntry(data, analysisEntry).data.benchAnalyses[aid].viewpoint).toBe('構成')
  })

  it('タイトルの比べる作品から外す（作品は棚に残る）。タイトルの削除で作品は消えない', () => {
    const { data: d0, ids, titleA } = shelf()
    let data = addTitleBenchWork(d0, titleA, ids[0])
    data = removeTitleBenchWork(data, titleA, ids[0])
    expect(data.titles[titleA].benchWorkIds).toEqual([])
    expect(removeTitleBenchWork(data, titleA, ids[0]).titles).toBe(data.titles)
    expect(errorOf(() => addTitleBenchWork(data, titleA, 'nope'))).toBe('ベンチ作品が見つかりません')
    data = addTitleBenchWork(data, titleA, ids[0])
    data = deleteTitle(data, titleA)
    expect(names(data)).toEqual(['作品A', '作品B', '作品C'])
  })
})

describe('修復・バックアップ・同期の設定', () => {
  it('修復: 足りない項目を補い、作品の無い分析を見えなくし、比べる作品はある作品だけ（持たないタイトルには足さない）', () => {
    const { data: d0, ids, titleA, titleB } = shelf()
    const data: AppData = {
      ...d0,
      benchWorks: {
        ...d0.benchWorks,
        broken: { id: 'broken', name: 1, extra: 'keep' } as unknown as BenchWork,
      },
      benchAnalyses: {
        orphan: {
          id: 'orphan',
          workId: 'gone',
          viewpoint: '構成',
          body: '',
          runDate: '',
          source: 'claude',
          v: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        ok: { id: 'ok', workId: ids[0], viewpoint: '構成' } as never,
      },
      titles: {
        ...d0.titles,
        [titleA]: { ...d0.titles[titleA], benchWorkIds: [ids[0], 'gone', ids[0], 3 as never] },
      },
    }
    const r = repairData(data)
    expect(r.data.benchWorks.broken).toMatchObject({ name: '', author: '', pdfPlace: '', note: '', order: 0, extra: 'keep' })
    expect(r.data.benchAnalyses.orphan).toBeUndefined()
    expect(r.data.benchAnalyses.ok).toMatchObject({ body: '', runDate: '', source: 'manual', v: 1 })
    expect(r.data.titles[titleA].benchWorkIds).toEqual([ids[0]])
    expect('benchWorkIds' in r.data.titles[titleB]).toBe(false)
    expect(r.fixes).toContain('作品のないベンチ作品の分析を表示から外しました')
    // 直すものが無ければ元のまま
    expect(repairData(d0).data).toBe(d0)
  })

  it('バックアップ: 版 3 でベンチ作品も戻る。版 2（2.4 まで）・版 1 のバックアップも読める（無い表は空）', () => {
    const { data: d0, ids, titleA } = shelf()
    let data = addBenchAnalysis(d0, ids[0], { viewpoint: '構成', body: '分析' }).data
    data = addTitleBenchWork(data, titleA, ids[0])
    const file = toBackup(data)
    expect(file.schemaVersion).toBe(3)
    const back = parseBackup(JSON.stringify(file))
    expect(back.benchWorks).toEqual(data.benchWorks)
    expect(back.benchAnalyses).toEqual(data.benchAnalyses)
    expect(back.titles[titleA].benchWorkIds).toEqual([ids[0]])
    for (const v of [1, 2]) {
      const old = parseBackup(
        JSON.stringify({ app: 'novel-studio', schemaVersion: v, exportedAt: '', data: { titles: d0.titles } }),
      )
      expect(old.benchWorks).toEqual({})
      expect(old.benchAnalyses).toEqual({})
    }
    expect(() => parseBackup(JSON.stringify({ ...file, schemaVersion: 4 }))).toThrow()
  })

  it('同期: メモ・分析の本文は長い文章（両方で変えればつなぐ）、比べる作品は並びとして合わせる', () => {
    expect(TEXT_TABLES.has('benchWorks')).toBe(true)
    expect(TEXT_TABLES.has('benchAnalyses')).toBe(true)
    expect(TEXT_FIELDS.benchWorks).toEqual(['note'])
    expect(TEXT_FIELDS.benchAnalyses).toEqual(['body'])
    const base = { id: 't', name: 'x', benchWorkIds: ['a'] }
    const mine = { id: 't', name: 'x', benchWorkIds: ['a', 'b'] }
    const theirs = { id: 't', name: 'x', benchWorkIds: ['c'] }
    // この端末で b を足し、別の端末で a を外して c を足した（相手が足したものは、相手の並びの直前の要素の後ろ = 先頭）
    expect(mergeRemote('titles', base, mine, theirs, { device: 'iPhone' }).record).toMatchObject({ benchWorkIds: ['c', 'b'] })
    const rec = (v: object) => v as Rec
    const r = mergeRemote(
      'critiqueResults',
      rec({ id: 'r', benchWorkIds: ['a'] }),
      rec({ id: 'r', benchWorkIds: ['a', 'b'] }),
      rec({ id: 'r', benchWorkIds: ['a', 'c'] }),
      { device: 'iPhone' },
    )
    expect(r.record).toMatchObject({ benchWorkIds: ['a', 'c', 'b'] })
    const a = mergeRemote(
      'benchAnalyses',
      rec({ id: 'n', body: '元', viewpoint: '構成' }),
      rec({ id: 'n', body: '元＋この端末', viewpoint: '構成' }),
      rec({ id: 'n', body: '元＋別の端末', viewpoint: '構成' }),
      { device: 'iPhone' },
    )
    expect(a.joined).toEqual(['body'])
    expect((a.record as unknown as { body: string }).body).toContain('同期の競合: iPhoneで同時に書かれた内容')
  })

  it('同期の競合で残す控え: 作品は棚へ、分析は作品へ戻す（作品が無ければ戻せない）', () => {
    const { data: d0, ids, tick } = shelf()
    tick()
    const data = addBenchAnalysis(d0, ids[0], { viewpoint: '人物', body: '人物の分析' }).data
    const aid = Object.keys(data.benchAnalyses)[0]
    let n = 0
    const opts = { now: Date.UTC(2026, 9, 30), newId: () => `id${++n}` }
    const w = conflictTrash(data, 'benchWorks', data.benchWorks[ids[1]] as never, opts)!
    expect(w.entry).toMatchObject({ kind: 'benchWork', label: '作品B', reason: 'conflict' })
    expect(w.entry.origin.index).toBe(1)
    const an = conflictTrash(data, 'benchAnalyses', data.benchAnalyses[aid] as never, opts)!
    expect(an.entry).toMatchObject({ kind: 'benchAnalysis', label: '人物（2026-10-30）', parentLabel: '作品A' })
    expect(an.entry.origin.workId).toBe(ids[0])
    // 同じ id の分析が残っていれば、新しい id の複製として戻す
    const withTrash: AppData = {
      ...data,
      trashEntries: { [an.entry.id]: an.entry },
      trashRecords: Object.fromEntries(an.records.map((r) => [r.id, r])),
    }
    const back = restoreTrashEntry(withTrash, an.entry.id)
    expect(back.result.copied).toBe(true)
    expect(Object.values(back.data.benchAnalyses)).toHaveLength(2)
  })

  it('空のデータにもベンチ作品の表がある', () => {
    expect(emptyData().benchWorks).toEqual({})
    expect(emptyData().benchAnalyses).toEqual({})
  })
})
