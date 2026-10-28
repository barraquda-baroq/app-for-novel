import { describe, expect, it } from 'vitest'
import { diffSummary, diffTexts, type DiffSegment } from './diff'

const rebuild = (segs: DiffSegment[], side: 'base' | 'target') =>
  segs
    .filter((s) => s.kind === 'same' || s.kind === (side === 'base' ? 'del' : 'add'))
    .map((s) => s.text)
    .join('')

describe('推敲比較の差分', () => {
  it('どちらの文章も正しく復元でき、変更に挟まれた1文字の一致で細切れにならない', () => {
    const a = '埃がゆっくりと舞っていた。'
    const b = '細かな埃が光の筋の中で踊っていた。'
    const segs = diffTexts(a, b)
    expect(rebuild(segs, 'base')).toBe(a)
    expect(rebuild(segs, 'target')).toBe(b)
    // 「ゆっくりと舞っ」→「光の筋の中で踊っ」がひと続きの削除・追加になる
    expect(segs.filter((s) => s.kind === 'del').map((s) => s.text)).toEqual(['ゆっくりと舞っ'])
  })

  it('全段落に手を入れた長い話でも、全文削除・全文追加にはならない', () => {
    const paras = Array.from(
      { length: 300 },
      (_, i) => `第${i}段落の文章です。静かな朝に、少女は古い本を開いた。表紙は擦り切れていた。`,
    )
    const a = paras.join('\n') + '\n'
    const b = paras.map((p) => p.replace('静かな', '穏やかな')).join('\n') + '\n'
    const started = performance.now()
    const segs = diffTexts(a, b)
    const elapsed = performance.now() - started
    expect(rebuild(segs, 'base')).toBe(a)
    expect(rebuild(segs, 'target')).toBe(b)
    const { added, removed } = diffSummary(segs)
    expect(added).toBeLessThan(2000)
    expect(removed).toBeLessThan(2000)
    expect(elapsed).toBeLessThan(3000)
  })
})
