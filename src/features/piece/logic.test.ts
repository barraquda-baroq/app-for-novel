import { describe, expect, it, vi } from 'vitest'
import { createTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, addVersion, deleteVersion, setActiveVersion, updateVersion } from '../../domain/storyOps'
import { emptyData, type AppData, type ID } from '../../domain/types'
import {
  activeVersionOf,
  firstLine,
  formatCharDelta,
  formatStats,
  liveStats,
  mapScrollTop,
  neighborPieces,
  ratioToSlider,
  resolveSelected,
  selectionAfterAdopt,
  sliderToRatio,
  statsLabel,
  statsParts,
  versionDeleteMessage,
  versionDisplayName,
  versionRows,
  versionsNewestFirst,
} from './logic'

// 本文を数え直した回数（一覧や自動保存のたびに全稿を数え直していないかを確かめる）
const counted = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../domain/text', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../domain/text')>()
  return {
    ...mod,
    countChars: (text: string) => {
      counted.n += 1
      return mod.countChars(text)
    },
    textStats: (text: string) => {
      counted.n += 1
      return mod.textStats(text)
    },
  }
})

function setup() {
  let data: AppData = emptyData()
  const t = createTitle(data, '作品')
  data = t.data
  const titleId = t.result
  const e1 = addEpisode(data, titleId)
  data = e1.data
  const e2 = addEpisode(data, titleId)
  data = e2.data
  return { data, titleId, p1: e1.result, p2: e2.result }
}

function firstVersion(data: AppData, pieceId: ID): ID {
  return data.pieces[pieceId].versionIds[0]
}

describe('推敲バージョンの一覧', () => {
  it('新しい順に並び、採用中・文字数・採用原稿との差・推敲メモの1行目を出す', () => {
    let { data, p1 } = setup()
    const v1 = firstVersion(data, p1)
    data = updateVersion(data, v1, { body: 'あいうえお\nかきく' })
    const r2 = addVersion(data, p1, { body: 'あいう' })
    data = updateVersion(r2.data, r2.result, { note: '\n  短くした  \n二行目' })
    const r3 = addVersion(data, p1, { body: 'あいうえお かきくけこ' })
    data = r3.data

    const rows = versionRows(data, data.pieces[p1])
    expect(rows.map((r) => r.version.name)).toEqual(['第3稿', '第2稿', '第1稿'])
    expect(rows.map((r) => r.isActive)).toEqual([false, false, true])
    // 空白・改行は数えない
    expect(rows.map((r) => r.chars)).toEqual([10, 3, 8])
    expect(rows.map((r) => r.delta)).toEqual([2, -5, null])
    expect(rows[1].note).toBe('短くした')
    expect(rows[0].note).toBe('')
  })

  it('文字数は稿ごとにキャッシュした値を使い、別の稿の保存では数え直さない', () => {
    let { data, p1 } = setup()
    const v1 = firstVersion(data, p1)
    data = updateVersion(data, v1, { body: 'あ'.repeat(5000) })
    data = addVersion(data, p1, { body: 'い'.repeat(4000) }).data
    const r3 = addVersion(data, p1, { body: 'う'.repeat(3000) })
    data = r3.data
    const first = versionRows(data, data.pieces[p1])
    expect(first.map((r) => r.chars)).toEqual([3000, 4000, 5000])
    // 第3稿だけを保存し直した（他の稿のレコードはそのまま）
    data = updateVersion(data, r3.result, { body: 'う'.repeat(3010) })
    counted.n = 0
    const again = versionRows(data, data.pieces[p1])
    expect(again.map((r) => r.chars)).toEqual([3010, 4000, 5000])
    expect(again.map((r) => r.delta)).toEqual([-1990, -1000, null])
    // 公開の countChars / textStats では数えない（bodyMetrics のキャッシュを使う）
    expect(counted.n).toBe(0)
  })

  it('編集中の文字数: 保存済みの本文と同じならキャッシュを使い、下書きだけを数え直す', () => {
    let { data, p1 } = setup()
    const v1 = firstVersion(data, p1)
    data = updateVersion(data, v1, { body: 'あいう\nえお' })
    const version = data.versions[v1]
    counted.n = 0
    expect(liveStats(version, version.body).chars).toBe(5)
    expect(liveStats(version, version.body).chars).toBe(5)
    expect(counted.n).toBe(0)
    expect(liveStats(version, 'あいう\nえおか').chars).toBe(6)
    expect(counted.n).toBe(1)
    expect(formatStats(liveStats(version, version.body))).toEqual({ chars: '5字', pages: '原稿用紙1枚' })
  })

  it('採用原稿がないときは差を出さない', () => {
    let { data, p1 } = setup()
    data = addVersion(data, p1, { body: 'abc' }).data
    data = setActiveVersion(data, p1, null)
    const rows = versionRows(data, data.pieces[p1])
    expect(rows.every((r) => r.delta === null && !r.isActive)).toBe(true)
    expect(activeVersionOf(data, data.pieces[p1])).toBeNull()
  })

  it('参照切れのバージョンは一覧に出さない', () => {
    const { data, p1 } = setup()
    const piece = { ...data.pieces[p1], versionIds: [...data.pieces[p1].versionIds, 'missing'] }
    expect(versionsNewestFirst(data, piece)).toHaveLength(1)
  })
})

