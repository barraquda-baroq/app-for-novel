import { describe, expect, it } from 'vitest'
import { addIdea, createTitle, updateTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, setActiveVersion, setChaptersEnabled, updateVersion } from '../../domain/storyOps'
import { emptyData, type AppData } from '../../domain/types'
import {
  BACKUP_REMIND_AFTER_MS,
  BACKUP_SNOOZE_MS,
  backupReminderDue,
  charsLabel,
  deleteTitleMessage,
  episodesLabel,
  hasManuscriptText,
  missingLabel,
  parseHomeView,
  parseTimestamp,
  synopsisExcerpt,
  titleCardInfo,
} from './homeLogic'

describe('ホームの表示の保存値', () => {
  it('titles / ideas 以外は null', () => {
    expect(parseHomeView('titles')).toBe('titles')
    expect(parseHomeView('ideas')).toBe('ideas')
    expect(parseHomeView('other')).toBeNull()
    expect(parseHomeView(null)).toBeNull()
    expect(parseHomeView(undefined)).toBeNull()
  })
})

describe('あらすじの抜粋', () => {
  it('改行や連続した空白をまとめ、長い場合は切り詰める', () => {
    expect(synopsisExcerpt('  一行目\n\n二行目　 三 ')).toBe('一行目 二行目 三')
    expect(synopsisExcerpt('あ'.repeat(10), 5)).toBe('あああああ…')
    expect(synopsisExcerpt('')).toBe('')
  })
})

function seedTitle(): { data: AppData; titleId: string; pieceIds: string[] } {
  let data = emptyData()
  const t = createTitle(data, ' 星の海 ')
  data = t.data
  const pieceIds: string[] = []
  for (const body of ['一話目の本文', '二 話 目']) {
    const r = addEpisode(data, t.result)
    data = r.data
    data = updateVersion(data, data.pieces[r.result].versionIds[0], { body })
    pieceIds.push(r.result)
  }
  return { data, titleId: t.result, pieceIds }
}

