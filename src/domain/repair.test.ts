import { describe, expect, it } from 'vitest'
import { addIdea, addSubmission, createTitle, ideaSections, moveIdeaStep } from './entityOps'
import { repairData } from './repair'
import { CONTENT_TABLES, isContentTable } from './trash'
import { addChapter, addEpisode, setChaptersEnabled } from './storyOps'
import { flatten } from './structure'
import { emptyData, type AppData, type IdeaFolder, type Submission } from './types'

function sample() {
  const t = createTitle(emptyData(), '作品')
  let data = addEpisode(t.data, t.result).data
  data = addEpisode(data, t.result).data
  data = setChaptersEnabled(data, t.result, true)
  data = addChapter(data, t.result).data
  return { data, titleId: t.result }
}

describe('データの修復', () => {
  it('正常なデータはそのまま返す', () => {
    const { data } = sample()
    const r = repairData(data)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(data)
  })

  it('存在しない章・話への参照、二重に入った話、構成から外れた話を直す', () => {
    const { data, titleId } = sample()
    const [c1, c2] = data.titles[titleId].structure.map((n) => n.id)
    const [p1, p2] = data.chapters[c1].pieceIds
    const broken: AppData = {
      ...data,
      titles: {
        ...data.titles,
        [titleId]: {
          ...data.titles[titleId],
          structure: [
            { type: 'chapter', id: c1 },
            { type: 'chapter', id: 'nope' },
            { type: 'piece', id: 'ghost' },
            { type: 'chapter', id: c2 },
          ],
        },
      },
      chapters: {
        ...data.chapters,
        [c1]: { ...data.chapters[c1], pieceIds: [p1, 'ghost'] },
        [c2]: { ...data.chapters[c2], pieceIds: [p1] },
      },
    }
    const r = repairData(broken)
    expect(r.fixes.length).toBeGreaterThan(0)
    const flat = flatten(r.data, titleId).map((f) => f.pieceId)
    expect(flat).toEqual([p1, p2])
    expect(r.data.chapters[c2].pieceIds).toEqual([])
  })

  it('採用中の稿が存在しない話は採用なしにし、タイトルのないレコードを消す', () => {
    const { data, titleId } = sample()
    const pid = flatten(data, titleId)[0].pieceId
    const broken: AppData = {
      ...data,
      pieces: { ...data.pieces, [pid]: { ...data.pieces[pid], activeVersionId: 'missing', versionIds: ['missing'] } },
      memos: { m1: { id: 'm1', titleId: 'gone', name: 'x', body: '', order: 0, createdAt: 0, updatedAt: 0 } },
    }
    const r = repairData(broken)
    expect(r.data.pieces[pid].activeVersionId).toBeNull()
    expect(r.data.pieces[pid].versionIds).toHaveLength(1)
    expect(r.data.memos).toEqual({})
  })

  it('存在しないタイトルを指すアイデアは「どのタイトルにも属さない」に移り、並べ替えられる', () => {
    let data = emptyData()
    data = addIdea(data, null, 'a').data
    data = addIdea(data, null, 'b').data
    const orphanId = 'orphan'
    data = {
      ...data,
      ideas: {
        ...data.ideas,
        [orphanId]: { id: orphanId, titleId: 'gone', heading: 'o', body: '', order: 0, createdAt: 0, updatedAt: 0 },
      },
    }
    const r = repairData(data)
    expect(r.data.ideas[orphanId].titleId).toBeNull()
    const moved = moveIdeaStep(r.data, orphanId, -1)
    expect(ideaSections(moved)[0].ideas.map((i) => i.heading)).toEqual(['a', 'o', 'b'])
  })
})

