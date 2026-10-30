import { describe, expect, it } from 'vitest'
import type { AppData, BenchAnalysis, Title } from '../../domain/types'
import {
  analysesByWork,
  analysisPreview,
  biblioLine,
  comparingTitles,
  createdByLabel,
  deleteWorkMessage,
  runDateLabel,
  viewpointChips,
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
