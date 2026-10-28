import { describe, expect, it } from 'vitest'
import { separatePiece } from '../../domain/acts'
import { createTitle } from '../../domain/entityOps'
import { buildReadThrough, readThroughText } from '../../domain/readthrough'
import { strippedBody } from '../../domain/ruby'
import {
  addChapter,
  addEpisode,
  addSpecial,
  movePiece,
  setActiveVersion,
  setChaptersEnabled,
  updateVersion,
} from '../../domain/storyOps'
import { emptyData, type AppData } from '../../domain/types'
import { lineShape, lineShapeOf } from './lineEstimate'
import { clampFontSize, readMissingLabel, readStats, resolveChapterScope, splitTcy, tocGroups } from './readLogic'

function setup(): { data: AppData; titleId: string; pieces: string[] } {
  let data = emptyData()
  const t = createTitle(data, '作品')
  data = t.data
  const pieces: string[] = []
  for (const body of ['一話です', '二話です', '三話']) {
    const r = addEpisode(data, t.result)
    data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
    pieces.push(r.result)
  }
  return { data, titleId: t.result, pieces }
}

describe('通し読みの範囲', () => {
  it('章管理がオンで、そのタイトルの章のときだけ絞り込む', () => {
    let { data, titleId } = setup()
    const other = createTitle(data, '別作品')
    data = other.data
    expect(resolveChapterScope(data, titleId, null)).toBeUndefined()
    const c = addChapter(setChaptersEnabled(data, titleId, true), titleId, '第二章')
    data = c.data
    expect(resolveChapterScope(data, titleId, c.result)).toBe(c.result)
    expect(resolveChapterScope(data, titleId, 'no-such')).toBeUndefined()
    // 別タイトルの章は無視
    const oc = addChapter(setChaptersEnabled(data, other.result, true), other.result, 'X')
    expect(resolveChapterScope(oc.data, titleId, oc.result)).toBeUndefined()
    // 章管理をオフにすると全体
    expect(resolveChapterScope(setChaptersEnabled(data, titleId, false), titleId, c.result)).toBeUndefined()
  })
})

describe('目次と集計', () => {
  it('章ごとにまとめ、章の外の話は見出しなしのグループになる', () => {
    let { data, titleId, pieces } = setup()
    data = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    data = setChaptersEnabled(data, titleId, true)
    const first = data.titles[titleId].structure[0].id
    // プロローグを章の外（先頭）へ
    const pro = Object.values(data.pieces).find((p) => p.kind === 'special')!.id
    data = movePiece(data, pro, { chapterId: null, index: 0 })
    const c2 = addChapter(data, titleId, '第二章')
    data = movePiece(c2.data, pieces[2], { chapterId: c2.result, index: 0 })
    data = setActiveVersion(data, pieces[1], null)

    const groups = tocGroups(buildReadThrough(data, titleId))
    expect(groups.map((g) => [g.name, g.items.map((i) => i.label)])).toEqual([
      [null, ['プロローグ']],
      ['第1章', ['第1話', '第2話']],
      ['第二章', ['第3話']],
    ])
    expect(groups[1].chapterId).toBe(first)

    // プロローグは空の稿（0字・0枚）、第2話は採用原稿なし
    expect(readStats(data, buildReadThrough(data, titleId))).toEqual({
      pieces: 4,
      missing: 1,
      missingActs: 0,
      chars: 6,
      pages: 2,
    })
    // 章で絞り込むと、その章だけ
    expect(tocGroups(buildReadThrough(data, titleId, c2.result)).map((g) => g.name)).toEqual(['第二章'])
  })

  it('章管理がオフなら1つのグループ', () => {
    const { data, titleId } = setup()
    const groups = tocGroups(buildReadThrough(data, titleId))
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBeNull()
    expect(groups[0].items).toHaveLength(3)
  })
})

