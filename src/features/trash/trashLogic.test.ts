import { describe, expect, it } from 'vitest'
import { createTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, deletePiece } from '../../domain/storyOps'
import { DAY_MS, listTrash } from '../../domain/trash'
import { emptyData, type TrashEntry } from '../../domain/types'
import { dayLabel, daysLeftLabel, restoredMessage, trashDays, trashKindLabel, trashPlace } from './trashLogic'

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()

function entry(patch: Partial<TrashEntry>): TrashEntry {
  return {
    id: 'e',
    kind: 'memo',
    label: 'メモ',
    titleName: '作品A',
    origin: { titleId: 't', index: 0 },
    recordIds: [],
    reason: 'deleted',
    deletedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('ゴミ箱の一覧の表記', () => {
  it('日付の見出しは今日・昨日・月日（曜日）、去年以前は年も付ける', () => {
    const now = at(2026, 10, 28, 9)
    expect(dayLabel(at(2026, 10, 28, 0, 1), now)).toBe('今日')
    expect(dayLabel(at(2026, 10, 27, 23, 59), now)).toBe('昨日')
    expect(dayLabel(at(2026, 10, 25), now)).toBe('10月25日（日）')
    expect(dayLabel(at(2025, 12, 31), now)).toBe('2025年12月31日（水）')
    // 月をまたいでも「昨日」
    expect(dayLabel(at(2026, 10, 31), at(2026, 11, 1))).toBe('昨日')
  })

  it('どこにあったか: タイトル名と親。タイトル自体は出さず、どのタイトルにも属さないアイデアはそう書く', () => {
    expect(trashPlace(entry({ parentLabel: '第3話　旅立ち' }))).toBe('作品A › 第3話　旅立ち')
    expect(trashPlace(entry({ titleName: '' }))).toBe('無題のタイトル')
    expect(trashPlace(entry({ kind: 'title' }))).toBe('')
    expect(trashPlace(entry({ kind: 'idea', titleName: '', origin: { titleId: null, index: 0 } }))).toBe(
      'どのタイトルにも属さない',
    )
    // 2.3: 共通の批評プロンプトはタイトルに属さない。タイトルの推敲案はタイトル › 話
    expect(
      trashPlace(
        entry({
          kind: 'critiquePrompt',
          titleName: '',
          parentLabel: '共通の批評プロンプト',
          origin: { titleId: null, index: 0 },
        }),
      ),
    ).toBe('共通の批評プロンプト')
    expect(trashPlace(entry({ kind: 'proofSuggestion', parentLabel: '第12話　題　第2幕' }))).toBe('作品A › 第12話　題　第2幕')
    expect(trashKindLabel({ kind: 'critiqueResult', recordIds: [], id: 'e' }, {})).toBe('批評の結果')
    expect(trashKindLabel({ kind: 'revisionIdea', recordIds: [], id: 'e' }, {})).toBe('改稿案')
  })

  it('残り日数と、戻した後のお知らせ', () => {
    expect(daysLeftLabel(30)).toBe('あと30日で完全に削除')
    expect(daysLeftLabel(0)).toBe('まもなく完全に削除')
    expect(restoredMessage({ label: '第3話　旅立ち', copied: false, movedToUnassigned: false })).toBe(
      '「第3話　旅立ち」を元の場所に戻しました',
    )
    expect(restoredMessage({ label: '第2稿', copied: true, movedToUnassigned: false })).toContain('複製として')
    expect(restoredMessage({ label: '案', copied: false, movedToUnassigned: true })).toContain(
      '「どのタイトルにも属さない」に戻しました',
    )
    // 同じ名前の稿があって名前を変えた時は、そのことも伝える
    expect(restoredMessage({ label: '第2稿', copied: false, movedToUnassigned: false, renamed: ['第2稿（復元）'] })).toBe(
      '「第2稿」を元の場所に戻しました（同じ名前の稿があったため、「第2稿（復元）」という名前にしました）',
    )
    expect(
      restoredMessage({
        label: '各幕の採用していなかった稿（3稿）',
        copied: false,
        movedToUnassigned: false,
        renamed: ['第1幕の第2稿（復元）', '第2幕の第2稿（復元）'],
      }),
    ).toBe(
      '「各幕の採用していなかった稿（3稿）」を元の場所に戻しました（同じ名前の稿があったため、2稿の名前に「（復元）」を付けました）',
    )
    expect(restoredMessage({ label: '第2稿', copied: false, movedToUnassigned: false, renamed: [] })).toBe(
      '「第2稿」を元の場所に戻しました',
    )
  })

  it('削除した日ごとにまとめ、特殊ブロックは種類を「特殊ブロック」と書く', () => {
    const t = createTitle(emptyData(), '作品A')
    let data = addEpisode(t.data, t.result).data
    const sp = addSpecial(data, t.result, { chapterId: null, index: 0 }, 'プロローグ')
    data = sp.data
    const ep = Object.keys(data.pieces).find((id) => id !== sp.result)!
    data = deletePiece(data, sp.result)
    data = deletePiece(data, ep)
    const [special, episode] = Object.values(data.trashEntries)
    const now = at(2026, 10, 28, 9)
    data = {
      ...data,
      trashEntries: {
        [special.id]: { ...special, deletedAt: now - DAY_MS },
        [episode.id]: { ...episode, deletedAt: now - 60_000 },
      },
    }
    const days = trashDays(listTrash(data.trashEntries), data.trashRecords, now)
    expect(days.map((d) => d.label)).toEqual(['今日', '昨日'])
    expect(days[0].rows.map((r) => [r.kind, r.label, r.place, r.daysLeft])).toEqual([['話', '第1話', '作品A', 30]])
    expect(days[1].rows.map((r) => [r.kind, r.label, r.daysLeft])).toEqual([['特殊ブロック', 'プロローグ', 29]])
    expect(trashKindLabel(episode, data.trashRecords)).toBe('話')
  })
})
