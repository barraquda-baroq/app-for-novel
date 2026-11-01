import { describe, expect, it } from 'vitest'
import type { AppData, BenchAnalysis, BenchWork, Title } from '../../domain/types'
import {
  analysesByWork,
  analysisPreview,
  benchShelfEntries,
  biblioLine,
  comparingTitles,
  createdByLabel,
  deleteWorkMessage,
  manuscriptRunOf,
  manuscriptsOf,
  runDateLabel,
  sameManuscriptOf,
  viewpointChips,
  type ShelfEntry,
} from './benchLogic'

const analysis = (id: string, workId: string, viewpoint: string, createdAt: number, runDate = '2026-10-30'): BenchAnalysis => ({
  id,
  workId,
  viewpoint,
  body: `${viewpoint}の分析`,
  runDate,
  source: 'claude',
  v: 1,
  createdAt,
  updatedAt: createdAt,
})

describe('相対比較の表示の計算', () => {
  it('作品を作ったものの札: 英字のあとは空白（「Claude が作成」）、全角の括弧のあとは詰める。手で足した作品は出さない', () => {
    expect(createdByLabel('claude')).toBe('Claude が作成')
    expect(createdByLabel('paste')).toBe('Claude（貼り付け）が作成')
    expect(createdByLabel('manual')).toBeNull()
    expect(createdByLabel(undefined)).toBeNull()
  })

  it('作品ごとの分析は新しい日付から。中身が変わらない作品は前の配列をそのまま使う（カードの React.memo が効く）', () => {
    const a1 = analysis('a1', 'w1', '構成', 1, '2026-10-01')
    const a2 = analysis('a2', 'w1', '文体', 2, '2026-10-20')
    const b1 = analysis('b1', 'w2', '人物', 3)
    const data = { benchAnalyses: { a1, a2, b1 } }
    const first = analysesByWork(data)
    expect(first.get('w1')!.map((a) => a.id)).toEqual(['a2', 'a1'])
    const b2 = analysis('b2', 'w2', '冒頭の掴み', 4)
    const second = analysesByWork({ benchAnalyses: { a1, a2, b1, b2 } }, first)
    expect(second.get('w1')).toBe(first.get('w1'))
    expect(second.get('w2')).not.toBe(first.get('w2'))
    expect(second.get('w2')).toHaveLength(2)
    // 書き換えたら新しい配列
    const third = analysesByWork({ benchAnalyses: { a1: { ...a1, body: '直した' }, a2, b1, b2 } }, second)
    expect(third.get('w1')).not.toBe(second.get('w1'))
  })

  it('観点のチップは観点ごとの数つき（最初に分析した順）', () => {
    expect(viewpointChips([analysis('x', 'w', '構成', 1), analysis('y', 'w', '文体', 2), analysis('z', 'w', '構成', 3)])).toEqual(
      [
        { viewpoint: '構成', count: 2 },
        { viewpoint: '文体', count: 1 },
      ],
    )
  })

  it('比べるタイトル（タイトルの並び順）・書誌・削除の確認文・日付・見本', () => {
    const t = (id: string, name: string, order: number, benchWorkIds?: string[]) =>
      ({ id, name, order, benchWorkIds }) as unknown as Title
    const titles = { a: t('a', '風の街', 1, ['w1']), b: t('b', '星の庭', 0, ['w1', 'w2']), c: t('c', '', 2) } as AppData['titles']
    const c = comparingTitles({ titles })
    expect(c.get('w1')).toEqual({ label: '『星の庭』『風の街』', count: 2 })
    expect(c.get('w2')).toEqual({ label: '『星の庭』', count: 1 })
    expect(biblioLine({ author: '山田', publisher: '', year: '2019', genre: undefined })).toBe('山田・2019')
    expect(deleteWorkMessage(3, 2)).toContain('この作品を相対比較から削除し、分析（3件）もいっしょにゴミ箱に移します。')
    expect(deleteWorkMessage(3, 2)).toContain(
      '相対比較する作品にしているタイトル（2件）では、ゴミ箱にある間は相対比較する作品に出ません（ゴミ箱から戻すと、また出ます）。',
    )
    expect(deleteWorkMessage(0, 0)).toContain('この作品を相対比較から削除し、ゴミ箱に移します。')
    expect(deleteWorkMessage(0, 0)).not.toContain('相対比較する作品')
    expect(runDateLabel('2026-10-30')).toBe('2026/10/30')
    expect(runDateLabel('')).toBe('日付なし')
    expect(analysisPreview('## 構成\n- **三幕**の構成')).toBe('構成 - 三幕の構成')
  })
})

const work = (id: string, name: string, createdAt: number, order = createdAt): BenchWork => ({
  id,
  name,
  author: '',
  pdfPlace: '',
  note: '',
  order,
  createdAt,
  updatedAt: createdAt,
})

