// 本編の一覧の、幕に分けた話の行・集計・操作メニューの項目
import { describe, expect, it } from 'vitest'
import { separatePiece } from '../../../domain/acts'
import { createTitle } from '../../../domain/entityOps'
import { addEpisode, addSpecial, addVersion, setActiveVersion, updatePiece, updateVersion } from '../../../domain/storyOps'
import { emptyData, type AppData, type ID } from '../../../domain/types'
import { rowMenuItems } from './RowMenu'
import { actRows, chapterStats, pieceRows, statsOfPieces, titleStats } from './storyLogic'

function setup(): { data: AppData; titleId: ID; ids: ID[]; acts: ID[] } {
  const t = createTitle(emptyData(), '作品')
  let data = t.data
  const ids: ID[] = []
  for (const body of ['あいうえおかきくけこ', 'さしすせそ']) {
    const r = addEpisode(data, t.result)
    data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
    ids.push(r.result)
  }
  data = updatePiece(data, ids[0], { subtitle: '題' })
  const s = separatePiece(data, ids[0], [3, 6])
  return { data: s.data, titleId: t.result, ids, acts: s.result }
}

describe('幕に分けた話の一覧', () => {
  it('行には幕の行（第x幕・採用稿・進捗）が付き、合計はつないだ本文で数える', () => {
    const { data, titleId, ids, acts } = setup()
    const rows = pieceRows(data, titleId)
    const row = rows[ids[0]]
    expect(row.acts?.map((a) => [a.label, a.fullLabel, a.version?.body, a.isLast, a.joinBlocked])).toEqual([
      ['第1幕', '第1話　題　第1幕', 'あいう', false, null],
      ['第2幕', '第1話　題　第2幕', 'えおか', false, null],
      ['第3幕', '第1話　題　第3幕', 'きくけこ', true, null],
    ])
    expect(row.text?.body).toBe('あいうえおかきくけこ')
    // 進捗: 全15字のうち 3・6・10字目で終わる
    expect(row.acts?.map((a) => a.progress)).toEqual([20, 40, 67])
    expect(row.progress).toBe(67)
    expect(rows[ids[1]].acts).toBeNull()
    expect(titleStats(data, titleId)).toMatchObject({ chars: 15, missingActive: 0, missingActs: 0, episodes: 2 })
    expect(acts).toHaveLength(3)
  })

  it('幕が変わらない限り同じ幕の行を渡す（行を描き直さない）。採用稿のない幕は採用原稿なしとして数える', () => {
    const { data, titleId, ids, acts } = setup()
    const first = actRows(data, data.pieces[ids[0]], undefined)
    // ほかの話の編集では同じ配列
    const other = updateVersion(data, data.pieces[ids[1]].versionIds[0], { body: 'さしす' })
    expect(actRows(other, other.pieces[ids[0]], undefined)).toBe(first)
    // 第2幕の採用を外すと、第1幕は「つなげない」理由を持つ
    const unadopted = setActiveVersion(data, acts[1], null)
    const rows = actRows(unadopted, unadopted.pieces[ids[0]], undefined)
    expect(rows).not.toBe(first)
    expect(rows[0].joinBlocked).toBe('第2幕に採用稿がないため、つなげません')
    expect(rows[1].version).toBeNull()
    const stats = statsOfPieces(unadopted, ids)
    expect(stats).toMatchObject({ chars: 12, missingActive: 1, missingActs: 1, missingEpisodes: 0 })
    expect(chapterStats(unadopted, 'none').pieces).toBe(0)
    expect(titleId).toBeTruthy()
  })

  it('操作メニュー: 話はセパレート／セパレート解除、幕は さらに分ける・次の幕とつなぐ（最後の幕にはない）', () => {
    const { data, titleId, ids, acts } = setup()
    const deps = { navigate: () => {}, move: () => {} }
    const labels = (r: ReturnType<typeof rowMenuItems>) => r?.items.map((i) => `${i.label}${i.disabled ? '（不可）' : ''}`)
    expect(rowMenuItems(data, { type: 'piece', id: ids[0] }, deps)?.label).toBe('第1話　題の操作')
    expect(labels(rowMenuItems(data, { type: 'piece', id: ids[0] }, deps))).toEqual(['開く', 'セパレート解除', '移動…', '削除'])
    expect(labels(rowMenuItems(data, { type: 'piece', id: ids[1] }, deps))).toEqual(['開く', 'セパレート', '移動…', '削除'])
    // 採用原稿のない話は分けられない
    const unadopted = setActiveVersion(data, ids[1], null)
    expect(labels(rowMenuItems(unadopted, { type: 'piece', id: ids[1] }, deps))).toEqual([
      '開く',
      'セパレート（不可）',
      '移動…',
      '削除',
    ])
    // 特殊ブロックにはセパレートがない
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    expect(labels(rowMenuItems(sp.data, { type: 'piece', id: sp.result }, deps))).toEqual(['開く', '移動…', '削除'])
    expect(labels(rowMenuItems(data, { type: 'act', id: acts[0] }, deps))).toEqual(['開く', 'さらに分ける', '次の幕とつなぐ'])
    expect(labels(rowMenuItems(data, { type: 'act', id: acts[2] }, deps))).toEqual(['開く', 'さらに分ける'])
    const noAdopt = setActiveVersion(addVersion(data, acts[1]).data, acts[1], null)
    expect(labels(rowMenuItems(noAdopt, { type: 'act', id: acts[1] }, deps))).toEqual([
      '開く',
      'さらに分ける（不可）',
      '次の幕とつなぐ（不可）',
    ])
    expect(rowMenuItems(data, { type: 'piece', id: 'missing' }, deps)).toBeNull()
  })
})