describe('壊れたバックアップの修復（項目の欠け）', () => {
  it('どの種類のレコードでも、文字列・数値・配列の欠けを補う', () => {
    const { data, titleId } = sample()
    const pid = flatten(data, titleId)[0].pieceId
    const vid = data.pieces[pid].versionIds[0]
    const chapterId = data.titles[titleId].structure[0].id
    const catId = Object.values(data.settingCategories)[0].id
    const broken = {
      ...data,
      ideas: { i1: { id: 'i1', titleId: null, heading: '思いつき', body: '本文', order: 0 } },
      memos: { m1: { id: 'm1', titleId } },
      versions: { ...data.versions, [vid]: { ...data.versions[vid], name: undefined, note: null } },
      chapters: { ...data.chapters, [chapterId]: { ...data.chapters[chapterId], name: undefined } },
      submissions: { s1: { id: 's1', titleId } },
      settingCategories: { ...data.settingCategories, [catId]: { ...data.settingCategories[catId], name: undefined } },
      settingEntries: { e1: { id: 'e1', titleId, categoryId: catId, fields: [null, { id: 'f', key: 1 }] } },
    } as unknown as AppData
    const r = repairData(broken)
    const d = r.data
    expect(d.ideas.i1).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(d.memos.m1).toMatchObject({ name: '', body: '', order: 0 })
    expect(d.versions[vid]).toMatchObject({ name: '', note: '' })
    expect(d.chapters[chapterId].name).toBe('')
    expect(d.submissions.s1).toMatchObject({ contestName: '', status: 'considering', minChars: null, snapshot: null })
    expect(d.settingCategories[catId].name).toBe('')
    expect(d.settingEntries.e1.fields).toEqual([{ id: 'f', key: '', value: '' }])
    expect(d.settingEntries.e1).toMatchObject({ name: '', body: '' })
  })

  it('存在しない章・話への参照だけが壊れている時も、直した内容を返す', () => {
    const { data, titleId } = sample()
    const broken: AppData = {
      ...data,
      titles: {
        ...data.titles,
        [titleId]: {
          ...data.titles[titleId],
          structure: [...data.titles[titleId].structure, { type: 'piece', id: 'gone' }, { type: 'chapter', id: 'gone2' }],
        },
      },
    }
    const r = repairData(broken)
    expect(r.fixes.length).toBeGreaterThan(0)
    expect(r.data.titles[titleId].structure).toEqual(data.titles[titleId].structure)
  })
})

describe('応募計画の後から足した項目（規定の備考・提出する梗概／キャッチコピー・特記事項）', () => {
  function withSubmission(extra: Record<string, unknown>) {
    const { data, titleId } = sample()
    const s = addSubmission(data, titleId, 'A賞')
    const { limitNote, synopsis, synopsisMin, synopsisMax, catchphrase, catchphraseMin, catchphraseMax, specialNotes, ...old } =
      s.data.submissions[s.result]
    void [limitNote, synopsis, synopsisMin, synopsisMax, catchphrase, catchphraseMin, catchphraseMax, specialNotes]
    const record = { ...old, ...extra } as unknown as Submission
    return { data: { ...s.data, submissions: { [s.result]: record } } as AppData, id: s.result, record }
  }

  it('古いデータ（項目が無い）は直したことにせず、無いまま使う（画面では空・規定なし）', () => {
    const f = withSubmission({})
    const r = repairData(f.data)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(f.data)
    expect(r.data.submissions[f.id].synopsis).toBeUndefined()
  })

  it('形の壊れた値だけ直す（文章は文字列、文字数の規定は数か null）', () => {
    const f = withSubmission({ limitNote: 3, synopsis: null, synopsisMin: '100', synopsisMax: 800, catchphrase: 'コピー' })
    const r = repairData(f.data)
    expect(r.fixes).toContain('応募計画の項目を補いました')
    const s = r.data.submissions[f.id]
    expect(s).toMatchObject({ limitNote: '', synopsis: '', synopsisMin: null, synopsisMax: 800, catchphrase: 'コピー' })
    // 無かった項目は無いまま
    expect('specialNotes' in s).toBe(false)
    expect('catchphraseMax' in s).toBe(false)
  })

  it('応募時の記録の、提出した梗概・キャッチコピーの控えは残す（古い記録には無いまま）', () => {
    const snapshot = { at: 1, charCount: 0, activeVersions: {}, synopsis: '提出した梗概', catchphrase: '提出したコピー' }
    const f = withSubmission({ snapshot })
    const r = repairData(f.data)
    expect(r.fixes).toEqual([])
    expect(r.data.submissions[f.id].snapshot).toEqual(snapshot)
    const bad = withSubmission({ snapshot: { ...snapshot, synopsis: 5 } })
    const fixed = repairData(bad.data).data.submissions[bad.id].snapshot!
    expect(fixed.synopsis).toBeUndefined()
    expect(fixed.catchphrase).toBe('提出したコピー')
  })
})

