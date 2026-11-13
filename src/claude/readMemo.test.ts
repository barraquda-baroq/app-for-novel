// 読んだ本文の控え（コネクタの接続ごと。L2-2）: novel_read_text のページに出した区切り（served）と、控えの決め方、
// 推敲案の covered が読んだ時の指紋を残すこと（アプリの「本文が変わった話」に出る）
import { describe, expect, it } from 'vitest'
import { addClaudeRecords } from '../domain/claudeOps'
import { joinActWithNext } from '../domain/acts'
import { hashJson } from '../domain/hash'
import { updateVersion } from '../domain/storyOps'
import type { AppData, ID, ProofBatch } from '../domain/types'
import { novel, splitEpisode } from '../test/claudeFixture'
import { adoptedBodyHash, proofCoverage } from './order'
import { changedSinceRead, noteServed, type ReadMemoAccess, type ReadMemoEntry } from './readMemo'
import { buildProofreading, type BuildContext } from './records'
import { readTextView, type ServedPart } from './view'

const NOW = Date.UTC(2026, 9, 28, 3, 0)

/** 控え（1つの接続） */
function memo(): ReadMemoAccess & { map: Map<ID, ReadMemoEntry> } {
  const map = new Map<ID, ReadMemoEntry>()
  return { map, get: (id) => map.get(id), set: (id, e) => void map.set(id, e) }
}

const versionOf = (data: AppData, pieceId: ID) => data.pieces[pieceId].activeVersionId!

/** 採用原稿を直す */
const edit = (data: AppData, pieceId: ID, body: string) => updateVersion(data, versionOf(data, pieceId), { body })

/** 読んで控える（ページを順に） */
function readAll(data: AppData, titleId: ID, m: ReadMemoAccess, opts: Parameters<typeof readTextView>[2] = {}) {
  const r = readTextView(data, titleId, opts)
  if (!r.ok) throw new Error(r.error)
  noteServed(data, r.served ?? [], m)
  return r
}

describe('novel_read_text のページに出した区切り（served）', () => {
  it('話・幕・特殊ブロックの採用原稿を出した区切りと、始めから出したか', () => {
    const n = novel(['第一話。', '第二話。'.repeat(3), '第一幕の本文。\n第二幕の本文。'])
    const { acts } = splitEpisode(n, n.ids[2], [8])
    const r = readTextView(n.data, n.titleId, {})
    expect(r.ok && r.served).toEqual<ServedPart[]>([
      { pieceId: n.ids[0], start: true },
      { pieceId: n.ids[1], start: true },
      { pieceId: acts[0], start: true },
      { pieceId: acts[1], start: true },
    ])
  })
  it('長い話を分けて出す: 前のページの続きは start = false。採用していない稿を指定して読んでも出したことにしない', () => {
    const long = Array.from({ length: 12 }, (_, k) => `段落${k + 1}。${'あ'.repeat(280)}`).join('\n')
    const n = novel([long, '第二話。'])
    const first = readTextView(n.data, n.titleId, { charBudget: 2_000 })
    expect(first.ok && first.served).toEqual([{ pieceId: n.ids[0], start: true }])
    const second = readTextView(n.data, n.titleId, { charBudget: 2_000, cursor: first.ok ? first.nextCursor! : '' })
    expect(second.ok && second.served).toEqual([
      { pieceId: n.ids[0], start: false },
      { pieceId: n.ids[1], start: true },
    ])
    // 採用中の稿を指定: その話を読んだことにする。採用していない稿: しない
    const adopted = readTextView(n.data, n.titleId, { versionId: versionOf(n.data, n.ids[1]) })
    expect(adopted.ok && adopted.served).toEqual([{ pieceId: n.ids[1], start: true }])
    const piece = n.data.pieces[n.ids[1]]
    const other = { ...n.data.versions[piece.activeVersionId!], id: 'v-other', name: '第2稿' }
    const data: AppData = {
      ...n.data,
      versions: { ...n.data.versions, [other.id]: other },
      pieces: { ...n.data.pieces, [piece.id]: { ...piece, versionIds: [...piece.versionIds, other.id] } },
    }
    const notAdopted = readTextView(data, n.titleId, { versionId: other.id })
    expect(notAdopted.ok && notAdopted.served).toEqual([])
  })
})

