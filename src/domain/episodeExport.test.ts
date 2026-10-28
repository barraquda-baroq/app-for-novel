import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { episodeFiles, fileSafe } from './episodeExport'
import { addEpisode, addSpecial, setActiveVersion, updatePiece, updateVersion } from './storyOps'
import { emptyData } from './types'

describe('各話テキスト書き出し', () => {
  it('採用原稿だけを1話1ファイルにし、名前は yyyymmddタイトル名_第n話.txt', () => {
    const t = createTitle(emptyData(), '星の/海')
    let d = t.data
    const e1 = addEpisode(d, t.result)
    d = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '一話\nの本文' })
    d = updatePiece(d, e1.result, { subtitle: '旅立ち' })
    const e2 = addEpisode(d, t.result)
    d = setActiveVersion(e2.data, e2.result, null)
    const e3 = addEpisode(d, t.result)
    d = updateVersion(e3.data, e3.data.pieces[e3.result].versionIds[0], { body: '三話' })
    const p1 = addSpecial(d, t.result, { chapterId: null, index: 0 }, 'あとがき')
    const p2 = addSpecial(p1.data, t.result, { chapterId: null, index: 4 }, 'あとがき')
    d = p2.data
    const files = episodeFiles(d, t.result, { withHeading: true, date: new Date(2026, 9, 5) })
    expect(files.map((f) => f.name)).toEqual([
      '20261005星の_海_あとがき.txt',
      '20261005星の_海_第1話.txt',
      '20261005星の_海_第3話.txt',
      '20261005星の_海_あとがき(2).txt',
    ])
    expect(files[1].text).toBe('第1話　旅立ち\r\n\r\n一話\r\nの本文')
    const plain = episodeFiles(d, t.result, { withHeading: false, date: new Date(2026, 9, 5) })
    expect(plain[2].text).toBe('三話')
  })

  it('ファイル名に使えない文字・末尾の点や空白を除く', () => {
    expect(fileSafe('a:b*c?. ')).toBe('a_b_c_')
    expect(fileSafe('   ')).toBe('無題')
  })
})
