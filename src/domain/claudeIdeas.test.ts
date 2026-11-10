// アイデアへの追記の依頼（2.8）をアプリで処理する: 確かめてから Claude のアイデアの終わりに足し、依頼を消す。
import { describe, expect, it } from 'vitest'
import { ideaEditedByAuthor, liveIdeaAppends, overlayIdeaAppends } from '../claude/ideaAppend'
import { applyIdeaAppends, ideaAppendNotice, type IdeaAppendOutcome } from './claudeIdeas'
import { createTitle, deleteIdea } from './entityOps'
import { hashJson } from './hash'
import { emptyData, type AppData, type ClaudeAccess, type Idea, type IdeaAppend } from './types'

/** 処理した時刻（2026/11/20） */
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0)
/** 依頼を作った時刻（2026/11/13 10:00 日本時間） */
const AT = Date.UTC(2026, 10, 13, 1, 0, 0)
const BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
const HEAD = '2026/11/13のセッションで以下の内容へ変更'

function claudeIdea(id: string, over: Partial<Idea> = {}): Idea {
  const body = over.body ?? BODY
  return {
    id,
    titleId: null,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order: 4,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

function request(id: string, ideaId: string, text: string, over: Partial<IdeaAppend> = {}): IdeaAppend {
  return { id, ideaId, text, readMark: 'abcd1234', source: 'claude', v: 1, createdAt: AT, updatedAt: AT, ...over }
}

/** 「読む＋書き込む」のタイトル（t）と、見せ方を変えたタイトル（read・none）、そのアイデアと依頼 */
function setup(ideas: Idea[], requests: IdeaAppend[], access: Record<string, ClaudeAccess> = {}) {
  let data = emptyData()
  const ids: Record<string, string> = {}
  for (const name of ['書く', '読む', '見せない']) {
    const c = createTitle(data, name)
    data = c.data
    ids[name] = c.result
  }
  const titles = { ...data.titles }
  titles[ids['読む']] = { ...titles[ids['読む']], claudeAccess: access['読む'] ?? 'read' }
  titles[ids['見せない']] = { ...titles[ids['見せない']], claudeAccess: access['見せない'] ?? 'none' }
  const withTitles = (i: Idea): Idea => (i.titleId && ids[i.titleId] !== undefined ? { ...i, titleId: ids[i.titleId] } : i)
  data = {
    ...data,
    titles,
    ideas: Object.fromEntries(ideas.map((i) => [i.id, withTitles(i)])),
    ideaAppends: Object.fromEntries(requests.map((r) => [r.id, r])),
  }
  return { data, ids }
}

const statuses = (r: IdeaAppendOutcome[]) => r.map((o) => [o.requestId, o.status])

describe('applyIdeaAppends', () => {
  it('Claude のアイデアの終わりに1回足し、依頼を消す。並び・済み・場所・見出しは変えず、updatedAt は処理した時刻', () => {
    const idea = claudeIdea('cy-home', { checked: true, checkedAt: 50, order: 7 })
    const { data } = setup([idea], [request('cu-a', 'cy-home', '\n動機を「兄の約束」に変える\r\n・約束は十年前\n\n')])
    const r = applyIdeaAppends(data, NOW)
    expect(statuses(r.result)).toEqual([['cu-a', 'appended']])
    expect(r.result[0]).toEqual({
      requestId: 'cu-a',
      ideaId: 'cy-home',
      label: '2026/11/12 14:32　第3章の動機',
      status: 'appended',
    })
    const body = `${BODY}\n\n${HEAD}\n動機を「兄の約束」に変える\n・約束は十年前`
    expect(r.data.ideas['cy-home']).toEqual({
      ...idea,
      body,
      appendIds: ['cu-a'],
      claudeHash: hashJson(body),
      updatedAt: NOW,
    })
    expect(ideaEditedByAuthor(r.data.ideas['cy-home'])).toBe(false)
    expect(r.data.ideaAppends).toEqual({})
    // ほかの表は同じもの（触った表だけを写す）
    expect(r.data.titles).toBe(data.titles)
    // 依頼が無くなれば、何もしない（同じデータ）
    const again = applyIdeaAppends(r.data, NOW + 1)
    expect(again.data).toBe(r.data)
    expect(again.result).toEqual([])
  })

  it('タイトルのアイデア（「読む＋書き込む」）にも足す。作者が直したカードにも足し、直したままにする', () => {
    const edited = { ...claudeIdea('cy-t', { titleId: '書く' }), body: `${BODY}\n・作者が足した行` }
    const { data, ids } = setup([edited], [request('cu-a', 'cy-t', '内容')])
    const r = applyIdeaAppends(data, NOW)
    expect(statuses(r.result)).toEqual([['cu-a', 'appended']])
    const out = r.data.ideas['cy-t']
    expect(out.body).toBe(`${BODY}\n・作者が足した行\n\n${HEAD}\n内容`)
    expect(out.titleId).toBe(ids['書く'])
    expect(out.claudeHash).toBe(edited.claudeHash)
    expect(ideaEditedByAuthor(out)).toBe(true)
  })

  it('同じアイデアへの2件は作った順に足す（id の順ではない）。Claude に見せる内容（overlayIdeaAppends）と1字も違わない', () => {
    const later = request('cu-a', 'cy-home', '後の依頼', { createdAt: AT + 86_400_000, updatedAt: AT + 86_400_000 })
    const earlier = request('cu-b', 'cy-home', '先の依頼')
    const { data } = setup([claudeIdea('cy-home')], [later, earlier])
    const overlay = overlayIdeaAppends(data.titles, data.ideas, liveIdeaAppends(data))
    const r = applyIdeaAppends(data, NOW)
    expect(statuses(r.result)).toEqual([
      ['cu-b', 'appended'],
      ['cu-a', 'appended'],
    ])
    const out = r.data.ideas['cy-home']
    expect(out.body).toBe(`${BODY}\n\n${HEAD}\n先の依頼\n\n2026/11/14のセッションで以下の内容へ変更\n後の依頼`)
    expect(out.appendIds).toEqual(['cu-b', 'cu-a'])
    expect({ ...out, updatedAt: 0 }).toEqual({ ...overlay.ideas['cy-home'], updatedAt: 0 })
    expect(ideaEditedByAuthor(out)).toBe(false)
  })

  it('2台の端末が同じデータから別々に処理しても、updatedAt のほかは同じ記録になる', () => {
    const { data } = setup(
      [claudeIdea('cy-home'), claudeIdea('cy-t', { titleId: '書く', body: `${BODY}\n直した` })],
      [request('cu-a', 'cy-home', '一'), request('cu-b', 'cy-t', '二'), request('cu-c', 'cy-home', '三')],
    )
    const a = applyIdeaAppends(structuredClone(data), NOW)
    const b = applyIdeaAppends(structuredClone(data), NOW + 60_000)
    expect(a.result).toEqual(b.result)
    for (const id of ['cy-home', 'cy-t']) {
      expect(a.data.ideas[id].updatedAt).toBe(NOW)
      expect(b.data.ideas[id].updatedAt).toBe(NOW + 60_000)
      expect({ ...a.data.ideas[id], updatedAt: 0 }).toEqual({ ...b.data.ideas[id], updatedAt: 0 })
    }
  })

  it('どの結果でも依頼を消す（アイデアは変えない）。新しい版の依頼は触らずに残す', () => {
    const author: Idea = { ...claudeIdea('3f2a9c1b-0000-4000-8000-000000000000'), source: undefined, claudeHash: undefined }
    // 作者のアイデアの id で source だけ claude（Claude のアイデアではない）
    const spoofed = claudeIdea('3f2a9c1b-0000-4000-8000-000000000001')
    const long = claudeIdea('cy-long', { body: `${BODY}\n${'あ'.repeat(99_960)}` })
    const already = claudeIdea('cy-done', { appendIds: ['cu-done'] })
    const trashed = claudeIdea('cy-trashed')
    const { data: seeded } = setup(
      [
        author,
        spoofed,
        long,
        already,
        trashed,
        claudeIdea('cy-read', { titleId: '読む' }),
        claudeIdea('cy-none', { titleId: '見せない' }),
        claudeIdea('cy-home'),
      ],
      [
        request('cu-missing', 'cy-missing', '内容'),
        request('cu-trashed', 'cy-trashed', '内容'),
        request('cu-author', author.id, '内容'),
        request('cu-spoofed', spoofed.id, '内容'),
        request('cu-read', 'cy-read', '内容'),
        request('cu-none', 'cy-none', '内容'),
        request('cu-long', 'cy-long', '内容'),
        request('cu-done', 'cy-done', '内容'),
        request('cu-empty', 'cy-home', ' \n　'),
        request('cu-over', 'cy-home', 'い'.repeat(20_001)),
        request('cu-newer', 'cy-home', '内容', { v: 2 }),
      ],
    )
    const data: AppData = {
      ...deleteIdea(seeded, 'cy-trashed'),
      ideaAppends: {
        ...seeded.ideaAppends,
        // 形の違う依頼（id の形・表の鍵と違う id・空の行）
        'x-1': request('x-1', 'cy-home', '内容', { createdAt: AT + 1 }),
        'cu-key': request('cu-other', 'cy-home', '内容', { createdAt: AT + 2 }),
        'cu-null': null as unknown as IdeaAppend,
      },
    }
    const r = applyIdeaAppends(data, NOW)
    expect(Object.fromEntries(statuses(r.result))).toEqual({
      'cu-null': 'invalid',
      'cu-missing': 'not_found',
      'cu-trashed': 'in_trash',
      'cu-author': 'not_claude',
      'cu-spoofed': 'not_claude',
      'cu-read': 'not_writable',
      'cu-none': 'not_writable',
      'cu-long': 'too_long',
      'cu-done': 'applied',
      'cu-empty': 'invalid',
      'cu-over': 'invalid',
      'x-1': 'invalid',
      'cu-key': 'invalid',
    })
    expect(Object.keys(r.data.ideaAppends)).toEqual(['cu-newer'])
    expect(r.data.ideas).toBe(data.ideas)
    // 新しい版の依頼だけなら、何もしない（同じデータ）
    const only = { ...data, ideaAppends: { 'cu-newer': data.ideaAppends['cu-newer'] } }
    const kept = applyIdeaAppends(only, NOW)
    expect(kept.data).toBe(only)
    expect(kept.result).toEqual([])
  })

  it('別の端末が先に足していた（アイデアの更新が依頼の削除より先に届いた）依頼は、もう一度足さずに消す', () => {
    const { data } = setup([claudeIdea('cy-home')], [request('cu-a', 'cy-home', '内容')])
    const first = applyIdeaAppends(data, NOW).data
    // 依頼の削除がまだ届いていない
    const split = { ...first, ideaAppends: data.ideaAppends }
    const r = applyIdeaAppends(split, NOW + 1)
    expect(statuses(r.result)).toEqual([['cu-a', 'applied']])
    expect(r.data.ideas).toBe(first.ideas)
    expect(r.data.ideaAppends).toEqual({})
  })
})

describe('ideaAppendNotice', () => {
  const o = (
    requestId: string,
    status: IdeaAppendOutcome['status'],
    ideaId = 'cy-a',
    label = '2026/11/12 14:32　第3章の動機',
  ) => ({
    requestId,
    status,
    ideaId,
    label,
  })
  it('1つのアイデアに足したら1行目を出す（同じアイデアに2件足しても）。2つ以上なら件数', () => {
    expect(ideaAppendNotice([o('cu-1', 'appended')])).toBe(
      'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました',
    )
    expect(ideaAppendNotice([o('cu-1', 'appended'), o('cu-2', 'appended')])).toBe(
      'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました',
    )
    expect(ideaAppendNotice([o('cu-1', 'appended'), o('cu-2', 'appended', 'cy-b', '別'), o('cu-3', 'appended')])).toBe(
      'Claude の依頼で、アイデア2件の終わりに追記しました',
    )
  })
  it('足さなかった依頼は理由ごとの数を添える。アイデアが無い・ゴミ箱にある・もう足してあった依頼は知らせない', () => {
    expect(
      ideaAppendNotice([
        o('cu-1', 'appended'),
        o('cu-2', 'not_claude'),
        o('cu-3', 'not_writable'),
        o('cu-4', 'too_long'),
        o('cu-5', 'invalid'),
        o('cu-6', 'not_writable'),
      ]),
    ).toBe(
      'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました。' +
        'Claude の追記の依頼のうち5件は足しませんでした（Claude が作ったアイデアでない1件・書き込めない場所のアイデア2件・' +
        '長くなりすぎる1件・形の違う依頼1件）',
    )
    expect(ideaAppendNotice([o('cu-1', 'not_found'), o('cu-2', 'in_trash'), o('cu-3', 'applied')])).toBe('')
    expect(ideaAppendNotice([])).toBe('')
  })
})
