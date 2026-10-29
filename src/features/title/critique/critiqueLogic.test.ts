import { describe, expect, it } from 'vitest'
import type { CritiqueResult } from '../../../domain/types'
import { dayHeading, groupByDate, resultHeading, scopeLabel } from './critiqueLogic'

const r = (id: string, runDate: string, extra: Partial<CritiqueResult> = {}) =>
  ({ id, runDate, promptName: '', promptText: '', scope: { kind: 'whole' }, ...extra }) as CritiqueResult

describe('作品批評の表示', () => {
  it('新しい日付から並んだ結果を日付ごとにまとめる', () => {
    const days = groupByDate([r('a', '2026-10-28'), r('b', '2026-10-28'), r('c', '2026-10-01')])
    expect(days.map((d) => [d.date, d.items.map((x) => x.id)])).toEqual([
      ['2026-10-28', ['a', 'b']],
      ['2026-10-01', ['c']],
    ])
  })

  it('日付の見出し', () => {
    expect(dayHeading('2026-10-28')).toBe('2026年10月28日（水）')
    expect(dayHeading('')).toBe('日付なし')
    expect(dayHeading('いつか')).toBe('いつか')
  })

  it('見出しはプロンプトの名前、無ければ依頼文の最初の行', () => {
    expect(resultHeading({ promptName: '全体の構成', promptText: 'x' })).toBe('全体の構成')
    expect(resultHeading({ promptName: ' ', promptText: '\n  人物を見てください\n二行目' })).toBe('人物を見てください')
    expect(resultHeading({ promptName: '', promptText: '' })).toBe('（プロンプトなし）')
    expect(resultHeading({ promptName: '', promptText: 'あ'.repeat(40) })).toBe(`${'あ'.repeat(30)}…`)
  })

  it('範囲', () => {
    expect(scopeLabel({ scope: { kind: 'whole' } })).toBe('タイトル全体')
    expect(scopeLabel({ scope: { kind: 'range', fromPieceId: 'a', toPieceId: 'b', label: '第1話〜第20話' } })).toBe(
      '第1話〜第20話',
    )
  })
})
