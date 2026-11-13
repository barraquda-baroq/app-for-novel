// ゴミ箱へ移す依頼（2.7）の作り方（コネクタの novel_move_cards_to_trash が使う buildTrashRequests）と、依頼の出ているカード。
// 2.8 の Claude が作ったアイデア（i:…）も。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../domain/benchOps'
import { createTitle, moveIdeaStep, moveIdeaToSection, setIdeaChecked } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import { addMaterial } from '../domain/materialOps'
import { emptyData, type AppData, type BenchAnalysis, type Idea, type MaterialNote, type TrashRequest } from '../domain/types'
import { trashRequestId } from './derivedId'
import { withIdeaAppend } from './ideaAppend'
import { shortId } from './refs'
import {
  buildTrashRequests,
  FOLDER_NOT_CARD_HINT,
  trashCardLabel,
  trashEntryIdsOf,
  trashTargetProblem,
  TRASH_STATUS_HINTS,
  type TrashContext,
} from './trashRequest'
import { isTrashRequest, liveTrashRequests, pendingTrashCount, pendingTrashTargets } from './trashTargets'
import { claudeView } from './visibility'

const NOW = Date.UTC(2026, 10, 9, 3, 0, 0)

function analysis(workId: string, id: string, over: Partial<BenchAnalysis> = {}): BenchAnalysis {
  return {
    id,
    workId,
    viewpoint: '構成',
    body: '三幕。',
    runDate: '2026-10-30',
    source: 'claude',
    v: 1,
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

function note(materialId: string, id: string, over: Partial<MaterialNote> = {}): MaterialNote {
  return {
    id,
    materialId,
    section: '要約',
    body: '第1章。',
    runDate: '2026-10-31',
    source: 'claude',
    v: 1,
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

/** 作品1つ（Claude の分析・作者の分析・直した分析）と資料1つ（Claude の記録） */
function shelf() {
  const w = addBenchWork(emptyData(), { name: '銀河の果て', author: '山田' })
  const m = addMaterial(w.data, { name: '外科の歴史', author: '高橋' })
  const data: AppData = {
    ...m.data,
    benchAnalyses: {
      'cn-claude00001': analysis(w.result, 'cn-claude00001'),
      'manual-000001': analysis(w.result, 'manual-000001', { source: 'manual', viewpoint: '人物' }),
      'cp-pasted00001': analysis(w.result, 'cp-pasted00001', { source: 'paste', viewpoint: '文体' }),
      'cn-edited00001': analysis(w.result, 'cn-edited00001', { updatedAt: 200, viewpoint: '冒頭' }),
    },
    materialNotes: { 'ck-claude00001': note(m.result, 'ck-claude00001') },
  }
  return { data, workId: w.result, materialId: m.result }
}

const ctx = (over: Partial<TrashContext> = {}): TrashContext => ({
  now: NOW,
  trash: {},
  wasDeleted: () => false,
  dailyLeft: 100,
  ...over,
})

describe('buildTrashRequests', () => {
  it('n:・k: の短い id と、接頭の無い id そのもので見つかり、依頼の形（作品・資料の id・依頼の時の updatedAt・表記）で作る', () => {
    const s = shelf()
    const r = buildTrashRequests(s.data, { cards: [shortId('benchAnalysis', 'cn-claude00001'), 'ck-claude00001'] }, ctx())
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => i.status)).toEqual(['requested', 'requested'])
    expect(r.records.map((x) => x.record)).toEqual([
      {
        id: trashRequestId('benchAnalyses', 'cn-claude00001'),
        table: 'benchAnalyses',
        targetId: 'cn-claude00001',
        parentId: s.workId,
        targetUpdatedAt: 100,
        label: '『銀河の果て』の「構成」（2026-10-30）',
        source: 'claude',
        v: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      expect.objectContaining({
        id: trashRequestId('materialNotes', 'ck-claude00001'),
        table: 'materialNotes',
        parentId: s.materialId,
        label: '『外科の歴史』の「要約」（2026-10-31）',
      }),
    ])
    expect(r.records.every((x) => isTrashRequest(x.record))).toBe(true)
    expect(r.records[0].record.id).toMatch(/^cz-/)
  })

  it('作者が書いた・貼り付けた・直したカード、作品・資料そのもの、ほかの種類、見つからない・形の違う id は断る', () => {
    const s = shelf()
    const r = buildTrashRequests(
      s.data,
      {
        cards: [
          'manual-000001',
          shortId('benchAnalysis', 'cp-pasted00001'),
          shortId('benchAnalysis', 'cn-edited00001'),
          shortId('benchWork', s.workId),
          shortId('material', s.materialId),
          'x:12345678',
          'a:12345678',
          'n:zzzzzzzz',
          '',
          'あ'.repeat(81),
        ],
      },
      ctx(),
    )
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.items.map((i) => i.status)).toEqual([
      'not_claude',
      'not_claude',
      'edited',
      'shelf_item',
      'shelf_item',
      'not_card',
      'not_card',
      'not_found',
      'invalid',
      'invalid',
    ])
    expect(r.items[0].hint).toContain('作者がアプリで削除してください')
  })

  it('2.9: アイデアのフォルダ（f:…）は「ほかの種類」のまま、フォルダ用の説明を返す（依頼は作らない）', () => {
    const s = shelf()
    const r = buildTrashRequests(s.data, { cards: ['f:1a2b3c4d', 'F:5e6f7a8b', 'x:12345678'] }, ctx())
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.items.map((i) => [i.ref, i.status, i.hint])).toEqual([
      ['f:1a2b3c4d', 'not_card', FOLDER_NOT_CARD_HINT],
      ['F:5e6f7a8b', 'not_card', FOLDER_NOT_CARD_HINT],
      ['x:12345678', 'not_card', TRASH_STATUS_HINTS.not_card],
    ])
    expect(FOLDER_NOT_CARD_HINT).toBe(
      'フォルダはゴミ箱へ移せません（フォルダの削除・整理はアプリで作者がします。中のカードは i:… で指せます）',
    )
  })

  it('ゴミ箱にあるカード・同じ呼び出しの中の重なり・依頼中のカード（書かない）', () => {
    const s = shelf()
    const trash = {
      tr1: {
        id: 'tr1',
        entryId: 'te1',
        table: 'benchAnalyses' as const,
        record: { id: 'cn-intrash0001' },
        createdAt: 1,
        updatedAt: 1,
      },
    } as unknown as AppData['trashRecords']
    const first = buildTrashRequests(s.data, { cards: ['cn-claude00001'] }, ctx())
    const req = first.records[0].record
    const data: AppData = { ...s.data, trashRequests: { [req.id]: req } }
    const r = buildTrashRequests(
      data,
      { cards: [shortId('benchAnalysis', 'cn-intrash0001'), 'cn-claude00001', 'ck-claude00001', 'ck-claude00001'] },
      ctx({ trash }),
    )
    expect(r.items.map((i) => i.status)).toEqual(['in_trash', 'pending', 'requested', 'repeated'])
    expect(r.records).toHaveLength(1)
    // Claude に見せる内容（依頼中のカードは外れている）でも、依頼中と分かる
    const v = buildTrashRequests(claudeView(data), { cards: [shortId('benchAnalysis', 'cn-claude00001')] }, ctx())
    expect(v.items[0]).toMatchObject({ status: 'pending', label: '『銀河の果て』の「構成」（2026-10-30）' })
  })

  it('削除の印のある依頼の id（前の依頼をアプリが処理した）は、次の番号にする', () => {
    const s = shelf()
    const gone = new Set(['trashRequests:' + trashRequestId('benchAnalyses', 'cn-claude00001')])
    const r = buildTrashRequests(s.data, { cards: ['cn-claude00001'] }, ctx({ wasDeleted: (t, id) => gone.has(`${t}:${id}`) }))
    expect(r.records[0].record.id).toBe(trashRequestId('benchAnalyses', 'cn-claude00001', 2))
  })

  it('21件・今日の残りを超える数は、呼び出し全体を断る（一部だけ頼まない）', () => {
    const s = shelf()
    const many = buildTrashRequests(s.data, { cards: Array.from({ length: 21 }, () => 'cn-claude00001') }, ctx())
    expect(many.ok).toBe(false)
    expect(many.error).toContain('20件まで')
    const over = buildTrashRequests(s.data, { cards: ['cn-claude00001', 'ck-claude00001'] }, ctx({ dailyLeft: 1 }))
    expect(over.ok).toBe(false)
    expect(over.error).toContain('あと1件')
    expect(over.records).toEqual([])
    // 依頼中・断るだけなら、残りが 0 でも通る
    const none = buildTrashRequests(s.data, { cards: ['manual-000001'] }, ctx({ dailyLeft: 0 }))
    expect(none.ok).toBe(true)
    expect(buildTrashRequests(s.data, {}, ctx()).ok).toBe(false)
  })
})

describe('依頼の形と依頼中のカード', () => {
  const req = (over: Partial<TrashRequest> = {}): TrashRequest => ({
    id: 'cz-1',
    table: 'benchAnalyses',
    targetId: 'cn-claude00001',
    parentId: 'w1',
    targetUpdatedAt: 100,
    label: '「構成」',
    source: 'claude',
    v: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  it('pendingTrashTargets・liveTrashRequests は、形の違う依頼と新しい版の依頼を数えない', () => {
    const data = {
      trashRequests: {
        'cz-1': req(),
        'cz-2': req({ id: 'cz-2', table: 'materialNotes', targetId: 'k1', parentId: 'd1' }),
        'cz-3': req({ id: 'cz-3', targetId: 'x3', v: 3 }),
        'cz-4': { ...req({ id: 'cz-4', targetId: 'x4' }), table: 'titles' } as unknown as TrashRequest,
        'cz-5': { ...req({ id: 'cz-5', targetId: 'x5' }), source: 'paste' } as unknown as TrashRequest,
      },
    }
    expect([...pendingTrashTargets(data)].sort()).toEqual(['benchAnalyses:cn-claude00001', 'materialNotes:k1'])
    expect(liveTrashRequests(data).map((r) => r.id)).toEqual(['cz-1', 'cz-2'])
    expect(pendingTrashCount(data, 'benchAnalyses', 'w1')).toBe(1)
    expect(pendingTrashCount(data, 'materialNotes', 'w1')).toBe(0)
  })

  it('trashTargetProblem: Claude でない・直した・依頼の後に直した（作品が変わった）', () => {
    const a = analysis('w1', 'cn-claude00001')
    expect(trashTargetProblem('benchAnalyses', a)).toBeNull()
    expect(trashTargetProblem('benchAnalyses', { ...a, source: 'paste' })).toBe('not_claude')
    expect(trashTargetProblem('benchAnalyses', { ...a, updatedAt: 101 })).toBe('edited')
    expect(trashTargetProblem('benchAnalyses', a, req())).toBeNull()
    expect(trashTargetProblem('benchAnalyses', a, req({ targetUpdatedAt: 99 }))).toBe('changed')
    expect(trashTargetProblem('benchAnalyses', a, req({ parentId: 'w2' }))).toBe('changed')
  })

  it('表記とゴミ箱の id（依頼から決める）', () => {
    const s = shelf()
    expect(trashCardLabel(s.data, 'benchAnalyses', s.data.benchAnalyses['cn-claude00001'])).toBe(
      '『銀河の果て』の「構成」（2026-10-30）',
    )
    expect(trashCardLabel(emptyData(), 'materialNotes', note('gone', 'k1', { section: ' ', runDate: '' }))).toBe('「項目なし」')
    expect(trashEntryIdsOf('cz-1')).toMatchObject({ entry: 'te-cz-1' })
    expect(trashEntryIdsOf('cz-1').record(0)).toBe('tr-cz-1')
  })
})

// ---------- Claude が作ったアイデア（2.8） ----------

const IDEA_BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'

function claudeIdea(id: string, titleId: string | null, over: Partial<Idea> = {}): Idea {
  const body = over.body ?? IDEA_BODY
  return {
    id,
    titleId,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order: 0,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

/** 「読む＋書き込む」のタイトル『灰の庭』・「読むだけ」のタイトル『読む庭』と、ホーム・タイトルのアイデア、相対比較の棚 */
function ideaShelf() {
  const s = shelf()
  const w = createTitle(s.data, '灰の庭')
  const r = createTitle(w.data, '読む庭')
  const titles = { ...r.data.titles, [r.result]: { ...r.data.titles[r.result], claudeAccess: 'read' as const } }
  const ideas: Record<string, Idea> = {
    'cy-home0001': claudeIdea('cy-home0001', null),
    'cy-title001': claudeIdea('cy-title001', w.result, {
      body: '2026/11/12 15:00\n灰の庭の案',
      claudeHash: hashJson('2026/11/12 15:00\n灰の庭の案'),
    }),
    'cy-readonly': claudeIdea('cy-readonly', r.result),
    'cy-edited01': claudeIdea('cy-edited01', null, { body: `${IDEA_BODY}\n作者が足した行`, claudeHash: hashJson(IDEA_BODY) }),
    'cy-heading1': claudeIdea('cy-heading1', null, { heading: '古い見出し' }),
    // source が claude でも id が UUID のもの・id が cy- でも source の無いものは Claude のアイデアでない
    'a1b2c3d4-0000-4000-8000-000000000001': claudeIdea('a1b2c3d4-0000-4000-8000-000000000001', w.result),
    'cy-nosource': { ...claudeIdea('cy-nosource', w.result), source: undefined },
    'e5f6a7b8-0000-4000-8000-000000000002': {
      id: 'e5f6a7b8-0000-4000-8000-000000000002',
      titleId: w.result,
      heading: '',
      body: '作者のアイデア',
      order: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  }
  return { ...s, data: { ...r.data, titles, ideas } as AppData, titleId: w.result, readId: r.result }
}

describe('buildTrashRequests: Claude が作ったアイデア（i:…）', () => {
  it('i: の短い id と id そのもので見つかり、場所と1行目の表記・形の版 2・仕切り（ホームは home）で依頼を作る', () => {
    const s = ideaShelf()
    const r = buildTrashRequests(s.data, { cards: [shortId('idea', 'cy-home0001'), 'cy-title001'] }, ctx())
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => [i.status, i.label])).toEqual([
      ['requested', 'ホームのアイデア「2026/11/12 14:32　第3章の動機」'],
      ['requested', 'タイトル『灰の庭』のアイデア「2026/11/12 15:00　灰の庭の案」'],
    ])
    expect(r.records.map((x) => x.record)).toEqual([
      {
        id: trashRequestId('ideas', 'cy-home0001'),
        table: 'ideas',
        targetId: 'cy-home0001',
        parentId: 'home',
        targetUpdatedAt: 100,
        label: 'ホームのアイデア「2026/11/12 14:32　第3章の動機」',
        source: 'claude',
        v: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      expect.objectContaining({ table: 'ideas', targetId: 'cy-title001', parentId: s.titleId, v: 2 }),
    ])
    expect(r.records.every((x) => isTrashRequest(x.record))).toBe(true)
    expect(shortId('idea', 'cy-home0001')).toBe('i:home0001')
  })

  it('分析・記録の依頼は 2.7 と1字も違わない（形の版 1）', () => {
    const s = ideaShelf()
    const r = buildTrashRequests(s.data, { cards: ['n:claude00', 'k:claude00'] }, ctx())
    expect(r.records.map((x) => JSON.stringify(x.record))).toEqual([
      `{"id":"${trashRequestId('benchAnalyses', 'cn-claude00001')}","table":"benchAnalyses","targetId":"cn-claude00001","parentId":"${s.workId}","targetUpdatedAt":100,"label":"『銀河の果て』の「構成」（2026-10-30）","source":"claude","v":1,"createdAt":${NOW},"updatedAt":${NOW}}`,
      `{"id":"${trashRequestId('materialNotes', 'ck-claude00001')}","table":"materialNotes","targetId":"ck-claude00001","parentId":"${s.materialId}","targetUpdatedAt":100,"label":"『外科の歴史』の「要約」（2026-10-31）","source":"claude","v":1,"createdAt":${NOW},"updatedAt":${NOW}}`,
    ])
  })

  it('作者が書いたアイデア・Claude のアイデアでない形・作者が直したもの・「読むだけ」のタイトルのものは断る', () => {
    const s = ideaShelf()
    const r = buildTrashRequests(
      s.data,
      {
        cards: [
          'e5f6a7b8-0000-4000-8000-000000000002',
          shortId('idea', 'a1b2c3d4-0000-4000-8000-000000000001'),
          'cy-nosource',
          'i:edited01',
          'i:heading1',
          'i:readonly',
          'i:zzzzzzzz',
        ],
      },
      ctx(),
    )
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.items.map((i) => i.status)).toEqual([
      'not_claude',
      'not_claude',
      'not_claude',
      'edited',
      'edited',
      'not_writable',
      'not_found',
    ])
    expect(r.items[5]).toMatchObject({
      label: 'タイトル『読む庭』のアイデア「2026/11/12 14:32　第3章の動機」',
      hint: '「Claude に見せる」が「読む＋書き込む」でないタイトルのアイデアです（移せません。作者がアプリで削除するか、タイトルを「読む＋書き込む」にしてください）',
    })
    expect(r.items[6].hint).toBe('見つかりません（novel_get_notes の kind=ideas で id を確かめてください）')
    // n:・k: の見つからない時の文は 2.7 のまま。ほかの種類の文はアイデアも挙げる
    const other = buildTrashRequests(s.data, { cards: ['n:zzzzzzzz', 'x:12345678'] }, ctx())
    expect(other.items.map((i) => i.hint)).toEqual([
      '見つかりません（novel_get_bench_analysis・novel_get_material で id を確かめてください）',
      '移せるのは相対比較の分析（n:…）・資料の記録（k:…）・Claude が作ったアイデア（i:…）だけです',
    ])
  })

  it('Claude の追記・済み・並べ替え・仕切りの移動は直したに数えない（移せる）。Claude が書いた形に戻すと移せる', () => {
    const s = ideaShelf()
    let data: AppData = {
      ...s.data,
      ideas: {
        ...s.data.ideas,
        'cy-home0001': withIdeaAppend(s.data.ideas['cy-home0001'], { id: 'cu-1', createdAt: NOW, text: '追記の内容' }),
      },
    }
    data = setIdeaChecked(data, 'cy-title001', true)
    data = moveIdeaStep(data, 'cy-home0001', 1)
    data = moveIdeaToSection(data, 'cy-home0001', s.titleId)
    const r = buildTrashRequests(data, { cards: ['i:home0001', 'i:title001'] }, ctx())
    expect(r.items.map((i) => i.status)).toEqual(['requested', 'requested'])
    expect(r.records[0].record).toMatchObject({
      parentId: s.titleId,
      label: 'タイトル『灰の庭』のアイデア「2026/11/12 14:32　第3章の動機」',
    })
    // 作者が直したものを、Claude が書いた形に1字も違わず戻した
    const back: AppData = {
      ...s.data,
      ideas: { ...s.data.ideas, 'cy-edited01': { ...s.data.ideas['cy-edited01'], body: IDEA_BODY } },
    }
    expect(buildTrashRequests(back, { cards: ['i:edited01'] }, ctx()).items[0].status).toBe('requested')
  })

  it('ゴミ箱にある Claude のアイデアは「もうゴミ箱にある」（写しの中身は id だけでもよい）。作者が書いたアイデアは答えない', () => {
    const s = ideaShelf()
    const trash = {
      tr1: { id: 'tr1', entryId: 'te1', table: 'ideas', record: { id: 'cy-intrash01' }, createdAt: 1, updatedAt: 1 },
      tr2: { id: 'tr2', entryId: 'te2', table: 'ideas', record: claudeIdea('cy-intrash02', null), createdAt: 1, updatedAt: 1 },
      tr3: {
        id: 'tr3',
        entryId: 'te3',
        table: 'ideas',
        record: { id: 'b0b0b0b0-0000-4000-8000-000000000003', body: '作者' },
        createdAt: 1,
        updatedAt: 1,
      },
      tr4: {
        id: 'tr4',
        entryId: 'te4',
        table: 'ideas',
        record: { id: 'cy-forged01', source: 'manual' },
        createdAt: 1,
        updatedAt: 1,
      },
    } as unknown as AppData['trashRecords']
    const r = buildTrashRequests(
      s.data,
      { cards: ['i:intrash01', 'cy-intrash02', 'i:b0b0b0b0', 'b0b0b0b0-0000-4000-8000-000000000003', 'i:forged01'] },
      ctx({ trash }),
    )
    expect(r.items.map((i) => i.status)).toEqual(['in_trash', 'in_trash', 'not_found', 'not_found', 'not_found'])
  })

  it('依頼中のアイデアは Claude に見せる内容から外れ、もう一度頼むと「依頼中」（書かない）', () => {
    const s = ideaShelf()
    const first = buildTrashRequests(s.data, { cards: ['i:home0001'] }, ctx())
    const req = first.records[0].record
    const data: AppData = { ...s.data, trashRequests: { [req.id]: req } }
    const v = claudeView(data)
    expect(v.ideas['cy-home0001']).toBeUndefined()
    expect(v.ideas['cy-title001']).toBeDefined()
    expect(pendingTrashTargets(data).has('ideas:cy-home0001')).toBe(true)
    const again = buildTrashRequests(v, { cards: ['i:home0001'] }, ctx())
    expect(again.items[0]).toMatchObject({ status: 'pending', label: 'ホームのアイデア「2026/11/12 14:32　第3章の動機」' })
    expect(again.records).toEqual([])
  })
})

describe('trashTargetProblem: アイデア', () => {
  const titles = {
    t1: { claudeAccess: 'write' },
    t2: { claudeAccess: 'read' },
    t3: { claudeAccess: 'none' },
  } as unknown as AppData['titles']
  const req = (parentId: string) => ({ targetUpdatedAt: 1, parentId })

  it('作者が書いた・直した・書き込めない場所・依頼の後に別の仕切りへ移した。依頼の時の updatedAt は比べない', () => {
    const i = claudeIdea('cy-x0000001', 't1', { updatedAt: 999 })
    expect(trashTargetProblem('ideas', i, req('t1'), { titles })).toBeNull()
    expect(trashTargetProblem('ideas', { ...i, source: undefined }, undefined, { titles })).toBe('not_claude')
    expect(trashTargetProblem('ideas', { ...i, body: `${i.body}。` }, undefined, { titles })).toBe('edited')
    expect(trashTargetProblem('ideas', { ...i, claudeHash: undefined }, undefined, { titles })).toBe('edited')
    expect(trashTargetProblem('ideas', { ...i, titleId: 't2' }, undefined, { titles })).toBe('not_writable')
    expect(trashTargetProblem('ideas', { ...i, titleId: 't3' }, undefined, { titles })).toBe('not_writable')
    // タイトルの無いアイデアはホーム（書き込める）
    expect(trashTargetProblem('ideas', { ...i, titleId: 'gone' }, undefined, { titles })).toBeNull()
    expect(trashTargetProblem('ideas', i, req('home'), { titles })).toBe('changed')
    expect(trashTargetProblem('ideas', { ...i, titleId: null }, req('home'), { titles })).toBeNull()
    expect(trashTargetProblem('ideas', { ...i, titleId: null }, req('t1'), { titles })).toBe('changed')
  })
})
