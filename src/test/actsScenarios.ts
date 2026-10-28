// 幕（2.2）の同期の場面: 2台の端末が同じ話の幕を同時に（オフラインの間に）変えた時に、揃った後の内容が守るべきこと。
// 速いテスト（src/sync/actsSync.test.ts。仮のクラウド）とエミュレーターのテスト（src/sync/sync.emu.test.ts）で同じ場面を使う。
// 守ること:
// - I1 どちらの端末にあった稿の本文・推敲メモも、揃った後に稿かゴミ箱（戻せる）に残る
// - I2 揃った後の両方の端末の内容が同じ（テスト側で確かめる）
// - I3 幕の形が正しい（幕は属する話の幕の並びにちょうど1回載る・どの話にも載っていない幕が無い・分けた話に幕が無いことはない・
//      採用原稿に同じ区切りが2回入らない）
// - I4 どちらかの端末の操作・編集が採用原稿に入らなかった時は、合わせた端末がその話の名前で知らせる
import * as A from '../domain/acts'
import * as E from '../domain/entityOps'
import { repairData } from '../domain/repair'
import * as S from '../domain/storyOps'
import { activeBody, actsOf, isSplit } from '../domain/structure'
import { restoreTrashEntry } from '../domain/trash'
import { emptyData, type AppData, type ID } from '../domain/types'

export type Order = 'x-first' | 'y-first'
export type Op = (d: AppData, ep: ID) => AppData
/** 知らせの種類（src/db/persistence.ts の ActsNoteDetail） */
export type Detail = 'lost' | 'won' | 'deletedHere' | 'deletedThere' | 'mineDropped' | 'theirsDropped' | 'stale' | 'source'

export interface ActsScenario {
  name: string
  /** エミュレーターのテストでも試す（代表の場面） */
  emu?: boolean
  body: string
  /** 最初に分けておく位置（null = 分けない） */
  splitAt: number[] | null
  /** 分けた後、同期する前に整えること（幕に別の稿を足すなど） */
  prepare?: Op
  x: Op
  y: Op
  /** 揃った後の話の採用原稿（null = 話が無い） */
  text: string | null
  /** 揃った後の幕の数（0 = 分けていない） */
  acts: number | ((order: Order) => number)
  /** 知らせ（その端末に出るはずの detail。[] = 幕の知らせを出さない。書かない端末は確かめない） */
  notes: (order: Order) => { x?: Detail[]; y?: Detail[] }
  /** ほかに確かめること（問題があればその説明） */
  check?: (d: AppData, ep: ID, order: Order) => string | null
}

const view = (d: AppData) => repairData(d).data
/** 話の幕（読む順） */
export const actsIds = (d: AppData, ep: ID): ID[] => view(d).pieces[ep]?.actIds ?? []
const adopted = (d: AppData, pieceId: ID): ID => {
  const id = d.pieces[pieceId]?.activeVersionId
  if (!id) throw new Error('採用稿がありません')
  return id
}
const join =
  (n: number): Op =>
  (d, ep) =>
    A.joinActWithNext(d, actsIds(d, ep)[n]).data
const furtherSplit =
  (n: number, at: number[]): Op =>
  (d, ep) =>
    A.separatePiece(d, actsIds(d, ep)[n], at).data
const split =
  (at: number[]): Op =>
  (d, ep) =>
    A.separatePiece(d, ep, at).data
const unseparate: Op = (d, ep) => A.unseparatePiece(d, ep).data
const editAct =
  (n: number, body: string, note?: string): Op =>
  (d, ep) =>
    S.updateVersion(d, adopted(d, actsIds(d, ep)[n]), { body, ...(note !== undefined ? { note } : {}) })

/** 生きている稿で、本文が body のもの（あれば属する話・幕の id） */
function liveVersionPiece(d: AppData, body: string): ID | null {
  return Object.values(d.versions).find((v) => v.body === body)?.pieceId ?? null
}

const onAct = (body: string, n: number) => (d: AppData, ep: ID) => {
  const piece = liveVersionPiece(d, body)
  const want = actsIds(d, ep)[n]
  return piece === want ? null : `「${body}」が第${n + 1}幕の稿にない（${piece ? '別の場所' : '見つからない'}）`
}
const onEpisode = (body: string) => (d: AppData, ep: ID) =>
  liveVersionPiece(d, body) === ep ? null : `「${body}」が話の稿にない`

