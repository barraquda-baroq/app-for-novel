// 本編構成の境界ケース
import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import {
  addChapter,
  addEpisode,
  addSpecial,
  baseVersionName,
  duplicateVersion,
  insertOptions,
  movePiece,
  movePieceStep,
  planEpisodeSlot,
  removeChapter,
  setChaptersEnabled,
  setNumbering,
  updatePiece,
} from './storyOps'
import { canDeletePiece, episodeNumbers, flatten, locatePiece, pieceLabel } from './structure'
import { emptyData, type AppData, type ID } from './types'

function labels(data: AppData, titleId: ID): string[] {
  const numbers = episodeNumbers(data, titleId)
  return flatten(data, titleId).map((f) => {
    const p = data.pieces[f.pieceId]
    return pieceLabel(data, p, numbers) + (p.subtitle ? `:${p.subtitle}` : '')
  })
}

function build(n: number) {
  const t = createTitle(emptyData(), 't')
  let data = t.data
  const ids: ID[] = []
  for (let i = 0; i < n; i++) {
    const r = addEpisode(data, t.result)
    data = updatePiece(r.data, r.result, { subtitle: String.fromCharCode(65 + i) })
    ids.push(r.result)
  }
  return { data, titleId: t.result, ids }
}

describe('章を無効にした状態（章構成は隠れて残っている）', () => {
  it('1つずつの移動は読む順で隣と入れ替わり、章をまたいでも1歩ずつ動く', () => {
    let { data, titleId, ids } = build(3)
    data = setChaptersEnabled(data, titleId, true)
    const c2 = addChapter(data, titleId)
    data = movePiece(c2.data, ids[2], { chapterId: c2.result, index: 0 })
    data = setChaptersEnabled(data, titleId, false)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話:C'])
    data = movePieceStep(data, ids[2], -1)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:C', '第3話:B'])
    data = movePieceStep(data, ids[0], 1)
    expect(labels(data, titleId)).toEqual(['第1話:C', '第2話:A', '第3話:B'])
    data = movePieceStep(data, ids[1], 1)
    expect(labels(data, titleId)).toEqual(['第1話:C', '第2話:A', '第3話:B'])
  })

  it('話数追加は最後の話の直後（隠れた章の中）に入る', () => {
    let { data, titleId, ids } = build(2)
    data = setChaptersEnabled(data, titleId, true)
    data = setChaptersEnabled(data, titleId, false)
    const slot = planEpisodeSlot(data, titleId)
    const chapterOfLast = Object.values(data.chapters).find((c) => c.pieceIds.includes(ids[1]))!
    expect(slot).toEqual({ chapterId: chapterOfLast.id, index: 2 })
  })

  it('移動先候補は読む順の位置だけが並ぶ', () => {
    let { data, titleId, ids } = build(3)
    data = setChaptersEnabled(data, titleId, true)
    data = setChaptersEnabled(data, titleId, false)
    const opts = insertOptions(data, titleId, ids[1])
    expect(opts.map((o) => o.label)).toEqual(['先頭（「第1話　A」の前）', '「第1話　A」の後', '末尾（「第3話　C」の後）'])
    data = movePiece(data, ids[1], opts[0].slot)
    expect(labels(data, titleId)).toEqual(['第1話:B', '第2話:A', '第3話:C'])
  })
})

describe('話数追加の位置（章あり・通し番号）', () => {
  it('タイトル直下を指定すると最後に追加される', () => {
    let { data, titleId } = build(2)
    data = setChaptersEnabled(data, titleId, true)
    const r = addEpisode(data, titleId, null)
    data = r.data
    expect(data.titles[titleId].structure.at(-1)).toEqual({ type: 'piece', id: r.result })
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話'])
  })

  it('エピローグ（特殊ブロック）があっても最新話の直後に入る', () => {
    let { data, titleId } = build(1)
    data = setChaptersEnabled(data, titleId, true)
    const ch = data.titles[titleId].structure[0].id
    data = addSpecial(data, titleId, { chapterId: ch, index: 1 }, 'エピローグ').data
    data = addEpisode(data, titleId).data
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話', 'エピローグ'])
  })

  it('話がない状態で章が複数あれば最初の章に第1話が入る', () => {
    const t = createTitle(emptyData(), 't')
    let data = setChaptersEnabled(t.data, t.result, true)
    data = addChapter(data, t.result).data
    const r = addEpisode(data, t.result)
    const first = r.data.titles[t.result].structure[0].id
    expect(r.data.chapters[first].pieceIds).toEqual([r.result])
  })

  it('特殊ブロックだけを含む章は削除の判定に影響しない', () => {
    let { data, titleId, ids } = build(2)
    data = addSpecial(data, titleId, { chapterId: null, index: 2 }, 'あとがき').data
    expect(canDeletePiece(data, ids[1]).ok).toBe(true)
    expect(canDeletePiece(data, ids[0]).ok).toBe(false)
  })
})

