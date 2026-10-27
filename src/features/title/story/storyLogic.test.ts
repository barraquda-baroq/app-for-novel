import { describe, expect, it } from 'vitest'
import { createTitle, addCategory, addEntry, categoriesOf } from '../../../domain/entityOps'
import {
  addChapter,
  addEpisode,
  addSpecial,
  addVersion,
  episodeTargets,
  insertOptions,
  movePieceStep,
  setActiveVersion,
  setChaptersEnabled,
  setNumbering,
  updateVersion,
} from '../../../domain/storyOps'
import { locatePiece } from '../../../domain/structure'
import { emptyData, type AppData, type ID } from '../../../domain/types'
import {
  chapterStats,
  chapterStepAvailability,
  defaultEpisodeTarget,
  entryCounts,
  excerptOf,
  findSlotIndex,
  memoExcerpt,
  optionsWithinChapter,
  pieceSummary,
  previewEpisode,
  previewMoveLabel,
  specialPositionPreference,
  stepAvailability,
  titleStats,
} from './storyLogic'

function setup(episodes = 0): { data: AppData; titleId: ID; ids: ID[] } {
  const r = createTitle(emptyData(), '作品')
  let data = r.data
  const ids: ID[] = []
  for (let i = 0; i < episodes; i++) {
    const e = addEpisode(data, r.result)
    data = e.data
    ids.push(e.result)
  }
  return { data, titleId: r.result, ids }
}

describe('previewEpisode', () => {
  it('次に作られる話数を返す（タイトル作成直後は第1話）', () => {
    const { data, titleId } = setup()
    expect(previewEpisode(data, titleId)?.number).toBe(1)
    const { data: d3, titleId: t3 } = setup(3)
    expect(previewEpisode(d3, t3)).toMatchObject({ number: 4, chapterId: null, description: '第4話' })
  })

  it('特殊ブロックは話数を消費しない', () => {
    const { data, titleId } = setup(2)
    const d = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    expect(previewEpisode(d, titleId)?.number).toBe(3)
  })

  it('データは変更しない', () => {
    const { data, titleId } = setup(1)
    const before = data.pieces
    previewEpisode(data, titleId)
    expect(data.pieces).toBe(before)
    expect(Object.keys(data.pieces)).toHaveLength(1)
  })

  it('章ごとモードでは章名つきの説明になり、通し番号で最新話より前の章は null', () => {
    const { data, titleId } = setup(2)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = addEpisode(r.data, titleId, r.result).data
    // 通し番号: 第1章は最新話（第3話・第2章）より前なので追加できない
    expect(previewEpisode(d, titleId, ch1)).toBeNull()
    expect(previewEpisode(d, titleId, r.result)?.number).toBe(4)
    d = setNumbering(d, titleId, 'perChapter')
    expect(previewEpisode(d, titleId, ch1)).toMatchObject({ number: 3, chapterId: ch1, description: '「第1章」の第3話' })
    expect(previewEpisode(d, titleId, r.result)?.description).toBe('「第2章」の第2話')
    expect(previewEpisode(d, titleId, null)?.description).toBe('タイトル直下の第1話')
  })
})

describe('defaultEpisodeTarget', () => {
  it('最新話のある章を既定にする（候補になければ最初の候補）', () => {
    const { data, titleId } = setup(1)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = r.data
    expect(defaultEpisodeTarget(d, titleId, episodeTargets(d, titleId))).toBe(ch1)
    d = addEpisode(d, titleId, r.result).data
    expect(defaultEpisodeTarget(d, titleId, episodeTargets(d, titleId))).toBe(r.result)
    expect(defaultEpisodeTarget(d, titleId, [])).toBeUndefined()
  })

  it('話がなければ最初の候補', () => {
    const { data, titleId } = setup()
    const d = setChaptersEnabled(data, titleId, true)
    const targets = episodeTargets(d, titleId)
    expect(defaultEpisodeTarget(d, titleId, targets)).toBe(targets[0].chapterId)
  })
})

describe('特殊追加の位置', () => {
  it('見出しから既定の位置を決める', () => {
    expect(specialPositionPreference('プロローグ')).toBe('first')
    expect(specialPositionPreference(' エピローグ ')).toBe('last')
    expect(specialPositionPreference('あとがき')).toBe('last')
    expect(specialPositionPreference('幕間')).toBeNull()
  })

  it('章の中の位置だけに絞れる', () => {
    const { data, titleId } = setup(2)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    d = addChapter(d, titleId).data
    const within = optionsWithinChapter(insertOptions(d, titleId), ch1)
    expect(within.length).toBe(3) // 先頭・第1話の後・第2話の後
    expect(within.every((o) => o.slot.chapterId === ch1)).toBe(true)
  })

  it('findSlotIndex は同じ位置の選択肢を探す', () => {
    const { data, titleId, ids } = setup(3)
    const opts = insertOptions(data, titleId, ids[1])
    const current = findSlotIndex(opts, locatePiece(data, ids[1]))
    expect(opts[current].label).toContain('第1話')
    expect(findSlotIndex(opts, null)).toBe(-1)
  })
})