const lostOnSecond = (order: Order) => (order === 'x-first' ? { y: ['lost' as Detail] } : { x: ['lost' as Detail] })
const dropped = (order: Order) => (order === 'x-first' ? { y: ['mineDropped' as Detail] } : { x: ['theirsDropped' as Detail] })
const quiet = () => ({ x: [] as Detail[], y: [] as Detail[] })
const FULL = 'ABCDEFGHI'

export const ACTS_SCENARIOS: ActsScenario[] = [
  {
    name: '分ける / 分ける',
    emu: true,
    body: 'ABCDEF',
    splitAt: null,
    x: split([3]),
    y: split([2, 4]),
    text: 'ABCDEF',
    acts: (o) => (o === 'x-first' ? 2 : 3),
    notes: lostOnSecond,
  },
  {
    name: '第1幕と第2幕をつなぐ / 第2幕と第3幕をつなぐ',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: join(1),
    text: FULL,
    acts: 2,
    notes: lostOnSecond,
  },
  {
    name: '第1幕と第2幕をつなぐ / 第2幕と第3幕をつなぐ（採用していない稿もある）',
    emu: true,
    body: FULL,
    splitAt: [3, 6],
    prepare: (d, ep) => {
      const a = S.addVersion(d, actsIds(d, ep)[1], { body: 'DEF別稿' }).data
      return S.addVersion(a, actsIds(a, ep)[2], { body: 'GHI別稿' }).data
    },
    x: join(0),
    y: join(1),
    text: FULL,
    acts: 2,
    notes: lostOnSecond,
    check: (d, _ep, order) => {
      // 負けた端末がつないだ時にゴミ箱へ入れた稿は、幕が戻ったので稿に戻り、ゴミ箱に二重に残らない
      const back = order === 'x-first' ? 'GHI別稿' : 'DEF別稿'
      if (!liveVersionPiece(d, back)) return `「${back}」が稿に戻っていない`
      const inTrash = Object.values(d.trashRecords).filter((r) => (r.record as { body?: string }).body === back)
      return inTrash.length ? `「${back}」がゴミ箱にも残っている` : null
    },
  },
  {
    name: '第1幕と第2幕をつなぐ / 第2幕をさらに分ける',
    emu: true,
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: furtherSplit(1, [1]),
    text: FULL,
    acts: (o) => (o === 'x-first' ? 2 : 4),
    notes: lostOnSecond,
  },
  {
    name: '第2幕と第3幕をつなぐ / 第2幕をさらに分ける',
    body: FULL,
    splitAt: [3, 6],
    x: join(1),
    y: furtherSplit(1, [1]),
    text: FULL,
    acts: (o) => (o === 'x-first' ? 2 : 4),
    notes: lostOnSecond,
  },
  {
    name: 'セパレート解除 / 第2幕をさらに分ける',
    emu: true,
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: furtherSplit(1, [1]),
    text: FULL,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['lost'] } : { x: ['won'] }),
  },
  {
    name: 'セパレート解除 / 第1幕と第2幕をつなぐ',
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: join(0),
    text: FULL,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['lost'] } : { x: ['won'] }),
  },
  {
    name: 'セパレート解除 / 第2幕の採用稿を書き換える',
    emu: true,
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: editAct(1, 'DXF', 'Yのメモ'),
    text: FULL,
    acts: 0,
    notes: dropped,
    check: (d, ep) => {
      const v = Object.values(d.versions).find((x) => x.body === 'DXF')
      if (!v || v.pieceId !== ep) return '書き換えた第2幕の稿が話の稿として残っていない'
      if (v.note !== 'Yのメモ') return '書き換えた稿の推敲メモが残っていない'
      return /第2幕の/.test(v.name) && /競合/.test(v.name) ? null : `控えの名前が違う: ${v.name}`
    },
  },
  {
    name: '分ける / 話の採用稿を書き換える',
    emu: true,
    body: 'ABCDEF',
    splitAt: null,
    x: split([3]),
    y: (d, ep) => S.updateVersion(d, adopted(d, ep), { body: 'ABCDEF+Y' }),
    text: 'ABCDEF',
    acts: 2,
    notes: () => ({ x: ['source'], y: ['stale'] }),
    check: onEpisode('ABCDEF+Y'),
  },
  {
    name: '分ける / 話の別の稿を採用する',
    body: 'ABCDEF',
    splitAt: null,
    x: split([3]),
    y: (d, ep) => {
      const r = S.addVersion(d, ep, { body: 'NEW' })
      return S.setActiveVersion(r.data, ep, r.result)
    },
    text: 'ABCDEF',
    acts: 2,
    notes: dropped,
    check: (d, ep) => {
      if (onEpisode('NEW')(d, ep)) return '採用した稿が話の稿に残っていない'
      const active = d.versions[d.pieces[ep]?.activeVersionId ?? '']
      return active?.body === 'ABCDEF' ? null : '分けた時の採用稿が話の採用稿でなくなった'
    },
  },
  {
    name: '第1幕と第2幕をつなぐ / 第2幕の採用稿を書き換える',
    emu: true,
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: editAct(1, 'DXF'),
    text: FULL,
    acts: 2,
    notes: dropped,
    check: onAct('DXF', 0),
  },
  {
    name: '第1幕と第2幕をつなぐ / 第1幕の採用稿を書き換える',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: editAct(0, 'ABC+Y'),
    text: FULL,
    acts: 2,
    notes: () => ({ y: ['stale'] }),
    check: onAct('ABC+Y', 0),
  },
  {
    name: '第1幕と第2幕をつなぐ / 第1幕で別の稿を採用する',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: (d, ep) => {
      const a1 = actsIds(d, ep)[0]
      const r = S.addVersion(d, a1, { body: 'abc' })
      return S.setActiveVersion(r.data, a1, r.result)
    },
    text: FULL,
    acts: 2,
    notes: dropped,
    check: onAct('abc', 0),
  },
  {
    name: '第1幕と第2幕をつなぐ / 第2幕に稿を足す',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: (d, ep) => S.addVersion(d, actsIds(d, ep)[1], { body: 'Yの第2稿' }).data,
    text: FULL,
    acts: 2,
    notes: dropped,
    check: onAct('Yの第2稿', 0),
  },
  {
    name: '第2幕をさらに分ける / 第2幕の採用稿を書き換える',
    body: FULL,
    splitAt: [3, 6],
    x: furtherSplit(1, [1]),
    y: editAct(1, 'DEF+Y'),
    text: FULL,
    acts: 4,
    notes: () => ({ y: ['stale'] }),
    check: onAct('DEF+Y', 1),
  },
  {
    name: '分ける / 話を削除する',
    emu: true,
    body: 'ABCDEF',
    splitAt: null,
    x: split([3]),
    y: (d, ep) => S.deletePiece(d, ep),
    text: null,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['deletedHere'] } : { x: ['deletedThere'] }),
  },
  {
    name: '第1幕と第2幕をつなぐ / 話を削除する',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: (d, ep) => S.deletePiece(d, ep),
    text: null,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['deletedHere'] } : { x: ['deletedThere'] }),
  },
  {
    name: '分けて題を変える / 分けて題を変える',
    body: 'ABCDEF',
    splitAt: null,
    x: (d, ep) => S.updatePiece(split([3])(d, ep), ep, { subtitle: 'Xの題' }),
    y: (d, ep) => S.updatePiece(split([2, 4])(d, ep), ep, { subtitle: 'Yの題' }),
    text: 'ABCDEF',
    acts: (o) => (o === 'x-first' ? 2 : 3),
    notes: lostOnSecond,
  },
  {
    name: 'セパレート解除 / 解除して分け直す',
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: (d, ep) => split([4])(unseparate(d, ep), ep),
    text: FULL,
    acts: (o) => (o === 'x-first' ? 0 : 2),
    notes: lostOnSecond,
  },
  {
    name: '第2幕をさらに分ける / 第2幕を別の位置でさらに分ける',
    body: FULL,
    splitAt: [3, 6],
    x: furtherSplit(1, [1]),
    y: furtherSplit(1, [2]),
    text: FULL,
    acts: 4,
    notes: lostOnSecond,
  },
  {
    name: '第1幕と第2幕をつなぐ / 第3幕をさらに分ける',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: furtherSplit(2, [1]),
    text: FULL,
    acts: (o) => (o === 'x-first' ? 2 : 4),
    notes: lostOnSecond,
  },
  {
    name: 'セパレート解除 / 話を削除する',
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: (d, ep) => S.deletePiece(d, ep),
    text: null,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['deletedHere'] } : { x: ['deletedThere'] }),
  },
  {
    name: '第2幕に稿を足す / 話を削除する',
    body: FULL,
    splitAt: [3, 6],
    x: (d, ep) => S.addVersion(d, actsIds(d, ep)[1], { body: 'Xの第2稿' }).data,
    y: (d, ep) => S.deletePiece(d, ep),
    text: null,
    acts: 0,
    notes: (o) => (o === 'x-first' ? { y: ['deletedHere'] } : { x: ['deletedThere'] }),
  },
  // 重なっても結果が同じ・別々の項目なので、幕の知らせは出さない
  {
    name: 'セパレート解除 / セパレート解除',
    body: FULL,
    splitAt: [3, 6],
    x: unseparate,
    y: unseparate,
    text: FULL,
    acts: 0,
    notes: quiet,
  },
  {
    name: '第1幕と第2幕をつなぐ / 同じ幕をつなぐ',
    body: FULL,
    splitAt: [3, 6],
    x: join(0),
    y: join(0),
    text: FULL,
    acts: 2,
    notes: quiet,
  },
  {
    name: '分ける / 話の題を変える',
    body: 'ABCDEF',
    splitAt: null,
    x: split([3]),
    y: (d, ep) => S.updatePiece(d, ep, { subtitle: 'Yの題' }),
    text: 'ABCDEF',
    acts: 2,
    notes: quiet,
    check: (d, ep) => (d.pieces[ep]?.subtitle === 'Yの題' ? null : '題の変更が残っていない'),
  },
]

