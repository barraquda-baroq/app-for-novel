// 幕（2.2）の同期の規則（純粋関数）
import { describe, expect, it } from 'vitest'
import {
  actsVerdict,
  chooseTarget,
  familyText,
  groupOutbox,
  isDirtyEpisodeRow,
  isRedundant,
  resolveActsPieces,
  undoneActs,
  type GroupEntry,
  type Tri,
} from './acts'
import type { Rec } from './merge'

const ep = (actIds?: string[], extra: Record<string, unknown> = {}): Rec =>
  ({
    id: 'E',
    kind: 'episode',
    titleId: 't',
    subtitle: '',
    activeVersionId: 'EV',
    versionIds: ['EV'],
    versionSeq: 1,
    ...(actIds ? { actIds } : {}),
    ...extra,
  }) as Rec
const act = (id: string, extra: Record<string, unknown> = {}): Rec =>
  ({
    id,
    kind: 'act',
    parentId: 'E',
    titleId: 't',
    activeVersionId: `${id}v`,
    versionIds: [`${id}v`],
    versionSeq: 1,
    ...extra,
  }) as Rec
const row = (table: string, id: string, base: Rec | null, local: Rec | null, more: Partial<GroupEntry> = {}): GroupEntry => ({
  k: `${table}/${id}`,
  table,
  id,
  base,
  local,
  noHistory: false,
  force: false,
  ...more,
})

