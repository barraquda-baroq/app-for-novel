// Claude の依頼（2.8）を1回の処理で当てる: アイデアへの追記を先に、ゴミ箱へ移す依頼を後に。
import { describe, expect, it } from 'vitest'
import { ideaAppendId, trashRequestId } from '../claude/derivedId'
import { appendedBody, ideaEditedByAuthor, ideaReadMark } from '../claude/ideaAppend'
import { applyClaudeRequests, claudeRequestNotice } from './claudeRequests'
import { createTitle, moveIdeaStep, moveIdeaToSection, setIdeaChecked, updateIdea } from './entityOps'
import { hashJson } from './hash'
import { emptyData, type AppData, type Idea, type IdeaAppend, type TrashRequest } from './types'

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0)
/** 追記の依頼を作った時刻（2026/11/13 10:00 日本時間）と、ゴミ箱へ移す依頼を作った時刻（その1分後） */
const AT = Date.UTC(2026, 10, 13, 1, 0, 0)
const BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'

function claudeIdea(id: string, titleId: string | null, order: number): Idea {
  return {
    id,
    titleId,
    heading: '',
    body: BODY,
    checked: false,
    checkedAt: null,
    order,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(BODY),
    createdAt: 100,
    updatedAt: 100,
  }
}

function appendReq(ideaId: string, text: string, at = AT): IdeaAppend {
  return {
    id: ideaAppendId(ideaId, ideaReadMark(BODY), text),
    ideaId,
    text,
    readMark: ideaReadMark(BODY),
    source: 'claude',
    v: 1,
    createdAt: at,
    updatedAt: at,
  }
}

function trashReq(ideaId: string, parentId: string, at = AT + 60_000): TrashRequest {
  return {
    id: trashRequestId('ideas', ideaId),
    table: 'ideas',
    targetId: ideaId,
    parentId,
    targetUpdatedAt: 100,
    label: 'ホームのアイデア「2026/11/12 14:32　第3章の動機」',
    source: 'claude',
    v: 2,
    createdAt: at,
    updatedAt: at,
  }
}

/** ホームの Claude のアイデア2つと、「読む＋書き込む」のタイトル */
function setup(appends: IdeaAppend[], trash: TrashRequest[]) {
  const t = createTitle(emptyData(), '灰の庭')
  const data: AppData = {
    ...t.data,
    ideas: { 'cy-home0001': claudeIdea('cy-home0001', null, 0), 'cy-home0002': claudeIdea('cy-home0002', null, 1) },
    ideaAppends: Object.fromEntries(appends.map((r) => [r.id, r])),
    trashRequests: Object.fromEntries(trash.map((r) => [r.id, r])),
  }
  return { data, titleId: t.result }
}

describe('applyClaudeRequests', () => {
  it('作る → 追記 → ゴミ箱へ移す と頼まれたアイデアは、1回の処理で追記した後の形でゴミ箱へ入る', () => {
    const add = appendReq('cy-home0001', '動機を「兄の約束」に変える')
    const s = setup([add], [trashReq('cy-home0001', 'home')])
    const r = applyClaudeRequests(s.data, NOW)
    expect(r.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(r.result.trash.map((o) => o.status)).toEqual(['moved'])
    expect(r.data.ideas['cy-home0001']).toBeUndefined()
    expect(r.data.ideaAppends).toEqual({})
    expect(r.data.trashRequests).toEqual({})
    const rec = Object.values(r.data.trashRecords)[0].record as Idea
    expect(rec.body).toBe(appendedBody(BODY, add))
    expect(rec.appendIds).toEqual([add.id])
    expect(ideaEditedByAuthor(rec)).toBe(false)
    expect(claudeRequestNotice(r.result)).toBe(
      'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました。Claude の依頼で、アイデア1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）',
    )
  })

  it('作者が直したアイデアは、追記は足し、ゴミ箱へは移さない', () => {
    const s = setup([appendReq('cy-home0001', '追記')], [trashReq('cy-home0001', 'home')])
    const edited = updateIdea(s.data, 'cy-home0001', { body: `${BODY}\n作者の行` })
    const r = applyClaudeRequests(edited, NOW)
    expect(r.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(r.result.trash.map((o) => o.status)).toEqual(['edited'])
    expect(r.data.ideas['cy-home0001'].body).toBe(`${BODY}\n作者の行\n\n2026/11/13のセッションで以下の内容へ変更\n追記`)
    expect(claudeRequestNotice(r.result)).toBe(
      'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました。Claude の依頼のうち1件は移しませんでした（作者が直したカード1件）',
    )
  })

  it('並べ替え・済み・仕切りの移動は直したに数えない（依頼の前にタイトルへ移したアイデアも、追記してから移せる）', () => {
    const s = setup([appendReq('cy-home0002', '追記')], [])
    let data = moveIdeaStep(s.data, 'cy-home0002', -1)
    data = setIdeaChecked(data, 'cy-home0002', true)
    data = moveIdeaToSection(data, 'cy-home0002', s.titleId)
    // 移した後に、Claude がタイトル『灰の庭』のアイデアとして依頼した
    const req = trashReq('cy-home0002', s.titleId)
    data = { ...data, trashRequests: { [req.id]: req } }
    const r = applyClaudeRequests(data, NOW)
    expect(r.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(r.result.trash.map((o) => o.status)).toEqual(['moved'])
    expect(r.data.ideas['cy-home0002']).toBeUndefined()
  })

  it('もうゴミ箱にあるアイデアへの追記は、黙って消す', () => {
    const s = setup([], [trashReq('cy-home0001', 'home')])
    const trashed = applyClaudeRequests(s.data, NOW).data
    const late = appendReq('cy-home0001', '遅れて届いた追記', AT + 120_000)
    const r = applyClaudeRequests({ ...trashed, ideaAppends: { [late.id]: late } }, NOW + 1000)
    expect(r.result.appends.map((o) => o.status)).toEqual(['in_trash'])
    expect(r.result.trash).toEqual([])
    expect(r.data.ideaAppends).toEqual({})
    expect(claudeRequestNotice(r.result)).toBe('')
  })

  it('依頼が無ければ元の data をそのまま返す', () => {
    const s = setup([], [])
    const r = applyClaudeRequests(s.data, NOW)
    expect(r.data).toBe(s.data)
    expect(r.result).toEqual({ appends: [], trash: [] })
    expect(claudeRequestNotice(r.result)).toBe('')
  })
})
