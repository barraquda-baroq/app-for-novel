import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { episodeFiles, fileSafe } from './episodeExport'
import {
  addChapter,
  addEpisode,
  addSpecial,
  setActiveVersion,
  setChaptersEnabled,
  setNumbering,
  updateChapter,
  updatePiece,
  updateVersion,
} from './storyOps'
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

  it('長い名前は文字（コードポイント）単位で80字に切り、サロゲートペアの途中で切らない', () => {
    expect(fileSafe('あ'.repeat(79) + '𠮷')).toBe('あ'.repeat(79) + '𠮷')
    expect(fileSafe('あ'.repeat(80) + '𠮷')).toBe('あ'.repeat(80))
    const long = fileSafe('😀'.repeat(100))
    expect(Array.from(long)).toHaveLength(80)
    // 対になっていないサロゲートがない（String.prototype.isWellFormed と同じ判定）
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    // 切った末尾に点・空白が来ても除く（Windows では末尾の点・空白は使えない）
    expect(fileSafe('あ'.repeat(78) + '. ' + 'い')).toBe('あ'.repeat(78))
    expect(fileSafe('.'.repeat(80) + 'い')).toBe('無題')
  })

  /** 大文字・小文字・Unicode の正規化だけが違う名前は、Windows・Mac では同じファイル */
  const key = (name: string) => name.normalize('NFC').toLowerCase()

  it('同じ名前になる時は、付けた (2) とも重ならないように (3)… と進める', () => {
    const t = createTitle(emptyData(), '星')
    let d = t.data
    for (const label of ['幕間', '幕間', '幕間(2)', 'Extra', 'extra', 'Café', 'Café']) {
      const r = addSpecial(d, t.result, { chapterId: null, index: d.titles[t.result].structure.length }, label)
      d = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body: label })
    }
    const names = episodeFiles(d, t.result, { withHeading: false, date: new Date(2026, 9, 28) }).map((f) => f.name)
    expect(names).toEqual([
      '20261028星_幕間.txt',
      '20261028星_幕間(2).txt',
      '20261028星_幕間(2)(2).txt',
      '20261028星_Extra.txt',
      '20261028星_extra(2).txt',
      '20261028星_Café.txt',
      '20261028星_Café(2).txt',
    ])
    expect(new Set(names.map(key)).size).toBe(names.length)
  })

  it('3つ目の同じ見出しは (3)。比べ方は大文字・小文字と正規化の違いを無視する', () => {
    const t = createTitle(emptyData(), '星')
    let d = t.data
    for (const label of ['あとがき', 'あとがき', 'あとがき']) {
      const r = addSpecial(d, t.result, { chapterId: null, index: d.titles[t.result].structure.length }, label)
      d = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body: '本文' })
    }
    const names = episodeFiles(d, t.result, { withHeading: false, date: new Date(2026, 9, 28) }).map((f) => f.name)
    expect(names).toEqual(['20261028星_あとがき.txt', '20261028星_あとがき(2).txt', '20261028星_あとがき(3).txt'])
    expect(new Set(names.map(key)).size).toBe(names.length)
  })

  it('話数を章ごとに振る時は、章の並び順と章名を名前と見出しに入れる（名前の順＝読む順）', () => {
    const t = createTitle(emptyData(), '星')
    let d = setChaptersEnabled(t.data, t.result, true)
    const first = d.titles[t.result].structure[0].id
    d = updateChapter(d, first, { name: '一章' })
    const ch2 = addChapter(d, t.result, '二章')
    d = setNumbering(ch2.data, t.result, 'perChapter')
    const add = (chapterId: string, body: string, subtitle = '') => {
      const e = addEpisode(d, t.result, chapterId)
      d = updateVersion(e.data, e.data.pieces[e.result].versionIds[0], { body })
      if (subtitle) d = updatePiece(d, e.result, { subtitle })
    }
    add(first, '一の一')
    add(first, '一の二')
    add(ch2.result, '二の一', '題')
    add(ch2.result, '二の二')
    const files = episodeFiles(d, t.result, { withHeading: true, date: new Date(2026, 9, 28) })
    const names = files.map((f) => f.name)
    expect(names).toEqual([
      '20261028星_1一章_第1話.txt',
      '20261028星_1一章_第2話.txt',
      '20261028星_2二章_第1話.txt',
      '20261028星_2二章_第2話.txt',
    ])
    expect(names.some((n) => n.includes('(2)'))).toBe(false)
    expect([...names].sort()).toEqual(names)
    expect(new Set(names.map(key)).size).toBe(names.length)
    expect(files.map((f) => f.text.split('\r\n')[0])).toEqual(['一章　第1話', '一章　第2話', '二章　第1話　題', '二章　第2話'])

    // 通し番号に戻すと章は付けない
    const continuous = episodeFiles(setNumbering(d, t.result, 'continuous'), t.result, {
      withHeading: true,
      date: new Date(2026, 9, 28),
    })
    expect(continuous.map((f) => f.name)).toEqual([
      '20261028星_第1話.txt',
      '20261028星_第2話.txt',
      '20261028星_第3話.txt',
      '20261028星_第4話.txt',
    ])
    expect(continuous[2].text.split('\r\n')[0]).toBe('第3話　題')
  })

  it('章ごとの話数で章が10以上なら、章の番号の桁をそろえる。章の外の話・名前のない章もそのまま並ぶ', () => {
    const t = createTitle(emptyData(), '星')
    let d = setChaptersEnabled(t.data, t.result, true)
    const chapters = [d.titles[t.result].structure[0].id]
    for (let i = 2; i <= 10; i++) {
      const c = addChapter(d, t.result, i === 10 ? '  ' : `${i}章`)
      d = c.data
      chapters.push(c.result)
    }
    d = setNumbering(d, t.result, 'perChapter')
    for (const chapterId of [chapters[0], chapters[9]]) {
      const e = addEpisode(d, t.result, chapterId)
      d = updateVersion(e.data, e.data.pieces[e.result].versionIds[0], { body: '本文' })
    }
    const root = addEpisode(d, t.result, null)
    d = updateVersion(root.data, root.data.pieces[root.result].versionIds[0], { body: '章の外' })
    const files = episodeFiles(d, t.result, { withHeading: true, date: new Date(2026, 9, 28) })
    expect(files.map((f) => f.name)).toEqual([
      '20261028星_01第1章_第1話.txt',
      '20261028星_10無題の章_第1話.txt',
      '20261028星_第1話.txt',
    ])
    expect(files[1].text.startsWith('無題の章　第1話\r\n')).toBe(true)
    expect(files[2].text.startsWith('第1話\r\n')).toBe(true)
  })
})