describe('控えの決め方（noteServed）', () => {
  it('読んだ時の採用原稿の指紋（proofCoverage と同じ値）。幕は幕と、幕の属する話の両方', () => {
    const n = novel(['第一話。', '第一幕の本文。\n第二幕の本文。'])
    const { acts } = splitEpisode(n, n.ids[1], [8])
    const m = memo()
    readAll(n.data, n.titleId, m)
    expect(m.get(n.ids[0])).toEqual({
      hash: adoptedBodyHash(n.data, n.ids[0]),
      versionId: versionOf(n.data, n.ids[0]),
      parts: { [n.ids[0]]: hashJson('第一話。') },
    })
    expect(m.get(n.ids[1])).toMatchObject({ hash: adoptedBodyHash(n.data, n.ids[1]), versionId: null })
    expect(Object.keys(m.get(n.ids[1])!.parts)).toEqual(acts)
    expect(m.get(acts[1])).toMatchObject({ hash: hashJson('第二幕の本文。'), versionId: versionOf(n.data, acts[1]) })
  })

  it('前のページの続きを読む前に、読んだ所が直された: 読み始めた時の指紋のまま。始めから読み直すといまの指紋', () => {
    const long = Array.from({ length: 12 }, (_, k) => `段落${k + 1}。${'あ'.repeat(280)}`).join('\n')
    const n = novel([long])
    const m = memo()
    const first = readAll(n.data, n.titleId, m, { charBudget: 2_000 })
    const edited = edit(n.data, n.ids[0], long.replace('段落1。', '段落1（直した）。'))
    for (let cursor = first.ok ? first.nextCursor : null; cursor; ) {
      const page = readAll(edited, n.titleId, m, { charBudget: 2_000, cursor })
      cursor = page.ok ? page.nextCursor : null
    }
    expect(m.get(n.ids[0])!.hash).toBe(hashJson(long))
    expect(changedSinceRead(edited, edited.pieces[n.ids[0]], m.get)).toBe(true)
    readAll(edited, n.titleId, m, { charBudget: 2_000 })
    expect(m.get(n.ids[0])!.hash).toBe(adoptedBodyHash(edited, n.ids[0]))
    expect(changedSinceRead(edited, edited.pieces[n.ids[0]], m.get)).toBe(false)
  })

  it('幕に分けた話: まだ読んでいない幕だけが直された時はいまの指紋、読んだ幕が直された時は読み始めた時の指紋', () => {
    const n = novel(['第一幕。\n第二幕。\n第三幕。'])
    const { acts } = splitEpisode(n, n.ids[0], [5, 10])
    const m = memo()
    readAll(n.data, n.titleId, m, { pieces: ['#1.1'] })
    const later = edit(n.data, acts[2], '第三幕（直した）。')
    readAll(later, n.titleId, m, { pieces: ['#1.2', '#1.3'] })
    expect(m.get(n.ids[0])!.hash).toBe(adoptedBodyHash(later, n.ids[0]))
    // 第1幕から読み直し、第1幕が直された後に続きを読む
    readAll(later, n.titleId, m, { pieces: ['#1.1'] })
    const before = adoptedBodyHash(later, n.ids[0])
    const earlier = edit(later, acts[0], '第一幕（直した）。\n')
    readAll(earlier, n.titleId, m, { pieces: ['#1.2', '#1.3'] })
    expect(m.get(n.ids[0])!.hash).toBe(before)
    // 直した幕の控えは残る（その幕を読み直すまで、変わったまま）
    readAll(earlier, n.titleId, m, { pieces: ['#1.3'] })
    expect(m.get(n.ids[0])!.hash).toBe(before)
    // 直した幕を始めから読み直すと、いまの指紋
    readAll(earlier, n.titleId, m, { pieces: ['#1.1'] })
    expect(m.get(n.ids[0])!.hash).toBe(adoptedBodyHash(earlier, n.ids[0]))
  })

  it('全部読んだ後に第3幕が直され、第1幕だけを読み直した: 直した第3幕は読んでいないので前の指紋のまま', () => {
    const n = novel(['第一幕。\n第二幕。\n第三幕。'])
    const { acts } = splitEpisode(n, n.ids[0], [5, 10])
    const m = memo()
    readAll(n.data, n.titleId, m)
    const before = adoptedBodyHash(n.data, n.ids[0])
    const edited = edit(n.data, acts[2], '第三幕（直した）。')
    readAll(edited, n.titleId, m, { pieces: ['#1.1'] })
    expect(m.get(n.ids[0])!.hash).toBe(before)
    readAll(edited, n.titleId, m, { pieces: ['#1.3'] })
    expect(m.get(n.ids[0])!.hash).toBe(adoptedBodyHash(edited, n.ids[0]))
  })

  it('読んだ後に幕をつないで直した: 話の始めから読み直すと、つなぐ前の幕の控えは忘れていまの指紋', () => {
    const n = novel(['第一幕。\n第二幕。\n第三幕。'])
    const { acts } = splitEpisode(n, n.ids[0], [5, 10])
    const m = memo()
    readAll(n.data, n.titleId, m)
    const joined = joinActWithNext(n.data, acts[0]).data
    const edited = edit(joined, acts[0], '第一幕と第二幕（直した）。\n')
    readAll(edited, n.titleId, m)
    expect(m.get(n.ids[0])!.hash).toBe(adoptedBodyHash(edited, n.ids[0]))
    expect(Object.keys(m.get(n.ids[0])!.parts)).toEqual([acts[0], acts[2]])
  })

  it('読んだ後に幕に分けて第1幕を直し、第2幕だけを読んだ: 話の始めから読み直すまで、読み始めた時の指紋', () => {
    const n = novel(['第一幕。\n第二幕。'])
    const m = memo()
    readAll(n.data, n.titleId, m)
    const before = adoptedBodyHash(n.data, n.ids[0])
    const { acts } = splitEpisode(n, n.ids[0], [5])
    // 分けただけ（つないだ本文は同じ）なら変わっていない
    expect(adoptedBodyHash(n.data, n.ids[0])).toBe(before)
    const edited = edit(n.data, acts[0], '第一幕（直した）。\n')
    readAll(edited, n.titleId, m, { pieces: ['#1.2'] })
    expect(m.get(n.ids[0])!.hash).toBe(before)
    expect(changedSinceRead(edited, edited.pieces[n.ids[0]], m.get)).toBe(true)
    // 第1幕は読んでいない（控えが無い）ので、幕の属する話の控えで見る
    expect(changedSinceRead(edited, edited.pieces[acts[0]], m.get)).toBe(true)
    expect(changedSinceRead(edited, edited.pieces[acts[1]], m.get)).toBe(false)
  })
})