describe('同期で届いたレコード（キーが並べ替えてある）', () => {
  it('内容が正しければ直したことにせず、同じオブジェクトのまま使う', async () => {
    const { createTitle } = await import('./entityOps')
    const { addEpisode } = await import('./storyOps')
    const { stableStringify } = await import('../sync/merge')
    const t = createTitle(emptyData(), '作品')
    const e = addEpisode(t.data, t.result)
    // クラウドから届いた形（キーの順番が違う）にする
    const sorted = JSON.parse(stableStringify(e.data)) as typeof e.data
    const r = repairData(sorted)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(sorted)
  })
})

describe('相対比較の作品のタグ（2.7）', () => {
  function withWork(extra: Record<string, unknown>): AppData {
    const w = {
      id: 'w1',
      name: '作品',
      author: '著者',
      pdfPlace: '',
      note: '',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    }
    return { ...emptyData(), benchWorks: { w1: w as unknown as AppData['benchWorks'][string] } }
  }

  it('表示できるタグだけにする（配列でない・空・重なり・21字・21個目は外す）。中身が同じなら同じ配列のまま', () => {
    const tags = ['恋愛', '青春']
    const ok = withWork({ tags })
    const r = repairData(ok)
    expect(r.fixes).toEqual([])
    expect(r.data.benchWorks.w1.tags).toBe(tags)
    const many = Array.from({ length: 21 }, (_, i) => `タグ${i + 1}`)
    const fixed = repairData(withWork({ tags: [' 恋愛 ', '', 'ＳＦ', 'SF', 'あ'.repeat(21), 3, ...many] })).data.benchWorks.w1
      .tags
    expect(fixed?.slice(0, 2)).toEqual(['恋愛', 'ＳＦ'])
    expect(fixed).toHaveLength(20)
    expect('tags' in repairData(withWork({ tags: '恋愛' })).data.benchWorks.w1).toBe(false)
  })

  it('自動のタグを取り込んだ印は、形が違えば外す。知らない項目は残す', () => {
    const mark = { analysisId: 'n1', runDate: '2026-11-01', createdAt: 5 }
    const good = repairData(withWork({ autoTagsFrom: mark, future: 1 }))
    expect(good.fixes).toEqual([])
    expect(good.data.benchWorks.w1).toMatchObject({ autoTagsFrom: mark, future: 1 })
    for (const bad of ['n1', { analysisId: 'n1' }, { ...mark, createdAt: Number.NaN }, { ...mark, runDate: 1 }, null]) {
      const r = repairData(withWork({ autoTagsFrom: bad, future: 1 }))
      expect('autoTagsFrom' in r.data.benchWorks.w1).toBe(false)
      expect(r.data.benchWorks.w1).toMatchObject({ future: 1 })
      expect(r.fixes).toContain('相対比較の作品の項目を補いました')
    }
  })

  it('印の足した語（added）は文字列の配列の時だけ残す（空の配列も残す）。形が違えば added だけを外し、印は残す', () => {
    const mark = { analysisId: 'n1', runDate: '2026-11-01', createdAt: 5 }
    for (const added of [['恋愛', '青春'], []]) {
      const work = withWork({ autoTagsFrom: { ...mark, added } })
      const r = repairData(work)
      expect(r.fixes).toEqual([])
      expect(r.data.benchWorks.w1).toBe(work.benchWorks.w1)
    }
    for (const bad of ['恋愛', ['恋愛', 3], { 0: '恋愛' }, null]) {
      const r = repairData(withWork({ autoTagsFrom: { ...mark, added: bad, future: 2 } }))
      expect(r.data.benchWorks.w1.autoTagsFrom).toEqual({ ...mark, future: 2 })
      expect(r.fixes).toContain('相対比較の作品の項目を補いました')
    }
  })
})