describe('どちらの幕の構成を採るか', () => {
  it('この端末だけがセパレートを解除した（解除して分け直した）時だけこの端末、それ以外はクラウド', () => {
    const B = ['a1', 'a2', 'a3']
    expect(actsVerdict(B, [], ['a1', 'a2', 'c1', 'a3'])).toBe('mine')
    expect(actsVerdict(B, ['n1', 'n2'], ['a1', 'a3'])).toBe('mine')
    expect(actsVerdict(B, ['a1', 'a3'], [])).toBe('theirs')
    // 両方が解除した（片方は分け直した）: クラウド
    expect(actsVerdict(B, [], [])).toBe('theirs')
    expect(actsVerdict(B, [], ['n1', 'n2'])).toBe('theirs')
    expect(actsVerdict(B, ['n1'], ['m1', 'm2'])).toBe('theirs')
    // 分けていなかった話を両方が分けた: クラウド（先に送った端末）
    expect(actsVerdict([], ['x1', 'x2'], ['y1', 'y2'])).toBe('theirs')
    expect(undoneActs([], [])).toBe(false)
    expect(undoneActs(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('幕のまとまり（送信待ち）', () => {
  it('幕の構成を変えた話があれば、その話・幕・稿・この操作のゴミ箱の件を1つのまとまりにする', () => {
    const entries: GroupEntry[] = [
      row('pieces', 'E', ep(['a1', 'a2', 'a3']), ep(['a1', 'a3'])),
      row('pieces', 'a1', act('a1'), act('a1', { versionIds: ['a1v', 'J'] })),
      row('pieces', 'a2', act('a2'), null),
      row('versions', 'J', null, { id: 'J', pieceId: 'a1' } as Rec),
      row('versions', 'a2v', { id: 'a2v', pieceId: 'a2' } as Rec, null),
      row('trashEntries', 'T', null, { id: 'T', kind: 'version', origin: { pieceId: 'a1', parentId: 'E' } } as Rec),
      row('trashRecords', 'R', null, { id: 'R', entryId: 'T' } as Rec),
      // 別の話・送った後のゴミ箱の件はまとまりに入れない
      row('pieces', 'other', ep(undefined, { id: 'other' }), ep(undefined, { id: 'other', subtitle: '題' })),
      row('trashEntries', 'old', { id: 'old' } as Rec, { id: 'old', origin: { parentId: 'E' } } as Rec),
      row('memos', 'm', null, { id: 'm' } as Rec),
    ]
    const g = groupOutbox(entries)
    expect([...g.keys()].sort()).toEqual(
      ['pieces/E', 'pieces/a1', 'pieces/a2', 'versions/J', 'versions/a2v', 'trashEntries/T', 'trashRecords/R'].sort(),
    )
    expect(new Set(g.values())).toEqual(new Set(['pieces/E']))
  })

  it('幕の構成を変えていなければまとまりは無い（幕の稿を書き換えただけ・題を変えただけ）', () => {
    expect(
      groupOutbox([
        row('pieces', 'E', ep(['a1']), ep(['a1'], { subtitle: '新しい題' })),
        row('versions', 'a1v', { id: 'a1v', pieceId: 'a1' } as Rec, { id: 'a1v', pieceId: 'a1', body: 'x' } as Rec),
      ]).size,
    ).toBe(0)
  })

  it('共通の履歴が無い時は、分けてある話をまとまりにする（クラウドの話と突き合わせるまで幕を先に送らない）', () => {
    expect(isDirtyEpisodeRow({ base: null, local: ep(['a1']), noHistory: true, force: false })).toBe(true)
    expect(isDirtyEpisodeRow({ base: null, local: ep(), noHistory: true, force: false })).toBe(false)
    expect(isDirtyEpisodeRow({ base: ep(), local: ep(['a1']), noHistory: false, force: true })).toBe(false)
    // 話を消した（幕に分けていた）: 消す話と幕をいっしょに送る
    expect(isDirtyEpisodeRow({ base: ep(['a1']), local: null, noHistory: false, force: false })).toBe(true)
  })
})

describe('両方で幕の構成が変わった話を合わせる', () => {
  const tri = (base: Rec | null, local: Rec | null, cloud: Rec | null): Tri => ({ base, local, cloud })

  it('クラウドを採る: 幕の並び・採用稿はクラウド、題はこの端末の変更、この端末で消した幕は戻り、作った幕は消える', () => {
    const base = ep(['a1', 'a2', 'a3'])
    const local = ep(['a1', 'a2'], { subtitle: 'この端末の題', versionSeq: 1 })
    const cloud = ep(['a1', 'a3'], { versionSeq: 1 })
    const r = resolveActsPieces({
      episodeId: 'E',
      episode: tri(base, local, cloud),
      acts: new Map([
        ['a1', tri(act('a1'), act('a1'), act('a1', { activeVersionId: 'J12' }))],
        ['a2', tri(act('a2'), act('a2', { activeVersionId: 'J23' }), null)],
        ['a3', tri(act('a3'), null, act('a3'))],
        ['y1', tri(null, act('y1'), null)],
      ]),
      verdict: 'theirs',
      noHistory: false,
      device: 'テスト',
    })
    const E = r.pieces.get('E') as Rec & { actIds: string[]; subtitle: string }
    expect(E.actIds).toEqual(['a1', 'a3'])
    expect(E.subtitle).toBe('この端末の題')
    expect((r.pieces.get('a1') as Rec & { activeVersionId: string }).activeVersionId).toBe('J12')
    expect(r.pieces.get('a2')).toBeNull()
    expect(r.pieces.get('y1')).toBeNull()
    expect([...r.resurrected]).toEqual(['a3'])
    expect([...r.removed].sort()).toEqual(['a2', 'y1'])
  })

  it('この端末を採る（セパレート解除）: 幕はすべて消え、話はこの端末の採用稿', () => {
    const base = ep(['a1', 'a2'])
    const local = ep([], { activeVersionId: 'JV', versionIds: ['EV', 'JV'], versionSeq: 2 })
    const cloud = ep(['a1', 'c1', 'a2'])
    const r = resolveActsPieces({
      episodeId: 'E',
      episode: tri(base, local, cloud),
      acts: new Map([
        ['a1', tri(act('a1'), null, act('a1'))],
        ['c1', tri(null, null, act('c1'))],
        ['a2', tri(act('a2'), null, act('a2', { activeVersionId: 'Ds' }))],
      ]),
      verdict: 'mine',
      noHistory: false,
      device: 'テスト',
    })
    const E = r.pieces.get('E') as Rec & { actIds: string[]; activeVersionId: string; versionSeq: number }
    expect(E.actIds).toEqual([])
    expect(E.activeVersionId).toBe('JV')
    expect(E.versionSeq).toBe(2)
    expect([...r.pieces.entries()].filter(([id, f]) => id !== 'E' && f !== null)).toEqual([])
    expect(r.removed.size).toBe(0)
  })

  it('この端末が解除して分け直した方を採ると、この端末の新しい幕が残る', () => {
    const r = resolveActsPieces({
      episodeId: 'E',
      episode: tri(ep(['a1']), ep(['n1']), ep(['a1', 'c1'])),
      acts: new Map([
        ['a1', tri(act('a1'), null, act('a1'))],
        ['n1', tri(null, act('n1'), null)],
        ['c1', tri(null, null, act('c1'))],
      ]),
      verdict: 'mine',
      noHistory: false,
      device: 'テスト',
    })
    expect(r.pieces.get('n1')).toEqual(act('n1'))
    expect(r.pieces.get('a1')).toBeNull()
    expect(r.pieces.get('c1')).toBeNull()
  })
})

describe('控える稿の残し先', () => {
  it('話を分けていなければ話、稿の幕が残ればその幕、なければ左隣・右隣、この端末で作った幕なら同じ位置', () => {
    const base = { episodeId: 'E', createdHere: false }
    expect(chooseTarget({ ...base, live: [], orders: [['a1', 'a2']], pieceId: 'a2' })).toEqual({ targetId: 'E', actNumber: 2 })
    expect(chooseTarget({ ...base, live: ['a1', 'a2'], orders: [['a1', 'a2']], pieceId: 'a2' })).toEqual({
      targetId: 'a2',
      actNumber: 2,
    })
    expect(chooseTarget({ ...base, live: ['a1', 'a3'], orders: [['a1', 'a2', 'a3']], pieceId: 'a2' })).toEqual({
      targetId: 'a1',
      actNumber: 2,
    })
    expect(chooseTarget({ ...base, live: ['a3'], orders: [['a1', 'a2', 'a3']], pieceId: 'a1' })).toEqual({
      targetId: 'a3',
      actNumber: 1,
    })
    // 並びに載っていた順の後ろの並びも探す
    expect(chooseTarget({ ...base, live: ['a1'], orders: [['x'], ['a1', 'a2']], pieceId: 'a2' })).toEqual({
      targetId: 'a1',
      actNumber: 2,
    })
    expect(
      chooseTarget({ episodeId: 'E', createdHere: true, live: ['x1', 'x2'], orders: [['y1', 'y2', 'y3']], pieceId: 'y3' }),
    ).toEqual({ targetId: 'x2', actNumber: 3 })
    expect(chooseTarget({ ...base, live: ['x1', 'x2'], orders: [], pieceId: 'z' })).toEqual({ targetId: 'x1', actNumber: null })
  })

  it('採用原稿にそのまま入っていて推敲メモも無い稿は、控えるまでもない（ゴミ箱にだけ残す）', () => {
    expect(isRedundant({ id: 'v', body: 'DEF', note: '' }, 'ABCDEFGHI')).toBe(true)
    expect(isRedundant({ id: 'v', body: '', note: ' ' }, 'ABC')).toBe(true)
    expect(isRedundant({ id: 'v', body: 'DXF', note: '' }, 'ABCDEFGHI')).toBe(false)
    expect(isRedundant({ id: 'v', body: 'DEF', note: 'メモ' }, 'ABCDEFGHI')).toBe(false)
  })

  it('話の採用原稿（分けていれば、載っている幕の採用稿をつないだもの）', () => {
    const pieces = new Map([
      ['a1', { id: 'a1', parentId: 'E', activeVersionId: 'v1' }],
      ['a2', { id: 'a2', parentId: 'E', activeVersionId: 'v2' }],
      ['b', { id: 'b', parentId: 'other', activeVersionId: 'vb' }],
    ])
    const versions = new Map([
      ['v1', { id: 'v1', pieceId: 'a1', body: 'ABC' }],
      ['v2', { id: 'v2', pieceId: 'a2', body: 'DEF' }],
      ['vb', { id: 'vb', pieceId: 'b', body: 'XXX' }],
      ['EV', { id: 'EV', pieceId: 'E', body: '話の本文' }],
    ])
    const get = { p: (id: string) => pieces.get(id), v: (id: string) => versions.get(id) }
    expect(familyText({ id: 'E', actIds: ['a1', 'a2', 'b', 'gone'], activeVersionId: 'EV' }, get.p, get.v)).toBe('ABCDEF')
    expect(familyText({ id: 'E', actIds: [], activeVersionId: 'EV' }, get.p, get.v)).toBe('話の本文')
    expect(familyText(null, get.p, get.v)).toBe('')
  })
})