describe('推敲案の covered（読んだ時の控え）', () => {
  function setup() {
    const n = novel(['第一話。', '第二話。彼は見れる景色を眺めた。'])
    const m = memo()
    readAll(n.data, n.titleId, m)
    const edited = edit(n.data, n.ids[1], '作者が足した段落。\n第二話。彼は見れる景色を眺めた。')
    const ctx: BuildContext = { source: 'claude', now: NOW, readAs: m.get }
    return { n, m, edited, ctx }
  }
  const batchOf = (r: ReturnType<typeof buildProofreading>) =>
    r.records.find((x) => x.table === 'proofBatches')!.record as ProofBatch

  it('読んだ後に変わった話は読んだ時の指紋と採用稿を残し、補足で知らせる。アプリの確かめた範囲では「本文が変わった話」', () => {
    const { n, edited, ctx } = setup()
    const r = buildProofreading(edited, { title_id: n.titleId, covered: ['#1', '#2'], items: [] }, ctx)
    const batch = batchOf(r)
    expect(batch.covered.map((c) => c.bodyHash)).toEqual([hashJson('第一話。'), hashJson('第二話。彼は見れる景色を眺めた。')])
    expect(batch.covered[1].versionId).toBe(versionOf(n.data, n.ids[1]))
    expect(r.notes).toEqual([
      '#2 第2話 は読んだ後に本文が変わっています（変わった所は推敲できていないため、確認の範囲では「本文が変わった話」になります。novel_read_text で読み直して推敲してください）',
    ])
    const after = addClaudeRecords(edited, r.records).data
    expect(proofCoverage(after, n.titleId).text).toBe('本文が変わった話 #2')
  })

  it('控えが無い（貼り付け・読んでいない接続）・変わっていない時は、今までどおり書く時の指紋で確認済み', () => {
    const { n, edited } = setup()
    for (const ctx of [
      { source: 'paste', now: NOW },
      { source: 'claude', now: NOW, readAs: () => undefined },
      { source: 'claude', now: NOW, readAs: (id: ID) => ({ hash: adoptedBodyHash(edited, id), versionId: null, parts: {} }) },
    ] satisfies BuildContext[]) {
      const r = buildProofreading(edited, { title_id: n.titleId, covered: ['#1', '#2'], items: [] }, ctx)
      expect(batchOf(r).covered[1].bodyHash).toBe(adoptedBodyHash(edited, n.ids[1]))
      expect(r.notes).toEqual([])
      expect(proofCoverage(addClaudeRecords(edited, r.records).data, n.titleId).text).toBe('すべて確認済み')
    }
  })

  it('読んだ後に変わって引用が見つからない時は、本文が変わったことを言う', () => {
    const { n, m } = setup()
    const changed = edit(n.data, n.ids[1], '第二話。彼は見られる景色を眺めた。')
    const item = { piece: '#2', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }
    const r = buildProofreading(changed, { title_id: n.titleId, items: [item] }, { source: 'claude', now: NOW, readAs: m.get })
    expect(r.items[0].hint).toBe(
      '抜き出した箇所が#2 第2話の採用原稿に見つかりません。読んだ後に本文が変わっています（novel_read_text で読み直して、いまの本文から引用してください）',
    )
    const paste = buildProofreading(changed, { title_id: n.titleId, items: [item] }, { source: 'paste', now: NOW })
    expect(paste.items[0].hint).toContain('採用原稿から原文どおり')
  })
})