/** 場面の最初の状態（タイトル・第1話・採用稿の本文。分ける位置があれば分ける） */
export function scenarioStart(s: Pick<ActsScenario, 'body' | 'splitAt' | 'prepare'>): { data: AppData; ep: ID } {
  const t = E.createTitle(emptyData(), '作品')
  const e = S.addEpisode(t.data, t.result)
  const ep = e.result
  const vid = e.data.pieces[ep].versionIds[0]
  let data = S.setActiveVersion(S.updateVersion(e.data, vid, { body: s.body, note: '元のメモ' }), ep, vid)
  if (s.splitAt) data = A.separatePiece(data, ep, s.splitAt).data
  if (s.prepare) data = s.prepare(data, ep)
  return { data, ep }
}

/** 稿・ゴミ箱にある本文と推敲メモ（空でないもの） */
export function texts(d: AppData): string[] {
  const out: string[] = []
  for (const v of Object.values(d.versions)) out.push(v.body, v.note)
  return out.filter((t) => t.trim() !== '')
}

function pool(d: AppData): string[] {
  const out: string[] = []
  for (const v of Object.values(d.versions)) out.push(v.body, v.note)
  for (const r of Object.values(d.trashRecords)) {
    const rec = r.record as { body?: unknown; note?: unknown }
    if (typeof rec.body === 'string') out.push(rec.body)
    if (typeof rec.note === 'string') out.push(rec.note)
  }
  return out
}

