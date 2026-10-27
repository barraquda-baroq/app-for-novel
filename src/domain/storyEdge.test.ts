// 本編構成の境界ケース
import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { addChapter, addEpisode, addSpecial, insertOptions, movePiece, movePieceStep, planEpisodeSlot, setChaptersEnabled, updatePiece } from './storyOps'
import { canDeletePiece, episodeNumbers, flatten, pieceLabel } from './structure'
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
