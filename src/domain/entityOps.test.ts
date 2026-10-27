import { describe, expect, it } from 'vitest'
import { parseBackup, toBackup } from './backup'
import { diffSummary, diffTexts } from './diff'
import {
  addCategory,
  addEntry,
  addIdea,
  addMemo,
  addSubmission,
  categoriesOf,
  createTitle,
  deleteTitle,
  entriesOf,
  ideaSections,
  memosOf,
  moveIdeaStep,
  moveIdeaToSection,
  moveSubmissionStep,
  recordSubmissionSnapshot,
  submissionsOf,
  titleSummary,
  updateCategory,
} from './entityOps'
import { addEpisode, setActiveVersion, updateVersion } from './storyOps'
import { countChars, textStats } from './text'
import { DomainError, emptyData } from './types'

describe('アイデア領域', () => {
  it('タイトルを増やすと仕切りが増え、どのタイトルにも属さない仕切りが常に最後にある', () => {
    let data = emptyData()
    expect(ideaSections(data).map((s) => s.name)).toEqual(['どのタイトルにも属さない'])
    data = createTitle(data, '作品A').data
    data = createTitle(data, '作品B').data
    expect(ideaSections(data).map((s) => s.name)).toEqual(['作品A', '作品B', 'どのタイトルにも属さない'])
  })

  it('アイデアを仕切り間で移動・並べ替えでき、タイトル削除時はどのタイトルにも属さないへ移る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const a = addIdea(data, null, '案1')
    data = a.data
    const b = addIdea(data, null, '案2')
    data = b.data
    data = moveIdeaStep(data, b.result, -1)
    expect(ideaSections(data)[1].ideas.map((i) => i.heading)).toEqual(['案2', '案1'])
    data = moveIdeaToSection(data, a.result, t.result)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['案1'])
    data = deleteTitle(data, t.result)
    expect(ideaSections(data)).toHaveLength(1)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['案2', '案1'])
  })
})

describe('タイトル配下', () => {
  it('新しいタイトルにはキャラクター・世界観の設定項目が用意され、項目は後から任意に追加できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    expect(categoriesOf(data, t.result).map((c) => c.name)).toEqual(['キャラクター', '世界観'])
    const c = addCategory(data, t.result, '用語集', ['読み', '意味'])
    data = c.data
    const e = addEntry(data, c.result, '魔導炉')
    data = e.data
    expect(entriesOf(data, c.result)[0].fields.map((f) => f.key)).toEqual(['読み', '意味'])
    // テンプレートを変えても既存エントリのフィールドは変わらない
    data = updateCategory(data, c.result, { fieldTemplate: ['読み'] })
    expect(entriesOf(data, c.result)[0].fields).toHaveLength(2)
  })

  it('メモはタイトル内で管理される', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addMemo(t.data, t.result, '伏線メモ').data
    expect(memosOf(data, t.result).map((m) => m.name)).toEqual(['伏線メモ'])
  })

  it('タイトルを削除すると配下のデータがすべて消える', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    data = addEpisode(data, t.result).data
    data = addMemo(data, t.result).data
    data = addSubmission(data, t.result, '新人賞').data
    data = deleteTitle(data, t.result)
    expect(data).toEqual({ ...emptyData() })
  })

  it('採用原稿の総文字数と、採用原稿がない話の数を集計できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    data = updateVersion(data, data.pieces[e1.result].versionIds[0], { body: 'あいう えお\nかき' })
    const e2 = addEpisode(data, t.result)
    data = setActiveVersion(e2.data, e2.result, null)
    expect(titleSummary(data, t.result)).toEqual({ episodes: 2, specials: 0, missingActive: 1, activeChars: 7 })
  })
})

describe('戦略', () => {
  it('応募順を並べ替えられ、応募時点の採用原稿を記録できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    const v1 = data.pieces[e1.result].versionIds[0]
    data = updateVersion(data, v1, { body: '本文本文' })
    const s1 = addSubmission(data, t.result, 'A賞')
    data = s1.data
    const s2 = addSubmission(data, t.result, 'B賞')
    data = s2.data
    data = moveSubmissionStep(data, s2.result, -1)
    expect(submissionsOf(data, t.result).map((s) => s.contestName)).toEqual(['B賞', 'A賞'])
    data = recordSubmissionSnapshot(data, s1.result)
    expect(data.submissions[s1.result].snapshot).toMatchObject({ charCount: 4, activeVersions: { [e1.result]: v1 } })
  })
})

describe('文字数', () => {
  it('空白・改行を除いて数え、サロゲートペアも1文字とする', () => {
    expect(countChars('あい う\nえ　お𠮷')).toBe(6)
    const s = textStats('あいう\n\nえお')
    expect(s).toMatchObject({ chars: 5, charsWithSpaces: 5, lines: 3, manuscriptPages: 1 })
    expect(textStats('').manuscriptPages).toBe(0)
    expect(textStats('あ'.repeat(401)).manuscriptPages).toBe(2)
  })
})

describe('差分', () => {
  it('変更箇所を文字単位で示す', () => {
    const segs = diffTexts('今日は晴れ。\n明日は雨。\n', '今日は快晴。\n明日は雨。\n')
    const changed = segs.filter((s) => s.kind !== 'same')
    expect(changed.some((s) => s.kind === 'add' && s.text.includes('快'))).toBe(true)
    expect(changed.some((s) => s.kind === 'del' && s.text.includes('れ'))).toBe(true)
    // 2行目は変更されていない
    expect(changed.every((s) => !s.text.includes('明日'))).toBe(true)
    const joinedTarget = segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('')
    const joinedBase = segs.filter((s) => s.kind !== 'add').map((s) => s.text).join('')
    expect(joinedTarget).toBe('今日は快晴。\n明日は雨。\n')
    expect(joinedBase).toBe('今日は晴れ。\n明日は雨。\n')
    expect(diffSummary(segs).added).toBeGreaterThan(0)
  })
})

describe('バックアップ', () => {
  it('書き出したものを読み込むと同じデータに戻る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addEpisode(t.data, t.result).data
    const json = JSON.stringify(toBackup(data))
    expect(parseBackup(json)).toEqual(data)
  })

  it('形式が違うファイルは拒否する', () => {
    expect(() => parseBackup('{}')).toThrow(DomainError)
    expect(() => parseBackup('not json')).toThrow(DomainError)
    expect(() => parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 1, data: { titles: [] } }))).toThrow(
      DomainError,
    )
  })
})