describe('自分の原稿の分析（【原稿】…（第n稿…））', () => {
  it('作品名を原稿名と回の札に分ける（最後の括弧だけが札。全角の数字・漢数字も）', () => {
    expect(manuscriptRunOf('【原稿】星の庭（第2稿）')).toEqual({ base: '星の庭', run: '第2稿' })
    expect(manuscriptRunOf('  【原稿】星の庭（第2稿・2回目） ')).toEqual({ base: '星の庭', run: '第2稿・2回目' })
    expect(manuscriptRunOf('【原稿】星の庭（第2稿・2026-11-02 14:05）')).toEqual({
      base: '星の庭',
      run: '第2稿・2026-11-02 14:05',
    })
    expect(manuscriptRunOf('【原稿】星の庭（第２稿）')).toEqual({ base: '星の庭', run: '第２稿' })
    expect(manuscriptRunOf('【原稿】星の庭（第十二稿・再読）')).toEqual({ base: '星の庭', run: '第十二稿・再読' })
    expect(manuscriptRunOf('【原稿】星の庭(第3稿)')).toEqual({ base: '星の庭', run: '第3稿' })
    // 原稿名の括弧はそのまま原稿名に。札の中の括弧も札に
    expect(manuscriptRunOf('【原稿】星の庭（上）（第2稿）')).toEqual({ base: '星の庭（上）', run: '第2稿' })
    expect(manuscriptRunOf('【原稿】海（仮）の記憶 （第1稿・（再）2回目）')).toEqual({
      base: '海（仮）の記憶',
      run: '第1稿・（再）2回目',
    })
    // 分けないもの
    for (const name of [
      '【対照】星の庭（第2稿）',
      '【監査】星の庭（第2稿）',
      '【横断】星の庭（第2稿）',
      '星の庭（第2稿）',
      '【原稿】星の庭',
      '【原稿】星の庭（第2稿）の感想',
      '【原稿】星の庭（上）',
      '【原稿】星の庭（2稿）',
      '【原稿】星の庭（第稿）',
      '【原稿】（第2稿）',
      '【原稿】星の庭（第2稿',
      '【原稿】星の庭第2稿）',
      '',
    ])
      expect(manuscriptRunOf(name), name).toBeNull()
  })

  it('原稿ごとにまとめ、新しい回から（作った時刻。同じなら id の順）。全角と半角・空白の違いは同じ原稿', () => {
    const works = [
      work('a', '【原稿】星の庭（第1稿）', 1),
      work('c', '【原稿】星の庭（第2稿・2回目）', 3),
      work('b', '【原稿】星の庭（第2稿）', 3),
      work('d', '【原稿】 星の庭 （第3稿）', 2),
      work('e', '【原稿】海の記憶（第1稿）', 5),
      work('f', '【対照】星の庭（第1稿）', 6),
      work('g', '銀河の果て', 7),
      work('h', '【原稿】ＡＢＣ（第1稿）', 8),
      work('i', '【原稿】ABC（第2稿）', 9),
    ]
    const m = manuscriptsOf(works)
    expect([...m.keys()]).toEqual(['星の庭', '海の記憶', 'ABC'])
    expect(m.get('星の庭')!.runs.map((r) => [r.work.id, r.run])).toEqual([
      ['b', '第2稿'],
      ['c', '第2稿・2回目'],
      ['d', '第3稿'],
      ['a', '第1稿'],
    ])
    // 原稿名は、いちばん新しい回の書き方
    expect(m.get('ABC')!.base).toBe('ABC')
    expect(m.get('海の記憶')!.runs).toHaveLength(1)

    const benchWorks = Object.fromEntries(works.map((w) => [w.id, w]))
    expect(sameManuscriptOf({ benchWorks }, 'a')!.runs.map((r) => r.work.id)).toEqual(['b', 'c', 'd', 'a'])
    // 1回だけの原稿・【原稿】でない作品・無い作品は null
    expect(sameManuscriptOf({ benchWorks }, 'e')).toBeNull()
    expect(sameManuscriptOf({ benchWorks }, 'f')).toBeNull()
    expect(sameManuscriptOf({ benchWorks }, 'g')).toBeNull()
    expect(sameManuscriptOf({ benchWorks }, 'gone')).toBeNull()
  })

  it('棚: 2回以上の原稿は1枚にまとめ、棚でいちばん前の回の位置に置く。中身が変わらなければ前の配列のまま', () => {
    const shelf = [
      work('x', '銀河の果て', 1, 0),
      work('s1', '【原稿】星の庭（第1稿）', 2, 1),
      work('u1', '【原稿】海の記憶（第1稿）', 3, 2),
      work('y', '【監査】星の庭（第1稿）', 4, 3),
      work('s2', '【原稿】星の庭（第2稿）', 5, 4),
    ]
    const a1 = analysis('a1', 's1', '構成', 1)
    const a2 = analysis('a2', 's2', '構成', 2)
    const byWork = analysesByWork({ benchAnalyses: { a1, a2 } })
    const view = (entries: ShelfEntry[]) =>
      entries.map((e) => (e.kind === 'work' ? e.work.id : `${e.base}:${e.runs.map((r) => r.work.id).join(',')}`))
    const first = benchShelfEntries(shelf, byWork)
    expect(view(first)).toEqual(['x', '星の庭:s2,s1', 'u1', 'y'])
    const group = first[1] as Extract<ShelfEntry, { kind: 'manuscript' }>
    expect(group.runs.map((r) => r.analyses.map((a) => a.id))).toEqual([['a2'], ['a1']])
    expect(group.runs[0].run).toBe('第2稿')

    // 同じ中身なら前の配列。分析が増えた・作品を直した原稿は新しい配列
    const again = benchShelfEntries(shelf, byWork, first)
    expect((again[1] as typeof group).runs).toBe(group.runs)
    const a3 = analysis('a3', 's1', '文体', 3)
    const more = benchShelfEntries(shelf, analysesByWork({ benchAnalyses: { a1, a2, a3 } }, byWork), again)
    expect((more[1] as typeof group).runs).not.toBe(group.runs)
    expect((more[1] as typeof group).runs[1].analyses).toHaveLength(2)

    // 2回目を棚の先頭へ動かすと、まとめたカードも先頭へ。1回だけになれば、ふつうのカード
    const moved = [{ ...shelf[4], order: -1 }, ...shelf.slice(0, 4)]
    expect(view(benchShelfEntries(moved, byWork))).toEqual(['星の庭:s2,s1', 'x', 'u1', 'y'])
    expect(view(benchShelfEntries(shelf.slice(0, 4), byWork))).toEqual(['x', 's1', 'u1', 'y'])
  })
})