/** I3: 幕の形の問題（端末内の内容そのものを見る） */
export function structureProblems(d: AppData): string[] {
  const p: string[] = []
  const listed = new Map<ID, ID[]>()
  const short = (id: string) => id.slice(0, 6)
  for (const e of Object.values(d.pieces)) {
    if (e.kind !== 'episode' || !Array.isArray(e.actIds)) continue
    const seen = new Set<ID>()
    for (const id of e.actIds) {
      if (seen.has(id)) p.push(`幕 ${short(id)} が2回載っている`)
      seen.add(id)
      listed.set(id, [...(listed.get(id) ?? []), e.id])
      const a = d.pieces[id]
      if (!a) p.push(`載っている幕 ${short(id)} が無い`)
      else if (a.parentId !== e.id) p.push(`載っている幕 ${short(id)} の属する話が違う`)
    }
    if (e.actIds.length > 0 && !e.actIds.some((id) => d.pieces[id])) p.push('分けた話に幕が無い')
  }
  for (const a of Object.values(d.pieces)) {
    if (a.kind !== 'act' && !(a.kind !== 'special' && typeof a.parentId === 'string')) continue
    if (!d.pieces[a.parentId ?? '']) p.push(`幕 ${short(a.id)} の属する話が無い`)
    const l = listed.get(a.id) ?? []
    if (l.length === 0) p.push(`幕 ${short(a.id)} がどの話にも載っていない`)
    if (l.length > 1) p.push(`幕 ${short(a.id)} が2つの話に載っている`)
  }
  for (const v of Object.values(d.versions)) {
    if (!d.pieces[v.pieceId]) p.push(`稿 ${short(v.id)}（${v.body}）の話・幕が無い`)
  }
  for (const piece of Object.values(d.pieces)) {
    for (const id of piece.versionIds) if (!d.versions[id]) p.push(`話・幕 ${short(piece.id)} の稿の一覧に無い稿 ${short(id)}`)
  }
  return p
}

