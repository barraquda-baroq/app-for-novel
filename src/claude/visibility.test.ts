// Claude に見せる内容（claudeView）のアイデア（2.8）: Claude が作ったホームのアイデアだけ見せ、まだアプリが足していない追記の依頼を
// 当てた形で見せる（アプリが当てた後と1字も違わない）。ゴミ箱へ移す依頼の出ているアイデアは見せない。
import { describe, expect, it } from 'vitest'
import { applyIdeaAppends } from '../domain/claudeIdeas'
import { createTitle } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import { repairData } from '../domain/repair'
import { emptyData, type AppData, type ClaudeAccess, type Idea, type IdeaAppend } from '../domain/types'
import { trashRequestId } from './derivedId'
import { ideaReadMark } from './ideaAppend'
import { claudeView } from './visibility'

const BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
const AT = Date.UTC(2026, 10, 13, 1, 0, 0)

function idea(id: string, titleId: string | null, over: Partial<Idea> = {}): Idea {
  return {
    id,
    titleId,
    heading: '',
    body: BODY,
    checked: false,
    checkedAt: null,
    order: 0,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(BODY),
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

const author = (id: string, titleId: string | null): Idea => ({
  id,
  titleId,
  heading: '',
  body: '作者のアイデア',
  order: 0,
  createdAt: 1,
  updatedAt: 1,
})

function request(id: string, ideaId: string, text: string, over: Partial<IdeaAppend> = {}): IdeaAppend {
  return { id, ideaId, text, readMark: ideaReadMark(BODY), source: 'claude', v: 1, createdAt: AT, updatedAt: AT, ...over }
}

/** 読む＋書き込む（w）・読むだけ（r）・見せない（n）のタイトル */
function setup(ideas: (ids: Record<'w' | 'r' | 'n', string>) => Idea[], requests: IdeaAppend[] = []) {
  let data = emptyData()
  const ids = {} as Record<'w' | 'r' | 'n', string>
  const access: Record<'w' | 'r' | 'n', ClaudeAccess> = { w: 'write', r: 'read', n: 'none' }
  for (const k of ['w', 'r', 'n'] as const) {
    const c = createTitle(data, `タイトル${k}`)
    data = { ...c.data, titles: { ...c.data.titles, [c.result]: { ...c.data.titles[c.result], claudeAccess: access[k] } } }
    ids[k] = c.result
  }
  data = {
    ...data,
    ideas: Object.fromEntries(ideas(ids).map((i) => [i.id, i])),
    ideaAppends: Object.fromEntries(requests.map((r) => [r.id, r])),
  }
  return { data, ids }
}

describe('claudeView: アイデア', () => {
  it('ホームのアイデアは Claude が作ったものだけ見せる。タイトルのアイデアは今までどおり（見せないタイトルは除く）', () => {
    const { data } = setup((t) => [
      idea('cy-home0001', null),
      author('author-home', null),
      // source が claude でも id が UUID・id が cy- でも source が無いものは、作者のアイデアとして扱う
      idea('a1b2c3d4-0000-4000-8000-000000000001', null),
      { ...idea('cy-nosource', null), source: undefined },
      idea('cy-write001', t.w),
      idea('cy-read0001', t.r),
      idea('cy-none0001', t.n),
      author('author-write', t.w),
      author('author-none', t.n),
    ])
    const v = claudeView(data)
    expect(Object.keys(v.ideas).sort()).toEqual(['author-write', 'cy-home0001', 'cy-read0001', 'cy-write001'])
  })

  it('タイトルが無いアイデア（修復でホームに入る）は、Claude が作ったものならホームのアイデアとして見せる', () => {
    const { data } = setup(() => [idea('cy-orphan01', 'gone-title'), author('author-orphan', 'gone-title')])
    const raw = repairData(data).data
    expect(raw.ideas['cy-orphan01'].titleId).toBeNull()
    expect(Object.keys(claudeView(raw).ideas)).toEqual(['cy-orphan01'])
  })

  it('ゴミ箱へ移す依頼の出ているアイデアは見せない（その追記の依頼も当てない）', () => {
    const add = request('cu-a', 'cy-home0001', '追記')
    const { data } = setup(() => [idea('cy-home0001', null), idea('cy-home0002', null)], [add])
    const id = trashRequestId('ideas', 'cy-home0001')
    const v = claudeView({
      ...data,
      trashRequests: {
        [id]: {
          id,
          table: 'ideas',
          targetId: 'cy-home0001',
          parentId: 'home',
          targetUpdatedAt: 100,
          label: 'ホームのアイデア「…」',
          source: 'claude',
          v: 2,
          createdAt: AT,
          updatedAt: AT,
        },
      },
    })
    expect(Object.keys(v.ideas)).toEqual(['cy-home0002'])
    expect(v.ideaAppends).toEqual({})
  })

  it('まだアプリが足していない追記の依頼を当てた形で見せる（アプリが当てた後と1字も違わない）。依頼の表は当てた依頼だけ', () => {
    const requests = [
      request('cu-a', 'cy-home0001', '一つ目の追記'),
      request('cu-b', 'cy-home0001', '二つ目の追記', { createdAt: AT + 1000, updatedAt: AT + 1000 }),
      request('cu-read', 'cy-read0001', '読むだけのタイトル'),
      request('cu-none', 'cy-none0001', '見せないタイトル'),
      request('cu-author', 'author-write', '作者のアイデア'),
      request('cu-newer', 'cy-home0001', '新しい版', { v: 2 }),
      request('cu-gone', 'cy-gone0001', '無いアイデア'),
    ]
    const { data } = setup(
      (t) => [idea('cy-home0001', null), idea('cy-read0001', t.r), idea('cy-none0001', t.n), author('author-write', t.w)],
      requests,
    )
    const before = JSON.stringify(data)
    const v = claudeView(data)
    expect(JSON.stringify(data)).toBe(before)
    expect(Object.keys(v.ideaAppends).sort()).toEqual(['cu-a', 'cu-b'])
    expect(v.ideas['cy-home0001'].body).toBe(
      `${BODY}\n\n2026/11/13のセッションで以下の内容へ変更\n一つ目の追記\n\n2026/11/13のセッションで以下の内容へ変更\n二つ目の追記`,
    )
    expect(v.ideas['cy-read0001']).toBe(data.ideas['cy-read0001'])
    expect(v.ideas['author-write']).toBe(data.ideas['author-write'])
    // アプリが当てた後と、updatedAt のほかは同じ
    const app = applyIdeaAppends(data, Date.UTC(2026, 10, 20)).data
    expect({ ...app.ideas['cy-home0001'], updatedAt: 0 }).toEqual({ ...v.ideas['cy-home0001'], updatedAt: 0 })
    expect(v.ideas['cy-home0001'].updatedAt).toBe(100)
    // アプリが当てた後は、依頼が無くても同じ中身
    expect(claudeView(app).ideas['cy-home0001'].body).toBe(v.ideas['cy-home0001'].body)
    expect(claudeView(app).ideaAppends).toEqual({})
  })

  it('当てる依頼が無ければ、アイデアと依頼の表は同じオブジェクトのまま', () => {
    const { data } = setup(() => [idea('cy-home0001', null)])
    const v = claudeView(data)
    expect(v.ideas).toBe(data.ideas)
    expect(v.ideaAppends).toBe(data.ideaAppends)
    const withRefused = { ...data, ideaAppends: { 'cu-x': request('cu-x', 'cy-gone', 'x') } } as AppData
    const w = claudeView(withRefused)
    expect(w.ideas).toBe(data.ideas)
    expect(w.ideaAppends).toEqual({})
    const all = { ...data, ideaAppends: { 'cu-y': request('cu-y', 'cy-home0001', 'y') } } as AppData
    expect(claudeView(all).ideaAppends).toBe(all.ideaAppends)
  })
})
