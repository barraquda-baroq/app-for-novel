import { describe, expect, it } from 'vitest'
import { addIdea, createTitle, updateTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, setActiveVersion, setChaptersEnabled, updateVersion } from '../../domain/storyOps'
import { emptyData, type AppData } from '../../domain/types'
import { charsLabel, deleteTitleMessage, episodesLabel, missingLabel, parseHomeView, synopsisExcerpt, titleCardInfo } from './homeLogic'

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
  it('削除されるものと、アイデアが「どのタイトルにも属さない」へ移ることを書く', () => {
    const msg = deleteTitleMessage({ summary: { episodes: 4, specials: 1, missingActive: 0, missingEpisodes: 0, missingSpecials: 0, activeChars: 0 }, versionCount: 7, ideaCount: 2 })
    expect(msg).toContain('すべての話・推敲バージョン・設定・戦略・メモが削除されます')
    expect(msg).toContain('全4話、特殊ブロック1件、推敲バージョン7稿')
    expect(msg).toContain('アイデア（2件）は削除されず、「どのタイトルにも属さない」へ移ります')
  })

  it('アイデアがなくても移動先を説明する', () => {
    const msg = deleteTitleMessage({ summary: { episodes: 0, specials: 0, missingActive: 0, missingEpisodes: 0, missingSpecials: 0, activeChars: 0 }, versionCount: 0, ideaCount: 0 })
    expect(msg).toContain('全0話、推敲バージョン0稿')
    expect(msg).not.toContain('特殊ブロック')
    expect(msg).toContain('「どのタイトルにも属さない」へ移ります')
  })
})
