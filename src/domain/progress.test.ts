import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { formatProgress, titleProgress } from './progress'
import { addEpisode, addSpecial, setActiveVersion, updateVersion } from './storyOps'
import { emptyData } from './types'

describe('各話の進捗', () => {
  it('その話の終わりまでの採用原稿の文字数 ÷ 全体（採用原稿のない話は 0 文字）', () => {
    const t = createTitle(emptyData(), '作品')
    let d = t.data
    const ids: string[] = []
    for (const body of ['あ'.repeat(100), 'い'.repeat(300), 'う'.repeat(600)]) {
      const e = addEpisode(d, t.result)
      d = updateVersion(e.data, e.data.pieces[e.result].versionIds[0], { body })
      ids.push(e.result)
    }
    const pro = addSpecial(d, t.result, { chapterId: null, index: 0 }, 'プロローグ')
    d = setActiveVersion(pro.data, pro.result, null)
    const p = titleProgress(d, t.result)
    expect(p.get(pro.result)).toMatchObject({ chars: 0, end: 0 })
    expect(p.get(ids[0])?.end).toBeCloseTo(0.1)
    expect(p.get(ids[1])?.end).toBeCloseTo(0.4)
    expect(p.get(ids[2])).toMatchObject({ before: 400, chars: 600, total: 1000, end: 1 })
    expect(formatProgress(p.get(ids[1])!.end)).toBe('40%')
    expect(formatProgress(null)).toBe('—')
  })
})