describe('2.8: アイデアへの追記の依頼と、Claude が作ったアイデアの項目', () => {
  const claudeIdea = (titleId: string | null, over: Record<string, unknown> = {}) =>
    ({
      id: 'cy-abc',
      titleId,
      heading: '',
      body: '2026/11/12 14:32\n中身',
      checked: false,
      checkedAt: null,
      order: 0,
      source: 'claude',
      v: 1,
      model: 'claude-test',
      claudeHash: 'h.h.1',
      appendIds: ['cu-a'],
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as unknown as AppData['ideas'][string]

  it('依頼は形が違っても残す（アプリが処理して消せるように）。オブジェクトでない・id の合わないものだけ取り除く', () => {
    const { data } = sample()
    const ok = {
      id: 'cu-ok',
      ideaId: 'cy-abc',
      text: '足す',
      readMark: 'abcd1234',
      source: 'claude',
      v: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const odd = { id: 'cu-odd', ideaId: 3, v: 'x' }
    const input = {
      ...data,
      ideaAppends: { [ok.id]: ok, [odd.id]: odd, 'cu-mismatch': { ...ok, id: 'other' }, 'cu-null': null },
    } as unknown as AppData
    const r = repairData(input)
    expect(Object.keys(r.data.ideaAppends).sort()).toEqual(['cu-odd', 'cu-ok'])
    expect(r.data.ideaAppends['cu-odd']).toEqual(odd)
    expect(r.data.ideaAppends['cu-ok']).toEqual(ok)
    expect(r.fixes).toEqual(['形式の壊れたレコードを取り除きました', '形式の壊れたレコードを取り除きました'])
    // 正しい依頼だけなら何も直さない（同じデータ）
    const clean = { ...data, ideaAppends: { [ok.id]: ok } } as unknown as AppData
    expect(repairData(clean).data).toBe(clean)
  })

  it('依頼の表はゴミ箱に入れる表ではない（ゴミ箱の中身に依頼の表があれば取り除く）', () => {
    expect(isContentTable('ideaAppends')).toBe(false)
    expect(isContentTable('trashRequests')).toBe(false)
    expect(CONTENT_TABLES).not.toContain('ideaAppends')
    expect(CONTENT_TABLES).toContain('ideas')
  })

  it('依頼の表が無い古いデータ（2.7 まで）を直す時は、空の表にする', () => {
    const { data } = sample()
    const { ideaAppends: _drop, ...old } = data
    void _drop
    const broken = { ...old, memos: { ...old.memos, bad: null } } as unknown as AppData
    const r = repairData(broken)
    expect(r.fixes).toEqual(['形式の壊れたレコードを取り除きました'])
    expect(r.data.ideaAppends).toEqual({})
  })

  it('アイデアの時刻が Date の範囲の外・負・整数でない時は 0 にする（2.8: コネクタが作る cy-… のカードの日時で落ちないように）', () => {
    const { data, titleId } = sample()
    const ok = claudeIdea(titleId, { id: 'cy-ok', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001 })
    const far = claudeIdea(titleId, { id: 'cy-far', createdAt: 1e16, updatedAt: 1e16 })
    const neg = claudeIdea(titleId, { id: 'cy-neg', createdAt: -1e16, updatedAt: -1 })
    const frac = claudeIdea(titleId, { id: 'cy-frac', createdAt: 1.5, updatedAt: 2 })
    const input: AppData = { ...data, ideas: { [ok.id]: ok, [far.id]: far, [neg.id]: neg, [frac.id]: frac } }
    const r = repairData(input)
    expect(r.data.ideas['cy-ok']).toBe(ok)
    expect(r.data.ideas['cy-far']).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(r.data.ideas['cy-neg']).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(r.data.ideas['cy-frac']).toMatchObject({ createdAt: 0, updatedAt: 2 })
    expect(r.fixes).toEqual(['アイデアの項目を補いました', 'アイデアの項目を補いました', 'アイデアの項目を補いました'])
    // 直した後の時刻はカードの日時（toISOString）で投げない
    for (const i of Object.values(r.data.ideas)) expect(() => new Date(i.updatedAt).toISOString()).not.toThrow()
  })

  it('Claude が作ったアイデアの項目（source・v・model・claudeHash・appendIds）は直さずに残す（壊れた値も。読む所で無いものとして扱う）', () => {
    const { data, titleId } = sample()
    const good = claudeIdea(titleId)
    const odd = claudeIdea(titleId, { id: 'cy-odd', claudeHash: 5, appendIds: 'cu-a', v: 'x', source: 'other' })
    const input: AppData = { ...data, ideas: { [good.id]: good, [odd.id]: odd } }
    const r = repairData(input)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(input)
    // タイトルの無いものは、項目を残したまま「どのタイトルにも属さない」へ
    const orphan: AppData = { ...data, ideas: { [good.id]: claudeIdea('gone') } }
    const moved = repairData(orphan)
    expect(moved.data.ideas[good.id]).toEqual({ ...claudeIdea(null), order: 0 })
    expect(moved.fixes).toEqual(['タイトルのないアイデアを「どのタイトルにも属さない」へ移しました'])
  })
})

describe('2.9: アイデアのフォルダ', () => {
  const folder = (id: string, titleId: string | null, parentId: string | null, over: Record<string, unknown> = {}) =>
    ({
      id,
      titleId,
      parentId,
      name: id,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as unknown as IdeaFolder
  const card = (id: string, titleId: string | null, over: Record<string, unknown> = {}) =>
    ({
      id,
      titleId,
      heading: '',
      body: id,
      checked: false,
      checkedAt: null,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as unknown as AppData['ideas'][string]

  it('正しいフォルダとカードの入っているフォルダは直したことにせず、同じデータのまま（Claude のフォルダの項目も残す）', () => {
    const { data, titleId } = sample()
    const top = folder('A', titleId, null)
    const sub = folder('cf-b', titleId, 'A', { source: 'claude', v: 1, model: 'claude-test' })
    const input: AppData = {
      ...data,
      ideaFolders: { A: top, 'cf-b': sub },
      ideas: { x: card('x', titleId, { folderId: 'cf-b' }), y: card('y', null) },
    }
    const r = repairData(input)
    expect(r.fixes).toEqual([])
    expect(r.data).toBe(input)
  })

  it('フォルダの項目を補う（名前は文字列・並びは数・時刻は範囲の中・親が無い・文字列でなければ null。空の名前は残す）', () => {
    const { data, titleId } = sample()
    const input = {
      ...data,
      ideaFolders: {
        a: folder('a', titleId, null, { name: 3, order: 'x', createdAt: 1e16, updatedAt: -1 }),
        b: { id: 'b', titleId, name: '', order: 1, createdAt: 1, updatedAt: 1 },
        c: folder('c', titleId, null, { parentId: 7 }),
        bad: null,
      },
    } as unknown as AppData
    const r = repairData(input)
    expect(r.data.ideaFolders.a).toEqual({ ...folder('a', titleId, null), name: '', order: 0, createdAt: 0, updatedAt: 0 })
    expect(r.data.ideaFolders.b).toEqual({ id: 'b', titleId, parentId: null, name: '', order: 1, createdAt: 1, updatedAt: 1 })
    expect(r.data.ideaFolders.c.parentId).toBeNull()
    expect(r.data.ideaFolders.bad).toBeUndefined()
    expect(r.fixes.filter((f) => f === 'アイデアのフォルダの項目を補いました')).toHaveLength(3)
    // もう一度通しても何も直さない
    const again = repairData(r.data)
    expect(again.fixes).toEqual([])
    expect(again.data).toBe(r.data)
  })

  it('タイトルの無いフォルダは「どのタイトルにも属さない」へ。1段目はホームの1段目の後ろに、もとの順で。中のつながりはそのまま', () => {
    const { data } = sample()
    const input: AppData = {
      ...data,
      ideaFolders: {
        h1: folder('h1', null, null, { order: 4 }),
        h2: folder('h2', null, 'h1', { order: 9 }),
        o2: folder('o2', 'gone', null, { order: 3 }),
        o1: folder('o1', 'gone', null, { order: 1 }),
        osub: folder('osub', 'gone', 'o1', { order: 5 }),
      },
      ideas: {
        x: card('x', 'gone', { folderId: 'osub', order: 2 }),
      },
    }
    const r = repairData(input)
    const f = r.data.ideaFolders
    expect(Object.values(f).every((x) => x.titleId === null)).toBe(true)
    // ホームの1段目（h1: 4）の後ろに、もとの順（o1 → o2）
    expect(f.o1.order).toBe(5)
    expect(f.o2.order).toBe(6)
    // 2段目は並びもそのまま。ホームの2段目（h2）は1段目の数に入れない
    expect(f.osub).toEqual({ ...folder('osub', null, 'o1', { order: 5 }) })
    expect(f.h1).toBe(input.ideaFolders.h1)
    // カードもホームへ移り、入っているフォルダは残る
    expect(r.data.ideas.x.titleId).toBeNull()
    expect(r.data.ideas.x.folderId).toBe('osub')
    expect(r.fixes.filter((m) => m === 'タイトルのないフォルダを「どのタイトルにも属さない」へ移しました')).toHaveLength(3)
    expect(repairData(r.data).fixes).toEqual([])
  })

  it('カードの入っているフォルダ: 文字列でない値（null など）だけ項目ごと除く。無いフォルダ・別の仕切りのフォルダを指す文字列は消さない。項目は足さない', () => {
    const { data, titleId } = sample()
    const input = {
      ...data,
      ideaFolders: { A: folder('A', titleId, null) },
      ideas: {
        n: card('n', titleId, { folderId: null }),
        num: card('num', titleId, { folderId: 3 }),
        dangling: card('dangling', titleId, { folderId: 'missing' }),
        other: card('other', null, { folderId: 'A' }),
        none: card('none', titleId),
      },
    } as unknown as AppData
    const r = repairData(input)
    expect('folderId' in r.data.ideas.n).toBe(false)
    expect('folderId' in r.data.ideas.num).toBe(false)
    expect(r.data.ideas.dangling).toBe(input.ideas.dangling)
    expect(r.data.ideas.other).toBe(input.ideas.other)
    expect(r.data.ideas.none).toBe(input.ideas.none)
    expect('folderId' in r.data.ideas.none).toBe(false)
    expect(r.fixes).toEqual(['アイデアのフォルダの参照を直しました', 'アイデアのフォルダの参照を直しました'])
    expect(repairData(r.data).fixes).toEqual([])
  })

  it('フォルダの表が無い古いデータ（2.8 まで）は空の表にする。フォルダのゴミ箱の件と中身は残す', () => {
    const { data, titleId } = sample()
    const { ideaFolders: _drop, ...old } = data
    void _drop
    const entry = {
      id: 'e1',
      kind: 'ideaFolder',
      label: '場面の相談',
      titleName: '作品',
      origin: { titleId, index: 0, prevId: null },
      recordIds: ['r1', 'r2'],
      reason: 'deleted',
      deletedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const r1 = { id: 'r1', entryId: 'e1', table: 'ideaFolders', record: folder('A', titleId, null), createdAt: 1, updatedAt: 1 }
    const r2 = {
      id: 'r2',
      entryId: 'e1',
      table: 'ideas',
      record: card('x', titleId, { folderId: 'A' }),
      createdAt: 1,
      updatedAt: 1,
    }
    const input = {
      ...old,
      trashEntries: { e1: entry },
      trashRecords: { r1, r2 },
      memos: { ...old.memos, bad: null },
    } as unknown as AppData
    const r = repairData(input)
    expect(r.data.ideaFolders).toEqual({})
    expect(r.data.trashEntries.e1).toEqual(entry)
    expect(Object.keys(r.data.trashRecords).sort()).toEqual(['r1', 'r2'])
    expect(r.fixes).toEqual(['形式の壊れたレコードを取り除きました'])
    expect(isContentTable('ideaFolders')).toBe(true)
  })
})