describe('比較対象の選択（?v=）', () => {
  it('この話のバージョンだけを有効とする', () => {
    let { data, p1, p2 } = setup()
    const v1 = firstVersion(data, p1)
    const other = firstVersion(data, p2)
    expect(resolveSelected(data, data.pieces[p1], v1)?.id).toBe(v1)
    expect(resolveSelected(data, data.pieces[p1], other)).toBeNull()
    expect(resolveSelected(data, data.pieces[p1], null)).toBeNull()
    expect(resolveSelected(data, data.pieces[p1], 'nope')).toBeNull()
    const added = addVersion(data, p1)
    data = deleteVersion(added.data, added.result)
    expect(resolveSelected(data, data.pieces[p1], added.result)).toBeNull()
  })

  it('採用した後は、それまでの採用原稿を比較対象にする', () => {
    expect(selectionAfterAdopt('old', 'new', ['old', 'new'])).toBe('old')
    expect(selectionAfterAdopt(null, 'new', ['new'])).toBeNull()
    expect(selectionAfterAdopt('new', 'new', ['new'])).toBeNull()
    expect(selectionAfterAdopt('gone', 'new', ['new'])).toBeNull()
  })
})

describe('前後の話', () => {
  it('特殊ブロックも含めて読む順で前後をたどる', () => {
    let { data, titleId, p1, p2 } = setup()
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = sp.data
    expect(neighborPieces(data, titleId, sp.result)).toEqual({ prev: null, next: p1 })
    expect(neighborPieces(data, titleId, p1)).toEqual({ prev: sp.result, next: p2 })
    expect(neighborPieces(data, titleId, p2)).toEqual({ prev: p1, next: null })
    expect(neighborPieces(data, titleId, 'missing')).toEqual({ prev: null, next: null })
  })
})

describe('表示用の書式', () => {
  it('文字数の差', () => {
    expect(formatCharDelta(1200)).toBe('+1,200字')
    expect(formatCharDelta(-35)).toBe('−35字')
    expect(formatCharDelta(0)).toBe('±0字')
  })

  it('文字数と原稿用紙換算', () => {
    expect(statsLabel('')).toBe('0字・原稿用紙0枚')
    expect(statsLabel('あ'.repeat(3214))).toMatch(/^3,214字・原稿用紙\d+枚$/)
  })

  it('最初の空でない行', () => {
    expect(firstLine('\n\n  題  \n次')).toBe('題')
    expect(firstLine('   ')).toBe('')
    expect(firstLine('a\r\nb')).toBe('a')
  })

  it('無題の稿', () => {
    expect(versionDisplayName({ name: '  ' })).toBe('（無題の稿）')
    expect(versionDisplayName({ name: '第2稿' })).toBe('第2稿')
  })
})

describe('比率とスクロール同期', () => {
  it('スライダーと比率を相互に変換し、範囲内に収める', () => {
    expect(ratioToSlider(0.5)).toBe(50)
    expect(ratioToSlider(0.05)).toBe(15)
    expect(ratioToSlider(0.999)).toBe(85)
    expect(sliderToRatio(30)).toBeCloseTo(0.3)
    expect(sliderToRatio(5)).toBeCloseTo(0.15)
    expect(sliderToRatio(Number.NaN)).toBeCloseTo(0.5)
  })

  it('スクロール位置を割合で写す', () => {
    expect(mapScrollTop(50, 100, 400)).toBe(200)
    expect(mapScrollTop(150, 100, 400)).toBe(400)
    expect(mapScrollTop(10, 0, 400)).toBe(0)
    expect(mapScrollTop(10, 100, 0)).toBe(0)
  })
})

describe('推敲バージョンの削除の確認文', () => {
  const version = { id: 'v1', pieceId: 'p1' }
  const snapshotWithCopy = {
    at: 0,
    charCount: 3,
    activeVersions: { p1: 'v1' },
    order: ['p1'],
    pieces: {
      p1: {
        kind: 'episode' as const,
        label: '第1話',
        subtitle: '',
        versionId: 'v1',
        versionName: '第1稿',
        chars: 3,
        textKey: 'k1',
        hash: 'x',
      },
    },
  }

  it('応募の記録に使われていなければ、通常の確認文', () => {
    const text = versionDeleteMessage(version, false, [])
    expect(text).toBe(
      'この推敲バージョン（本文と推敲メモ）をゴミ箱に移します。30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。',
    )
    expect(text).not.toContain('応募')
    expect(versionDeleteMessage(version, true, [])).toContain('採用原稿がありません。')
  })

  it('記録に本文の控えがあれば、削除しても応募時の原稿は残ると知らせる', () => {
    const text = versionDeleteMessage(version, true, [{ contestName: '星降る文学賞', snapshot: snapshotWithCopy }])
    expect(text).toContain('この稿は「星降る文学賞」の応募時の原稿として記録されています。')
    expect(text).toContain('記録には本文の控えがあるので、削除しても応募時の原稿は残ります。')
    expect(text).toContain('ゴミ箱に移します。30日後に完全に削除されます')
  })

  it('古い記録（本文の控えなし）なら、読めなくなると知らせる。名前のない応募も示す', () => {
    const old = { at: 0, charCount: 3, activeVersions: { p1: 'v1' } }
    const text = versionDeleteMessage(version, false, [
      { contestName: '', snapshot: old },
      { contestName: '星降る文学賞', snapshot: snapshotWithCopy },
    ])
    expect(text).toContain('「（コンテスト名未設定）」「星降る文学賞」の応募時の原稿')
    expect(text).toContain('削除すると応募時の原稿は読めなくなります（ゴミ箱から戻せばまた読めます）。')
  })
})

describe('文字数の表示', () => {
  it('文字数と原稿用紙換算を分けて返す', () => {
    expect(statsParts('あいう\nえお')).toEqual({ chars: '5字', pages: '原稿用紙1枚' })
    expect(statsLabel('あいう\nえお')).toBe('5字・原稿用紙1枚')
  })
})
