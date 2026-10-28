import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { episodeFiles, fileSafe, uniqueFileStem } from './episodeExport'
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

  it('80文字で切る時に、絵文字（サロゲートペア）の途中で切らない', () => {
    const name = fileSafe(`${'あ'.repeat(79)}😀😀`)
    expect(Array.from(name)).toHaveLength(80)
    expect(name.endsWith('😀')).toBe(true)
    expect(/[\ud800-\udbff]$/.test(name)).toBe(false)
  })

  it('付けた名前と重ならないように番号を付ける（「あとがき(2)」という見出し・大文字小文字だけの違いも別の名前にする）', () => {
    const t = createTitle(emptyData(), '作品')
    let d = t.data
    for (const [i, label] of ['あとがき', 'あとがき', 'あとがき(2)', 'Prologue', 'prologue'].entries()) {
      d = addSpecial(d, t.result, { chapterId: null, index: i }, label).data
    }
    const names = episodeFiles(d, t.result, { withHeading: false, date: new Date(2026, 9, 5) }).map((f) => f.name)
    expect(names.slice(0, 5)).toEqual([
      '20261005作品_あとがき.txt',
      '20261005作品_あとがき(2).txt',
      '20261005作品_あとがき(2)(2).txt',
      '20261005作品_Prologue.txt',
      '20261005作品_prologue(2).txt',
    ])
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
    const taken = new Set<string>()
    expect([uniqueFileStem('a', taken), uniqueFileStem('A', taken), uniqueFileStem('a(2)', taken)]).toEqual([
      'a',
      'A(2)',
      'a(2)(2)',
    ])
  })
})
