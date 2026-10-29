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
  compareSnapshotWithCurrent,
  createTitle,
  deleteSubmission,
  deleteTitle,
  entriesOf,
  ideaSections,
  memosOf,
  missingActiveLabel,
  moveIdeaStep,
  moveIdeaTo,
  moveIdeaToSection,
  moveSubmissionStep,
  moveTitleTo,
  recordSubmissionSnapshot,
  snapshotPieceBody,
  snapshotText,
  sortedTitles,
  submissionsReferencingVersion,
  submissionsOf,
  titleLastEdited,
  titleSummary,
  updateCategory,
  updateSubmission,
} from './entityOps'
import { addEpisode, deleteVersion, setActiveVersion, updateVersion } from './storyOps'
import { countChars, textStats } from './text'
import { repairData } from './repair'
import { listTrash, restoreTrashEntry } from './trash'
import { DomainError, emptyData, type AppData, type Submission } from './types'

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

  it('タイトルを削除すると配下のデータがすべてゴミ箱の1件にまとめて移る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    data = addEpisode(data, t.result).data
    data = addMemo(data, t.result).data
    data = addSubmission(data, t.result, '新人賞').data
    data = deleteTitle(data, t.result)
    expect({ ...data, trashEntries: {}, trashRecords: {} }).toEqual(emptyData())
    const entries = Object.values(data.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'title', label: '作品A', titleName: '作品A', reason: 'deleted' })
    // タイトル・設定項目2・話・稿・メモ・応募計画
    expect(entries[0].recordIds).toHaveLength(7)
    expect(data.trashRecords[entries[0].recordIds[0]]).toMatchObject({ table: 'titles', record: { id: t.result } })
  })

  it('最終編集日時には原稿の編集も含まれる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addEpisode(t.data, t.result).data
    const vid = Object.keys(data.versions)[0]
    data = { ...data, versions: { ...data.versions, [vid]: { ...data.versions[vid], updatedAt: 9_999_999_999_999 } } }
    expect(titleLastEdited(data, t.result)).toBe(9_999_999_999_999)
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
    expect(titleSummary(data, t.result)).toEqual({
      episodes: 2,
      specials: 0,
      missingActive: 1,
      missingEpisodes: 1,
      missingSpecials: 0,
      missingActs: 0,
      activeChars: 7,
    })
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

describe('応募計画の規定の備考・提出する梗概／キャッチコピー・特記事項', () => {
  const EXTRAS: Partial<Submission> = {
    limitNote: 'ルビ不可。章タイトル必須。',
    synopsis: '海辺の町に住む少女が、嘘をついて世界を救う話。',
    synopsisMin: 100,
    synopsisMax: 800,
    catchphrase: 'その嘘は、世界を救うためについた。',
    catchphraseMin: null,
    catchphraseMax: 40,
    specialNotes: '応募フォームの「作品のセールスポイント」欄にも同じ文を使う',
  }

  function setup() {
    const t = createTitle(emptyData(), '作品A')
    const e1 = addEpisode(t.data, t.result)
    let data = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '本文本文' })
    const s = addSubmission(data, t.result, 'A賞')
    data = updateSubmission(s.data, s.result, EXTRAS)
    return { data, titleId: t.result, id: s.result }
  }

  it('新しい応募計画は空・規定なしで作る', () => {
    const t = createTitle(emptyData(), '作品A')
    const s = addSubmission(t.data, t.result, 'A賞')
    expect(s.data.submissions[s.result]).toMatchObject({
      limitNote: '',
      synopsis: '',
      synopsisMin: null,
      synopsisMax: null,
      catchphrase: '',
      catchphraseMin: null,
      catchphraseMax: null,
      specialNotes: '',
    })
  })

  it('応募時の原稿を記録すると、その時の梗概・あらすじとキャッチコピーも控える（後から書き直しても変わらない）', () => {
    const f = setup()
    let data = recordSubmissionSnapshot(f.data, f.id)
    const snap = data.submissions[f.id].snapshot!
    expect(snap).toMatchObject({ charCount: 4, synopsis: EXTRAS.synopsis, catchphrase: EXTRAS.catchphrase })
    data = updateSubmission(data, f.id, { synopsis: '書き直した梗概', catchphrase: '新しいコピー' })
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: EXTRAS.synopsis, catchphrase: EXTRAS.catchphrase })
    // 記録し直すと今の内容になる
    data = recordSubmissionSnapshot(data, f.id)
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: '書き直した梗概', catchphrase: '新しいコピー' })
    // 書いていなければ空で控える（古いデータで項目が無くても）
    const { synopsis: _s, catchphrase: _c, ...old } = data.submissions[f.id]
    data = { ...data, submissions: { ...data.submissions, [f.id]: old as Submission } }
    data = recordSubmissionSnapshot(data, f.id)
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: '', catchphrase: '' })
  })

  it('バックアップ・ゴミ箱（応募計画の削除・タイトルの削除）から戻しても、項目と応募時の控えはそのまま', () => {
    const f = setup()
    const data = recordSubmissionSnapshot(f.data, f.id)
    const before = data.submissions[f.id]
    expect(parseBackup(JSON.stringify(toBackup(data))).submissions[f.id]).toEqual(before)
    for (const del of [(d: AppData) => deleteSubmission(d, f.id), (d: AppData) => deleteTitle(d, f.titleId)]) {
      const deleted = del(data)
      expect(deleted.submissions[f.id]).toBeUndefined()
      const restored = restoreTrashEntry(deleted, listTrash(deleted.trashEntries)[0].id).data
      expect(restored.submissions[f.id]).toEqual(before)
    }
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
    const joinedTarget = segs
      .filter((s) => s.kind !== 'del')
      .map((s) => s.text)
      .join('')
    const joinedBase = segs
      .filter((s) => s.kind !== 'add')
      .map((s) => s.text)
      .join('')
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

describe('応募時の原稿の記録', () => {
  it('話ごとの稿と本文の控えを残し、稿の名前変更では「本文が変わった」としない', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    const v1 = data.pieces[e1.result].versionIds[0]
    data = updateVersion(data, v1, { body: '応募した本文' })
    const s = addSubmission(data, t.result, 'A賞')
    data = recordSubmissionSnapshot(s.data, s.result)
    const snap = data.submissions[s.result].snapshot!
    expect(snap.pieces![e1.result]).toMatchObject({ label: '第1話', versionName: '第1稿', chars: 6 })
    expect(snapshotPieceBody(data, snap.pieces![e1.result])).toBe('応募した本文')
    expect(snapshotText(data, snap, '作品A')).toContain('応募した本文')
    expect(submissionsReferencingVersion(data, v1).map((x) => x.contestName)).toEqual(['A賞'])

    data = updateVersion(data, v1, { name: '決定稿', note: 'メモだけ変更' })
    expect(compareSnapshotWithCurrent(data, t.result, snap)).toMatchObject({ switched: [], edited: [], charDelta: 0 })
    data = updateVersion(data, v1, { body: '応募後に直した本文' })
    expect(compareSnapshotWithCurrent(data, t.result, snap).edited).toEqual([e1.result])
    // 稿を消しても、応募した本文は記録に残る
    data = deleteVersion(data, v1)
    expect(snapshotPieceBody(data, data.submissions[s.result].snapshot!.pieces![e1.result])).toBe('応募した本文')
  })

  it('同じ本文は複数の応募記録で1つだけ保存され、使われなくなった控えは消える', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    const e1 = addEpisode(t.data, t.result)
    data = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '同じ本文' })
    const a = addSubmission(data, t.result, 'A賞')
    const b = addSubmission(a.data, t.result, 'B賞')
    data = recordSubmissionSnapshot(b.data, a.result)
    data = recordSubmissionSnapshot(data, b.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(1)
    data = deleteSubmission(data, a.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(1)
    data = deleteSubmission(data, b.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(0)
  })

  it('古い記録（本文が記録の中にある）は読み込み時に控えの表へ移される', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    const s = addSubmission(t.data, t.result, 'A賞')
    data = s.data
    const legacy = {
      at: 1,
      charCount: 2,
      activeVersions: { p: 'v' },
      order: ['p'],
      pieces: {
        p: {
          kind: 'episode',
          label: '第1話',
          subtitle: '',
          versionId: 'v',
          versionName: '第1稿',
          chars: 2,
          body: '古い',
          hash: 'h',
        },
      },
    } as unknown as NonNullable<AppData['submissions'][string]['snapshot']>
    data = { ...data, submissions: { [s.result]: { ...data.submissions[s.result], snapshot: legacy } } }
    const repaired = repairData(data).data
    const piece = repaired.submissions[s.result].snapshot!.pieces!.p
    expect(piece.body).toBeUndefined()
    expect(snapshotPieceBody(repaired, piece)).toBe('古い')
  })

  it('採用原稿なしの話と特殊ブロックを分けて表記する', () => {
    expect(missingActiveLabel(0, 0)).toBe('')
    expect(missingActiveLabel(2, 0)).toBe('採用原稿なし 2話')
    expect(missingActiveLabel(1, 1)).toBe('採用原稿なし 1話＋特殊1')
    expect(missingActiveLabel(0, 1)).toBe('採用原稿なし 特殊1')
  })
})

describe('位置を指定した並べ替え', () => {
  it('アイデアを別の仕切りの任意の位置へ、タイトルを任意の位置へ移せる', () => {
    let data = emptyData()
    const t = createTitle(data, 'A')
    data = createTitle(t.data, 'B').data
    const ids: string[] = []
    for (const h of ['1', '2', '3']) {
      const r = addIdea(data, null, h)
      data = r.data
      ids.push(r.result)
    }
    data = moveIdeaTo(data, ids[2], null, 0)
    expect(
      ideaSections(data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['3', '1', '2'])
    data = moveIdeaTo(data, ids[0], t.result, 0)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['1'])
    expect(
      ideaSections(data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['3', '2'])
    data = moveTitleTo(data, t.result, 5)
    expect(sortedTitles(data).map((x) => x.name)).toEqual(['B', 'A'])
  })
})
