import { describe, expect, it } from 'vitest'
import { moveMaterialTo } from '../../domain/materialOps'
import { emptyData, type Material, type MaterialNote } from '../../domain/types'
import { tagKey } from '../../domain/materialOps'
import {
  addTags,
  biblioLine,
  deleteMaterialMessage,
  filterCountLabel,
  filterMaterials,
  hasTagSeparator,
  isFiltering,
  materialCreatedBy,
  materialLastUpdated,
  materialName,
  materialSearchKey,
  materialTagKeys,
  materialTags,
  noteDateLabel,
  noteGroups,
  notePreview,
  notesByMaterial,
  searchTerms,
  sectionChips,
  splitTagInput,
  tagChips,
  tagSuggestions,
  toggleTag,
  visibleStepTarget,
} from './materialLogic'

const note = (id: string, materialId: string, section: string, createdAt: number, runDate = '2026-11-01'): MaterialNote => ({
  id,
  materialId,
  section,
  body: `${section}の記録`,
  runDate,
  source: 'claude',
  v: 1,
  createdAt,
  updatedAt: createdAt,
})

const material = (id: string, name: string, order: number, extra: Partial<Material> = {}): Material => ({
  id,
  name,
  author: '',
  pdfPlace: '',
  note: '',
  order,
  createdAt: order,
  updatedAt: order,
  ...extra,
})