/**
 * 各ゴミ箱の稿の件が、いま・後でセパレート解除した後・後で第1幕と第2幕をつないだ後に戻せるか。
 * 話ごと消えていれば、先に話の件を戻してから確かめる（利用者と同じ順に）
 */
export function restoreProblems(data: AppData, ep: ID): string[] {
  const out: string[] = []
  const splitRefusal = (msg: string) => /幕に分けている/.test(msg)
  let start = data
  if (!data.pieces[ep]) {
    const pe = Object.values(data.trashEntries).find((x) => x.kind === 'piece')
    if (pe) {
      try {
        start = restoreTrashEntry(data, pe.id).data
      } catch (err) {
        return [`話の件を戻せない: ${(err as Error).message}`]
      }
    }
  }
  const variants: [string, AppData][] = [['いま', start]]
  const e = start.pieces[ep]
  if (e && isSplit(e)) {
    try {
      variants.push(['解除した後', A.unseparatePiece(start, ep).data])
    } catch {
      /* 採用稿の無い幕があれば解除できない */
    }
    const ids = actsOf(start, e).map((a) => a.id)
    if (ids.length >= 2) {
      try {
        variants.push(['つないだ後', A.joinActWithNext(start, ids[0]).data])
      } catch {
        /* つなげない */
      }
    }
  }
  for (const entry of Object.values(start.trashEntries)) {
    if (entry.kind !== 'version') continue
    const refused: string[] = []
    let restoredSomewhere = false
    for (const [name, d] of variants) {
      if (!d.trashEntries[entry.id]) continue
      try {
        restoreTrashEntry(d, entry.id)
        restoredSomewhere = true
      } catch (err) {
        const msg = (err as Error).message
        // 幕に分けている話の稿は、解除するまで戻せない（仕様）
        if (splitRefusal(msg)) refused.push(name)
        else out.push(`「${entry.label}」を${name}戻せない: ${msg}`)
      }
    }
    if (!restoredSomewhere && refused.length) out.push(`「${entry.label}」をどの場面でも戻せない`)
  }
  return out
}

/** 揃った後の内容が場面の約束を守っているか（問題の一覧） */
export function scenarioProblems(
  s: ActsScenario,
  order: Order,
  d: AppData,
  ep: ID,
  seen: readonly string[],
  notes: {
    x: readonly { detail?: string; id: string; kind: string }[]
    y: readonly { detail?: string; id: string; kind: string }[]
  },
): string[] {
  const out: string[] = []
  const all = pool(d)
  for (const t of new Set(seen)) if (!all.some((q) => q.includes(t))) out.push(`I1 文章が消えた: ${JSON.stringify(t)}`)
  out.push(...structureProblems(d).map((m) => `I3 ${m}`))
  const v = view(d)
  const episode = v.pieces[ep]
  const text = episode ? activeBody(v, episode) : null
  if (text !== s.text) out.push(`採用原稿が違う: ${JSON.stringify(text)}（期待 ${JSON.stringify(s.text)}）`)
  const wantActs = typeof s.acts === 'function' ? s.acts(order) : s.acts
  const actCount = episode && isSplit(episode) ? actsOf(v, episode).length : 0
  if (episode && actCount !== wantActs) out.push(`幕の数が違う: ${actCount}（期待 ${wantActs}）`)
  const want = s.notes(order)
  for (const who of ['x', 'y'] as const) {
    const expected = want[who]
    if (!expected) continue
    const got = notes[who].filter((n) => n.kind === 'acts')
    if (expected.length === 0 && got.length) out.push(`I4 ${who} に幕の知らせが出た: ${got.map((n) => n.detail).join(',')}`)
    for (const detail of expected) {
      if (!got.some((n) => n.detail === detail && n.id === ep))
        out.push(`I4 ${who} に「${detail}」の知らせが無い（${got.map((n) => n.detail).join(',') || 'なし'}）`)
    }
  }
  const extra = s.check?.(d, ep, order)
  if (extra) out.push(extra)
  out.push(...restoreProblems(d, ep).map((m) => `S9 ${m}`))
  return out
}