describe('タイトルカードの情報', () => {
  it('話数・採用原稿の文字数・採用原稿なしの話数・章の有無・アイデア数をまとめる', () => {
    const seeded = seedTitle()
    let data = seeded.data
    const { titleId, pieceIds } = seeded
    let info = titleCardInfo(data, titleId)!
    expect(info.name).toBe('星の海')
    expect(info.summary).toMatchObject({ episodes: 2, specials: 0, missingActive: 0, activeChars: 9 })
    expect(info.chaptersEnabled).toBe(false)
    expect(info.ideaCount).toBe(0)
    expect(info.versionCount).toBe(2)

    data = setActiveVersion(data, pieceIds[1], null)
    data = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    data = setChaptersEnabled(data, titleId, true)
    data = addIdea(data, titleId, '', '案').data
    data = addIdea(data, null, '', '別').data
    data = updateTitle(data, titleId, { synopsis: '星の海を\n渡る' })
    info = titleCardInfo(data, titleId)!
    expect(info.summary).toMatchObject({ episodes: 2, specials: 1, missingActive: 1, activeChars: 6 })
    expect(missingLabel(info.summary)).toBe('採用原稿なし 1話')
    expect(info.chaptersEnabled).toBe(true)
    expect(info.ideaCount).toBe(1)
    expect(info.versionCount).toBe(3)
    expect(info.synopsis).toBe('星の海を 渡る')
  })

  it('存在しないタイトルは null。名前が空なら「無題のタイトル」', () => {
    expect(titleCardInfo(emptyData(), 'x')).toBeNull()
    const t = createTitle(emptyData(), '')
    const data = updateTitle(t.data, t.result, { name: '  ' })
    expect(titleCardInfo(data, t.result)!.name).toBe('無題のタイトル')
  })

  it('採用原稿なしの表記: 特殊ブロックは「話」に数えない', () => {
    const seeded = seedTitle()
    let data = seeded.data
    expect(missingLabel(titleCardInfo(data, seeded.titleId)!.summary)).toBe('')
    const sp = addSpecial(data, seeded.titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = setActiveVersion(sp.data, sp.result, null)
    expect(missingLabel(titleCardInfo(data, seeded.titleId)!.summary)).toBe('採用原稿なし 特殊1')
    data = setActiveVersion(data, seeded.pieceIds[1], null)
    expect(missingLabel(titleCardInfo(data, seeded.titleId)!.summary)).toBe('採用原稿なし 1話＋特殊1')
  })

  it('話数と文字数の表記', () => {
    expect(episodesLabel({ episodes: 3, specials: 0 })).toEqual({ main: '全3話', sub: null })
    expect(episodesLabel({ episodes: 0, specials: 2 })).toEqual({ main: '全0話', sub: '特殊2' })
    expect(charsLabel(12345)).toBe('12,345字')
  })
})

describe('タイトル削除の確認文', () => {
  it('ゴミ箱へ移るものと、アイデアが「どのタイトルにも属さない」へ移ることを書く', () => {
    const msg = deleteTitleMessage({
      summary: { episodes: 4, specials: 1, missingActive: 0, missingEpisodes: 0, missingSpecials: 0, activeChars: 0 },
      versionCount: 7,
      ideaCount: 2,
    })
    expect(msg).toContain(
      'すべての話・推敲バージョン・設定項目・戦略・メモ（全4話、特殊ブロック1件、推敲バージョン7稿）をまとめてゴミ箱に移します。',
    )
    expect(msg).toContain('30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。')
    expect(msg).toContain('アイデア（2件）は削除されず、「どのタイトルにも属さない」へ移ります')
  })

  it('アイデアがなくても移動先を説明する', () => {
    const msg = deleteTitleMessage({
      summary: { episodes: 0, specials: 0, missingActive: 0, missingEpisodes: 0, missingSpecials: 0, activeChars: 0 },
      versionCount: 0,
      ideaCount: 0,
    })
    expect(msg).toContain('全0話、推敲バージョン0稿')
    expect(msg).not.toContain('特殊ブロック')
    expect(msg).toContain('「どのタイトルにも属さない」へ移ります')
  })
})

describe('バックアップのお知らせ', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  const day = 24 * 60 * 60 * 1000

  it('原稿の本文に空白以外の文字があるか', () => {
    let data = emptyData()
    const t = createTitle(data, '星の海')
    data = t.data
    expect(hasManuscriptText(data)).toBe(false)
    const e = addEpisode(data, t.result)
    data = e.data
    const vid = data.pieces[e.result].versionIds[0]
    expect(hasManuscriptText(data)).toBe(false)
    expect(hasManuscriptText(updateVersion(data, vid, { body: ' \n　\t' }))).toBe(false)
    expect(hasManuscriptText(updateVersion(data, vid, { body: '\n　月' }))).toBe(true)
  })

  it('原稿があり、まだ書き出していないか14日以上前なら出す。「後で」から7日間は出さない', () => {
    const due = (o: { hasManuscript?: boolean; lastBackup?: number | null; snoozedAt?: number | null }) =>
      backupReminderDue({ hasManuscript: true, lastBackup: null, snoozedAt: null, now, ...o })
    expect(BACKUP_REMIND_AFTER_MS).toBe(14 * day)
    expect(BACKUP_SNOOZE_MS).toBe(7 * day)
    expect(due({})).toBe(true)
    expect(due({ hasManuscript: false })).toBe(false)
    expect(due({ lastBackup: now - 13 * day })).toBe(false)
    expect(due({ lastBackup: now - 14 * day })).toBe(true)
    expect(due({ lastBackup: now - 30 * day, snoozedAt: now - 6 * day })).toBe(false)
    expect(due({ lastBackup: now - 30 * day, snoozedAt: now - 7 * day })).toBe(true)
    expect(due({ snoozedAt: now - 1000 })).toBe(false)
    // 時計が戻された（未来の日時）時は、経っていないものとして扱う
    expect(due({ lastBackup: now + day })).toBe(false)
    expect(due({ snoozedAt: now + day })).toBe(false)
  })

  it('保存値の日時を読む', () => {
    expect(parseTimestamp(String(now))).toBe(now)
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp('abc')).toBeNull()
  })
})