describe('資料の表示の計算', () => {
  it('名前・書誌・札・日付・見本・最終更新（相対比較と同じ表記）', () => {
    expect(materialName({ name: '  ' })).toBe('無題の資料')
    // 書誌は著者・出版社・刊行年（タグは別に出す）
    expect(biblioLine(material('a', '江戸の町', 0, { author: '山田', publisher: '', year: '2019', tags: ['歴史'] }))).toBe(
      '山田・2019',
    )
    expect(materialTags(material('a', '江戸の町', 0, { tags: ['歴史', ' ', ' 江戸 '] }))).toEqual(['歴史', '江戸'])
    expect(materialTags(material('a', '江戸の町', 0))).toEqual([])
    expect(materialCreatedBy('claude')).toBe('Claude が作成')
    expect(materialCreatedBy('paste')).toBe('Claude（貼り付け）が作成')
    expect(materialCreatedBy(undefined)).toBeNull()
    expect(noteDateLabel('2026-11-02')).toBe('2026/11/02')
    expect(noteDateLabel('')).toBe('日付なし')
    expect(notePreview('## 要約\n- **第1章**は町の成り立ち')).toBe('要約 - 第1章は町の成り立ち')
    expect(materialLastUpdated({ updatedAt: 5 }, [{ updatedAt: 3 }, { updatedAt: 9 }])).toBe(9)
    expect(materialLastUpdated({ updatedAt: 5 }, [])).toBe(5)
  })

  it('資料ごとの記録は新しい日付から。中身が変わらない資料は前の配列をそのまま使う（カードの React.memo が効く）', () => {
    const a1 = note('a1', 'm1', '要約', 1, '2026-10-01')
    const a2 = note('a2', 'm1', '創作に役立つ知識', 2, '2026-10-20')
    const b1 = note('b1', 'm2', '要約', 3)
    const first = notesByMaterial({ materialNotes: { a1, a2, b1 } })
    expect(first.get('m1')!.map((n) => n.id)).toEqual(['a2', 'a1'])
    const b2 = note('b2', 'm2', 'サンプルシーン', 4)
    const second = notesByMaterial({ materialNotes: { a1, a2, b1, b2 } }, first)
    expect(second.get('m1')).toBe(first.get('m1'))
    expect(second.get('m2')).not.toBe(first.get('m2'))
    expect(second.get('m2')).toHaveLength(2)
    const third = notesByMaterial({ materialNotes: { a1: { ...a1, body: '直した' }, a2, b1, b2 } }, second)
    expect(third.get('m1')).not.toBe(second.get('m1'))
  })

  it('項目のチップは決まった4つの順、その後にほかの項目を最初に記録した順（数つき）', () => {
    const notes = [
      note('x', 'm', '年表', 1),
      note('y', 'm', 'サンプルシーン', 2),
      note('z', 'm', '要約', 3),
      note('w', 'm', ' 要約 ', 4),
      note('v', 'm', '用語集', 5),
    ]
    expect(sectionChips(notes)).toEqual([
      { section: '要約', count: 2 },
      { section: 'サンプルシーン', count: 1 },
      { section: '年表', count: 1 },
      { section: '用語集', count: 1 },
    ])
  })

  it('資料の画面の項目: 記録があれば決まった4つはまだ無くても順に出し（空）、ほかの項目は後ろ。記録が無ければ空', () => {
    expect(noteGroups([])).toEqual([])
    const groups = noteGroups([note('a', 'm', '年表', 1), note('b', 'm', '創作に役立つ知識', 2), note('c', 'm', '要約', 3)])
    expect(groups.map((g) => [g.section, g.items.map((n) => n.id), g.fixed])).toEqual([
      ['要約', ['c'], true],
      ['創作に役立つ知識', ['b'], true],
      ['描写に使える部分', [], true],
      ['サンプルシーン', [], true],
      ['年表', ['a'], false],
    ])
  })

  it('削除の確認文: 記録の数と、PDF は消えないこと', () => {
    expect(deleteMaterialMessage(3)).toContain('この資料を資料の棚から削除し、記録（3件）もいっしょにゴミ箱に移します。')
    expect(deleteMaterialMessage(3)).toContain('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
    expect(deleteMaterialMessage(0)).toContain('この資料を資料の棚から削除し、ゴミ箱に移します。')
  })
})

describe('資料の棚の検索・タグのチップ', () => {
  const shelf = [
    material('a', '江戸の町と暮らし', 0, { author: '山田 太郎', tags: ['歴史', '江戸'], note: '長屋の間取りが詳しい' }),
    material('b', '外科の歴史', 1, { author: '佐藤', tags: ['医療'] }),
    material('c', 'ＳＷＯＲＤ　図鑑', 2, { author: 'Smith', tags: ['武器', 'ミリタリ'] }),
    material('d', '和食の基本', 3, { author: '鈴木', tags: ['料理'], note: '出汁の取り方' }),
    material('e', '戦国の城', 4, { author: '田中', tags: [' 歴史 ', '戦闘', 'ミリタリ'] }),
    material('f', 'タグなし', 5, { author: '高橋' }),
  ]
  const ids = (list: Material[]) => list.map((m) => m.id)
  const keys = (...tags: string[]) => tags.map(tagKey)

  it('資料名・著者・タグ・メモの部分一致。全角と半角・空白・英字の大文字と小文字の違いは問わない。語はすべて含むものだけ', () => {
    const q = (query: string) => ids(filterMaterials(shelf, { query, tags: [] }))
    expect(q('')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(q('   ')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(q('江戸')).toEqual(['a'])
    // タグ・著者・メモ
    expect(q('歴史')).toEqual(['a', 'b', 'e'])
    expect(q('ミリ')).toEqual(['c', 'e'])
    expect(q('佐藤')).toEqual(['b'])
    expect(q('出汁')).toEqual(['d'])
    // 全角と半角・大文字と小文字・続く空白
    expect(q('sword')).toEqual(['c'])
    expect(q('ｓｍｉｔｈ')).toEqual(['c'])
    expect(q('sword 図鑑')).toEqual(['c'])
    expect(q('山田　太郎')).toEqual(['a'])
    // 語はすべて含むもの（どの項目にあってもよい）
    expect(q('歴史 長屋')).toEqual(['a'])
    expect(q('歴史 出汁')).toEqual([])
    expect(searchTerms('  江戸　 長屋 ')).toEqual(['江戸', '長屋'])
    // 項目・タグをまたいでは一致しない
    expect(materialSearchKey(shelf[1])).toContain('\u0000')
    expect(q('歴史佐藤')).toEqual([])
    expect(q('歴史江戸')).toEqual([])
  })

  it('タグのチップ: 使っているタグだけ（資料の数の多い順、同じなら名前の順。全角と半角の違いは同じタグで、書き方は棚で先に出る資料のまま）', () => {
    const data = { materials: Object.fromEntries(shelf.map((m) => [m.id, m])) }
    expect(tagChips(data)).toEqual([
      { key: 'ミリタリ', tag: 'ミリタリ', count: 2 },
      { key: '歴史', tag: '歴史', count: 2 },
      { key: '医療', tag: '医療', count: 1 },
      { key: '江戸', tag: '江戸', count: 1 },
      { key: '戦闘', tag: '戦闘', count: 1 },
      { key: '武器', tag: '武器', count: 1 },
      { key: '料理', tag: '料理', count: 1 },
    ])
    const sf = { x: material('x', 'x', 0, { tags: ['ＳＦ'] }), y: material('y', 'y', 1, { tags: ['SF'] }) }
    expect(tagChips({ materials: sf })).toEqual([{ key: 'SF', tag: 'ＳＦ', count: 2 }])
    expect(tagChips({ materials: { f: shelf[5] } })).toEqual([])
    expect([...materialTagKeys(shelf[4])]).toEqual(['歴史', '戦闘', 'ミリタリ'])
    // 同じ資料のレコードなら作り直さない
    expect(materialTagKeys(shelf[4])).toBe(materialTagKeys(shelf[4]))
  })

  it('タグで絞る: 選んだタグをすべて持つ資料だけ（検索の語と合わせて）・選ぶ／外す・絞り込んでいるか・件数の表記', () => {
    const f = (query: string, ...tags: string[]) => ids(filterMaterials(shelf, { query, tags: keys(...tags) }))
    expect(f('', '歴史')).toEqual(['a', 'e'])
    expect(f('', 'ミリタリ')).toEqual(['c', 'e'])
    // いくつか選ぶと、すべてのタグを持つ資料だけ
    expect(f('', '歴史', 'ミリタリ')).toEqual(['e'])
    expect(f('', '歴史', '医療')).toEqual([])
    expect(f('城', '歴史')).toEqual(['e'])
    expect(f('外科', '歴史')).toEqual([])
    // 全角と半角の違いは同じタグ
    expect(ids(filterMaterials([material('x', 'x', 0, { tags: ['ＳＦ'] })], { query: '', tags: [tagKey('SF')] }))).toEqual(['x'])
    expect(toggleTag([], '歴史')).toEqual(['歴史'])
    expect(toggleTag(['歴史'], 'ミリタリ')).toEqual(['歴史', 'ミリタリ'])
    expect(toggleTag(['歴史', 'ミリタリ'], '歴史')).toEqual(['ミリタリ'])
    expect(isFiltering({ query: ' ', tags: [] })).toBe(false)
    expect(isFiltering({ query: '江戸', tags: [] })).toBe(true)
    expect(isFiltering({ query: '', tags: ['歴史'] })).toBe(true)
    expect(filterCountLabel(3, 120)).toBe('3件／全120件')
  })

  it('タグの入力: 「、」「,」で区切り、空のもの・もう付いているものは足さない。20字・20個を超える分は足さずに理由を返す。候補は使っているタグから', () => {
    expect(splitTagInput('ミリタリ、現代、戦')).toEqual({ done: ['ミリタリ', '現代'], rest: '戦' })
    expect(splitTagInput('a,b，c､ d ,')).toEqual({ done: ['a', 'b', 'c', 'd'], rest: '' })
    expect(splitTagInput('現代')).toEqual({ done: [], rest: '現代' })
    expect(splitTagInput('、、 ,')).toEqual({ done: [], rest: '' })
    expect(hasTagSeparator('現代、')).toBe(true)
    expect(hasTagSeparator('現代')).toBe(false)
    expect(addTags(['ミリタリ'], ['現代', ' ﾐﾘﾀﾘ ', '', '現代 ', '戦闘'])).toEqual({
      tags: ['ミリタリ', '現代', '戦闘'],
      error: null,
      rejected: [],
    })
    const long = addTags(['現代'], ['あ'.repeat(21), '戦闘'])
    expect(long.tags).toEqual(['現代', '戦闘'])
    expect(long.error).toContain('タグは20字までにしてください')
    // 足せなかったタグは返す（入力欄に残す）
    expect(long.rejected).toEqual(['あ'.repeat(21)])
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect(addTags(twenty, ['x', 'y'])).toEqual({ tags: twenty, error: 'タグは1つの資料に20個までです', rejected: ['x', 'y'] })
    // もう付いているものは数に入れない
    expect(addTags(twenty, ['t1']).error).toBeNull()
    const inUse = ['ミリタリ', '現代', '戦闘', '現代史']
    expect(tagSuggestions(inUse, ['戦闘'], '')).toEqual(['ミリタリ', '現代', '現代史'])
    expect(tagSuggestions(inUse, ['戦闘'], ' 現代')).toEqual(['現代', '現代史'])
    expect(tagSuggestions(inUse, ['ﾐﾘﾀﾘ'], '')).toEqual(['現代', '戦闘', '現代史'])
    expect(tagSuggestions(inUse, [], '', 2)).toEqual(['ミリタリ', '現代'])
  })

  it('絞り込んだ棚の並べ替え: 見えている隣の資料を越えて動かす（端なら null）', () => {
    let data = emptyData()
    for (const m of shelf) data.materials[m.id] = m
    const shown = filterMaterials(shelf, { query: '歴史', tags: [] }) // a, b, e
    expect(visibleStepTarget(shelf, shown, 'a', -1)).toBeNull()
    expect(visibleStepTarget(shelf, shown, 'e', 1)).toBeNull()
    expect(visibleStepTarget(shelf, shown, 'zzz', 1)).toBeNull()
    // e を上へ: b の前へ
    const up = visibleStepTarget(shelf, shown, 'e', -1)!
    data = moveMaterialTo(data, 'e', up)
    const order = () =>
      Object.values(data.materials)
        .sort((x, y) => x.order - y.order)
        .map((m) => m.id)
    expect(order()).toEqual(['a', 'e', 'b', 'c', 'd', 'f'])
    // a を下へ: e の後ろへ（見えていない資料は動かない）
    const now = Object.values(data.materials).sort((x, y) => x.order - y.order)
    const shownNow = filterMaterials(now, { query: '歴史', tags: [] })
    data = moveMaterialTo(data, 'a', visibleStepTarget(now, shownNow, 'a', 1)!)
    expect(order()).toEqual(['e', 'a', 'b', 'c', 'd', 'f'])
    // b を下へ（b の次に見えている資料は無い）
    const later = Object.values(data.materials).sort((x, y) => x.order - y.order)
    expect(visibleStepTarget(later, filterMaterials(later, { query: '歴史', tags: [] }), 'b', 1)).toBeNull()
  })
})