describe('レビューで見つかった境界ケース', () => {
  it('章オフ中に↑してから↓すると、章をオンに戻した時の章の構成も元どおり', () => {
    let { data, titleId, ids } = build(4)
    data = setChaptersEnabled(data, titleId, true)
    const c1 = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId)
    data = movePiece(c2.data, ids[2], { chapterId: c2.result, index: 0 })
    data = movePiece(data, ids[3], { chapterId: c2.result, index: 1 })
    data = setChaptersEnabled(data, titleId, false)
    data = movePieceStep(data, ids[2], -1)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:C', '第3話:B', '第4話:D'])
    data = movePieceStep(data, ids[2], 1)
    data = setChaptersEnabled(data, titleId, true)
    expect(data.chapters[c1].pieceIds).toEqual([ids[0], ids[1]])
    expect(data.chapters[c2.result].pieceIds).toEqual([ids[2], ids[3]])
  })

  it('同じ見出しの特殊ブロックが複数あっても、差し込み位置が欠けず区別できる', () => {
    let { data, titleId } = build(3)
    data = addSpecial(data, titleId, { chapterId: null, index: 1 }, '幕間').data
    data = addSpecial(data, titleId, { chapterId: null, index: 3 }, '幕間').data
    expect(labels(data, titleId)).toEqual(['第1話:A', '幕間', '第2話:B', '幕間', '第3話:C'])
    const opts = insertOptions(data, titleId)
    expect(opts).toHaveLength(6)
    expect(new Set(opts.map((o) => o.label)).size).toBe(6)
    expect(opts.map((o) => o.label)).toContain('「幕間」の後（「第3話　C」の前）')
  })

  it('章オフ中、隠れた章の先頭にある話の移動先候補にも現在位置が含まれる', () => {
    let { data, titleId, ids } = build(4)
    data = setChaptersEnabled(data, titleId, true)
    const c2 = addChapter(data, titleId)
    data = movePiece(c2.data, ids[2], { chapterId: c2.result, index: 0 })
    data = movePiece(data, ids[3], { chapterId: c2.result, index: 1 })
    data = setChaptersEnabled(data, titleId, false)
    const from = locatePiece(data, ids[2])!
    const opts = insertOptions(data, titleId, ids[2])
    expect(opts.filter((o) => o.slot.chapterId === from.chapterId && o.slot.index === from.index)).toHaveLength(1)
    // 現在位置を選んで移動しても何も変わらない
    const current = opts.find((o) => o.slot.chapterId === from.chapterId && o.slot.index === from.index)!
    const moved = movePiece(data, ids[2], current.slot)
    expect(labels(moved, titleId)).toEqual(labels(data, titleId))
  })
})

describe('章の追加位置・名前、複製名、削除理由', () => {
  it('末尾のエピローグより前に章が追加され、新しい章への話数追加もエピローグより前になる', () => {
    let { data, titleId } = build(2)
    data = setChaptersEnabled(data, titleId, true)
    data = addSpecial(data, titleId, { chapterId: null, index: 1 }, 'エピローグ').data
    const c2 = addChapter(data, titleId)
    data = addEpisode(c2.data, titleId, c2.result).data
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話', 'エピローグ'])
    // タイトル直下を指定しても、エピローグの前に入る
    data = addEpisode(data, titleId, null).data
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話', '第4話', 'エピローグ'])
  })

  it('章の既定名は既存の第n章と重ならない', () => {
    let { data, titleId } = build(1)
    data = setChaptersEnabled(data, titleId, true)
    const first = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId)
    data = removeChapter(c2.data, first)
    const c3 = addChapter(data, titleId)
    expect(c3.data.chapters[c3.result].name).toBe('第3章')
  })

  it('複製名は入れ子にならない', () => {
    expect(baseVersionName('第2稿（第1稿を複製）')).toBe('第2稿')
    expect(baseVersionName('')).toBe('無題の稿')
    expect(baseVersionName('決定稿（第1稿を複製）')).toBe('決定稿')
    let { data, ids } = build(1)
    const v1 = data.pieces[ids[0]].versionIds[0]
    const d1 = duplicateVersion(data, v1)
    const d2 = duplicateVersion(d1.data, d1.result)
    expect(d2.data.versions[d2.result].name).toBe('第3稿（第2稿を複製）')
  })

  it('章ごとの話数でタイトル直下の話を消せない時は、章ではなくタイトル直下と説明する', () => {
    let { data, titleId, ids } = build(2)
    data = setChaptersEnabled(data, titleId, true)
    data = setNumbering(data, titleId, 'perChapter')
    data = removeChapter(data, data.titles[titleId].structure[0].id)
    const reason = canDeletePiece(data, ids[0]).reason ?? ''
    expect(reason).toContain('タイトル直下')
    expect(reason).not.toContain('この章')
  })
})