describe('ルビ・傍点', () => {
  it('文字数は記号とルビの読みを除き、テキストの書き出しは記法のまま', () => {
    let { data, titleId, pieces } = setup()
    data = updateVersion(data, data.pieces[pieces[0]].versionIds[0], { body: '｜魔法使い《ウィザード》と《《夜》》' })
    // 第1話: 魔法使い・と・夜 = 6字、第2話「二話です」4字、第3話「三話」2字
    expect(readStats(data, buildReadThrough(data, titleId)).chars).toBe(12)
    const text = readThroughText(data, titleId)
    expect(text).toContain('第1話\n\n｜魔法使い《ウィザード》と《《夜》》\n')
  })

  it('画面の外の話の大きさの見積もりは、表示される文字（記号と読みを除く）で数える', () => {
    expect(lineShapeOf('｜魔法使い《ウィザード》と《《夜》》\n\n東京《とうきょう》')).toEqual({ chars: 8, paras: 2, blank: 1 })
    expect(lineShapeOf('記法なし\n二行目')).toEqual({ chars: 7, paras: 2, blank: 0 })
    // 本文の控え・稿ごとに覚えておく値も同じ
    expect(lineShape({ body: '漢字《かんじ》' })).toEqual({ chars: 2, paras: 1, blank: 0 })
  })

  it('稿ごとの見積もりは、遠くの話に置く「記号と読みを除いた本文」と同じものを数える（除くのは1回だけ）', () => {
    const record = { body: '漢字｜《かな》\n東京《とうきょう》' }
    // 漢字《かな》（6字）・東京（2字）。2回除くと 漢字（2字）になってしまう
    expect(lineShape(record)).toEqual({ chars: 8, paras: 2, blank: 0 })
    expect(strippedBody(record)).toBe('漢字《かな》\n東京')
    expect(lineShapeOf(record.body)).toEqual(lineShape(record))
  })
})

describe('表示', () => {
  it('2桁までの数字を縦中横にする', () => {
    expect(splitTcy('第12話')).toEqual(['第', { tcy: '12' }, '話'])
    expect(splitTcy('第3話')).toEqual(['第', { tcy: '3' }, '話'])
    expect(splitTcy('第123話')).toEqual(['第123話'])
    expect(splitTcy('1と22')).toEqual([{ tcy: '1' }, 'と', { tcy: '22' }])
    expect(splitTcy('プロローグ')).toEqual(['プロローグ'])
  })

  it('文字サイズは 14〜28 に収める', () => {
    expect(clampFontSize(10)).toBe(14)
    expect(clampFontSize(40)).toBe(28)
    expect(clampFontSize(17.4)).toBe(17)
    expect(clampFontSize(Number.NaN)).toBe(17)
  })
})

describe('幕に分けた話の通し読み', () => {
  it('文字数はつないだ本文で数え、採用稿のない幕は「1幕」として数える', () => {
    const { data: d0, titleId, pieces } = setup()
    const s = separatePiece(d0, pieces[0], [2])
    let data = s.data
    expect(readStats(data, buildReadThrough(data, titleId))).toEqual({
      pieces: 3,
      missing: 0,
      missingActs: 0,
      chars: 10,
      pages: 3,
    })
    data = setActiveVersion(data, s.result[1], null)
    const stats = readStats(data, buildReadThrough(data, titleId))
    expect(stats).toMatchObject({ pieces: 3, missing: 0, missingActs: 1, chars: 8 })
    expect(readMissingLabel(stats)).toBe('採用原稿なし 1幕')
    data = setActiveVersion(data, pieces[1], null)
    expect(readMissingLabel(readStats(data, buildReadThrough(data, titleId)))).toBe('採用原稿なし 1話＋1幕')
    // 目次は話ごと（幕は話の中に並ぶ）
    const groups = tocGroups(buildReadThrough(data, titleId))
    expect(groups[0].items[0].acts?.map((a) => a.label)).toEqual(['第1幕', '第2幕'])
  })
})