describe('previewMoveLabel', () => {
  it('移動後の話数を返す', () => {
    const { data, titleId, ids } = setup(3)
    const opts = insertOptions(data, titleId, ids[0])
    expect(previewMoveLabel(data, ids[0], opts[opts.length - 1].slot)).toBe('第3話')
    // データは変わらない
    expect(locatePiece(data, ids[0])).toEqual({ chapterId: null, index: 0 })
  })
})

describe('stepAvailability', () => {
  /** movePieceStep が実際に動かすかどうかと一致すること */
  function expectMatchesDomain(data: AppData, titleId: ID) {
    const avail = stepAvailability(data, titleId)
    for (const [id, a] of Object.entries(avail)) {
      expect(a.up, `up ${id}`).toBe(movePieceStep(data, id, -1) !== data)
      expect(a.down, `down ${id}`).toBe(movePieceStep(data, id, 1) !== data)
    }
  }

  it('章なし: 端は動かせない', () => {
    const { data, titleId, ids } = setup(3)
    const a = stepAvailability(data, titleId)
    expect(a[ids[0]]).toEqual({ up: false, down: true })
    expect(a[ids[2]]).toEqual({ up: true, down: false })
    expectMatchesDomain(data, titleId)
  })

  it('章あり: 章の中の話は章の外へ出られる。ドメインの movePieceStep と一致する', () => {
    const { data, titleId } = setup(2)
    let d = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    d = setChaptersEnabled(d, titleId, true)
    const r = addChapter(d, titleId)
    d = addEpisode(r.data, titleId, r.result).data
    d = addSpecial(d, titleId, { chapterId: null, index: d.titles[titleId].structure.length }, 'エピローグ').data
    expectMatchesDomain(d, titleId)
    // 章を隠した（章管理オフ）状態でも一致する
    expectMatchesDomain(setChaptersEnabled(d, titleId, false), titleId)
  })

  it('章の上下', () => {
    const { data, titleId } = setup(1)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = r.data
    expect(chapterStepAvailability(d, ch1)).toEqual({ up: false, down: true })
    expect(chapterStepAvailability(d, r.result)).toEqual({ up: true, down: false })
    expect(chapterStepAvailability(d, 'none')).toEqual({ up: false, down: false })
  })
})

describe('要約と集計', () => {
  it('採用中の稿・文字数・抜粋。採用がなければ active は null', () => {
    const { data, titleId, ids } = setup(2)
    const v1 = data.pieces[ids[0]].versionIds[0]
    let d = updateVersion(data, v1, { body: '　月の光が\n差し込む。' })
    const v2 = addVersion(d, ids[0], { body: '別案です' })
    d = setActiveVersion(v2.data, ids[0], v2.result)
    expect(pieceSummary(d, d.pieces[ids[0]])).toEqual({
      versionCount: 2,
      active: { name: '第2稿', chars: 4 },
      excerpt: '別案です',
    })
    d = setActiveVersion(d, ids[1], null)
    expect(pieceSummary(d, d.pieces[ids[1]]).active).toBeNull()

    const stats = titleStats(d, titleId)
    expect(stats).toMatchObject({ pieces: 2, episodes: 2, specials: 0, missingActive: 1, chars: 4, pages: 1 })
  })

  it('章ごとの集計', () => {
    const { data, titleId, ids } = setup(2)
    let d = updateVersion(data, data.pieces[ids[1]].versionIds[0], { body: 'あいうえお' })
    d = setChaptersEnabled(d, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    expect(chapterStats(d, ch1)).toMatchObject({ pieces: 2, episodes: 2, chars: 5 })
    expect(chapterStats(d, 'none').pieces).toBe(0)
  })

  it('抜粋は空白を詰めて切り詰める', () => {
    expect(excerptOf('　一行目\n\n二行目  です')).toBe('一行目 二行目 です')
    expect(excerptOf('あ'.repeat(100), 10)).toBe(`${'あ'.repeat(10)}…`)
  })

  it('メモの抜粋は改行を残し、空行を詰める', () => {
    expect(memoExcerpt('・一つ目\n\n  ・二つ目\r\n・三つ目\n・四つ目\n・五つ目')).toBe('・一つ目\n・二つ目\n・三つ目\n・四つ目')
    expect(memoExcerpt('')).toBe('')
  })

  it('設定項目ごとのエントリ数', () => {
    const { data, titleId } = setup()
    const cats = categoriesOf(data, titleId)
    let d = addEntry(data, cats[0].id, '主人公').data
    d = addEntry(d, cats[0].id, 'ライバル').data
    const extra = addCategory(d, titleId, '用語')
    d = extra.data
    expect(entryCounts(d, [cats[0].id, cats[1].id, extra.result])).toEqual({
      [cats[0].id]: 2,
      [cats[1].id]: 0,
      [extra.result]: 0,
    })
  })
})
