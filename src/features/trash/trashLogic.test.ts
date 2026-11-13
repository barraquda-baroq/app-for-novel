import { describe, expect, it } from 'vitest'
import { createTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, deletePiece } from '../../domain/storyOps'
import { DAY_MS, listTrash } from '../../domain/trash'
import { emptyData, type TrashEntry } from '../../domain/types'
import { dayLabel, daysLeftLabel, restoredMessage, trashDays, trashDetail, trashKindLabel, trashPlace } from './trashLogic'

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
    // 2.5: 相対比較の作品はホームの棚（タイトルに属さない）。分析は「相対比較 › 作品名」
    expect(trashPlace(entry({ kind: 'benchWork', titleName: '', origin: { titleId: null, index: 0 } }))).toBe('相対比較')
    expect(
      trashPlace(
        entry({ kind: 'benchAnalysis', titleName: '', parentLabel: '銀河の果て', origin: { titleId: null, index: -1 } }),
      ),
    ).toBe('相対比較 › 銀河の果て')
    // 2.6: 資料もホームの棚（タイトルに属さない）。記録は「資料 › 資料名」
    expect(trashPlace(entry({ kind: 'material', titleName: '', origin: { titleId: null, index: 0 } }))).toBe('資料')
    expect(
      trashPlace(
        entry({ kind: 'materialNote', titleName: '', parentLabel: '江戸の暮らし', origin: { titleId: null, index: -1 } }),
      ),
    ).toBe('資料 › 江戸の暮らし')
    expect(trashPlace(entry({ kind: 'materialNote', titleName: '', origin: { titleId: null, index: -1 } }))).toBe('資料')
    expect(trashKindLabel({ kind: 'material', recordIds: [], id: 'e' }, {})).toBe('資料')
    expect(trashKindLabel({ kind: 'materialNote', recordIds: [], id: 'e' }, {})).toBe('資料の記録')
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

  it('2.9: アイデアとアイデアのフォルダは、仕切りに入っていたフォルダを続ける（ホームでもタイトルでも）', () => {
    const home = { titleName: '', origin: { titleId: null, index: 0 } }
    const title = { titleName: '星の庭', origin: { titleId: 't', index: 0 } }
    // フォルダ（1段目）・2段目のフォルダ（親の名前）
    expect(trashPlace(entry({ kind: 'ideaFolder', ...home }))).toBe('どのタイトルにも属さない')
    expect(trashPlace(entry({ kind: 'ideaFolder', ...title }))).toBe('星の庭')
    expect(trashPlace(entry({ kind: 'ideaFolder', ...home, parentLabel: '新作の相談' }))).toBe(
      'どのタイトルにも属さない › 新作の相談',
    )
    expect(trashPlace(entry({ kind: 'ideaFolder', ...title, parentLabel: '場面の相談' }))).toBe('星の庭 › 場面の相談')
    // フォルダの中のカード（親の表記はフォルダの場所）。ホームのカードも親の表記を出す
    expect(trashPlace(entry({ kind: 'idea', ...home, parentLabel: '新作の相談 › 2026/11/12　港町' }))).toBe(
      'どのタイトルにも属さない › 新作の相談 › 2026/11/12　港町',
    )
    expect(trashPlace(entry({ kind: 'idea', ...title, parentLabel: '場面の相談 › 雨の駅' }))).toBe('星の庭 › 場面の相談 › 雨の駅')
    expect(trashPlace(entry({ kind: 'idea', ...title }))).toBe('星の庭')
    expect(trashPlace(entry({ kind: 'idea', ...title, titleName: '' }))).toBe('無題のタイトル')
    expect(trashKindLabel({ kind: 'ideaFolder', recordIds: [], id: 'e' }, {})).toBe('アイデアのフォルダ')
  })

  it('2.9: アイデアのフォルダの件の中身の数（削除したフォルダ自身は数えない。ほかの種類の件は空）', () => {
    const rec = (id: string, table: 'ideaFolders' | 'ideas', entryId = 'e') => ({
      id,
      entryId,
      table,
      record: { id: `${id}-rec` } as never,
      createdAt: 0,
      updatedAt: 0,
    })
    const records = {
      r0: rec('r0', 'ideaFolders'),
      r1: rec('r1', 'ideaFolders'),
      r2: rec('r2', 'ideaFolders'),
      c1: rec('c1', 'ideas'),
      c2: rec('c2', 'ideas'),
      c3: rec('c3', 'ideas'),
      other: rec('other', 'ideas', 'x'),
    }
    expect(trashDetail({ kind: 'ideaFolder', id: 'e', recordIds: ['r0', 'r1', 'r2', 'c1', 'c2', 'c3', 'other'] }, records)).toBe(
      'フォルダ2つ・カード3件',
    )
    expect(trashDetail({ kind: 'ideaFolder', id: 'e', recordIds: ['r0', 'c1'] }, records)).toBe('カード1件')
    expect(trashDetail({ kind: 'ideaFolder', id: 'e', recordIds: ['r0', 'r1'] }, records)).toBe('フォルダ1つ')
    expect(trashDetail({ kind: 'ideaFolder', id: 'e', recordIds: ['r0'] }, records)).toBe('')
    expect(trashDetail({ kind: 'ideaFolder', id: 'e', recordIds: ['r0', 'missing'] }, records)).toBe('')
    expect(trashDetail({ kind: 'idea', id: 'e', recordIds: ['c1'] }, records)).toBe('')
    const now = at(2026, 11, 13, 12)
    const days = trashDays(
      [
        entry({ id: 'e', kind: 'ideaFolder', recordIds: ['r0', 'r1', 'c1'], deletedAt: now - 1 }),
        entry({ id: 'm', deletedAt: now - 2 }),
      ],
      records,
      now,
    )
    expect(days[0].rows.map((r) => [r.id, r.detail])).toEqual([
      ['e', 'フォルダ1つ・カード1件'],
      ['m', ''],
    ])
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
    // 2.9: 元のフォルダが元の場所に無い時（ゴミ箱にある・別のタイトルへ移した…）
    expect(restoredMessage({ label: '案', kind: 'idea', copied: false, movedToUnassigned: false, outOfFolder: true })).toBe(
      '「案」は、元のフォルダが元の場所に無いため、フォルダの外に戻しました',
    )
    expect(
      restoredMessage({ label: '雨の駅', kind: 'ideaFolder', copied: false, movedToUnassigned: false, outOfFolder: true }),
    ).toBe('「雨の駅」は、元のフォルダが元の場所に無いため、1段目のフォルダとして戻しました')
    expect(restoredMessage({ label: '案', kind: 'idea', copied: false, movedToUnassigned: true, outOfFolder: true })).toBe(
      '「案」を「どのタイトルにも属さない」に戻しました（元のタイトルがないため）。元のフォルダが元の場所に無いため、フォルダの外に戻しました',
    )
    expect(restoredMessage({ label: '案', kind: 'idea', copied: true, movedToUnassigned: false, outOfFolder: true })).toBe(
      '「案」を複製として元の場所に戻しました（同じものが残っていたため）。元のフォルダが元の場所に無いため、フォルダの外に戻しました',
    )
    expect(restoredMessage({ label: '案', kind: 'idea', copied: false, movedToUnassigned: false, outOfFolder: false })).toBe(
      '「案」を元の場所に戻しました',
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

  it('Claude の依頼で移した件だけ byClaude（2.7。一覧の「Claude の依頼」の札）', () => {
    const now = at(2026, 11, 9, 12)
    const days = trashDays(
      [
        entry({ id: 'a', kind: 'benchAnalysis', by: 'claude', deletedAt: now - 1 }),
        entry({ id: 'b', kind: 'benchAnalysis', deletedAt: now - 2 }),
      ],
      {},
      now,
    )
    expect(days[0].rows.map((r) => [r.id, r.byClaude])).toEqual([
      ['a', true],
      ['b', false],
    ])
  })
})
