import { describe, expect, it } from 'vitest'
import { decodeRecord, encodeRecord, hashRecord, splitJson, type ChunkDoc, type RecordDoc } from './codec'
import { contentEqual, deepEqual, mergeFields, mergeList, mergeRemote, stableStringify } from './merge'

const D = { device: 'テスト端末' }

describe('比較', () => {
  it('キーの順番と undefined の項目は問わない', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, x: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
  })
  it('contentEqual は更新日時を見ない', () => {
    expect(contentEqual({ id: 'a', updatedAt: 1 }, { id: 'a', updatedAt: 2 })).toBe(true)
    expect(contentEqual(null, null)).toBe(true)
    expect(contentEqual(null, { id: 'a' })).toBe(false)
  })
})

describe('並びのマージ', () => {
  const id = (x: unknown) => String(x)
  it('片方だけが変えたらその並び', () => {
    expect(mergeList(['a', 'b'], ['b', 'a'], ['a', 'b'], id)).toEqual(['b', 'a'])
    expect(mergeList(['a', 'b'], ['a', 'b'], ['a', 'b', 'c'], id)).toEqual(['a', 'b', 'c'])
  })
  it('両方が足したら両方入る（相手が足したものは相手の並びでの直前の要素の後ろ）', () => {
    expect(mergeList(['a', 'b'], ['a', 'b', 'm'], ['a', 't', 'b'], id)).toEqual(['a', 't', 'b', 'm'])
    expect(mergeList(['a'], ['m', 'a'], ['t', 'a'], id)).toEqual(['t', 'm', 'a'])
  })
  it('相手が消したものは消え、こちらが消したものは戻らない', () => {
    expect(mergeList(['a', 'b', 'c'], ['c', 'b', 'a'], ['a', 'c', 'd'], id)).toEqual(['c', 'd', 'a'])
    expect(mergeList(['a', 'b'], ['a'], ['b', 'a', 'x'], id)).toEqual(['a', 'x'])
  })
  it('中身を持つ要素は、こちらが変えていなければ相手の中身を使う', () => {
    const byId = (x: unknown) => (x as { id: string }).id
    const base = [
      { id: '1', v: 'a' },
      { id: '2', v: 'b' },
    ]
    const mine = [
      { id: '2', v: 'b' },
      { id: '1', v: 'a' },
    ]
    const theirs = [
      { id: '1', v: 'A' },
      { id: '2', v: 'b' },
      { id: '3', v: 'c' },
    ]
    expect(mergeList(base, mine, theirs, byId)).toEqual([
      { id: '2', v: 'b' },
      { id: '3', v: 'c' },
      { id: '1', v: 'A' },
    ])
  })
})

describe('レコードのマージ', () => {
  const base = { id: 't', name: '元', synopsis: '', structure: [{ type: 'piece', id: 'p1' }], updatedAt: 1 }
  it('別々の項目の変更は両方残る', () => {
    const mine = { ...base, name: 'こちら', updatedAt: 3 }
    const theirs = { ...base, synopsis: 'あちら', updatedAt: 2 }
    const r = mergeFields('titles', base, mine, theirs, D).record as typeof base
    expect(r.name).toBe('こちら')
    expect(r.synopsis).toBe('あちら')
    expect(r.updatedAt).toBe(3)
  })
  it('構成の並びは要素ごとに合わせる', () => {
    const mine = { ...base, structure: [...base.structure, { type: 'piece', id: 'm' }] }
    const theirs = { ...base, structure: [{ type: 'piece', id: 't' }, ...base.structure] }
    const r = mergeFields('titles', base, mine, theirs, D).record as typeof base
    expect(r.structure.map((n) => n.id)).toEqual(['t', 'p1', 'm'])
  })
  it('稿の本文が両方で変わっていたら、クラウド側を採って競合を知らせる', () => {
    const v = { id: 'v', body: '元', note: '', updatedAt: 1 }
    const mine = { ...v, body: 'こちら', note: 'メモ' }
    const theirs = { ...v, body: 'あちら' }
    const r = mergeRemote('versions', v, mine, theirs, D)
    expect((r.record as typeof v).body).toBe('あちら')
    expect((r.record as typeof v).note).toBe('メモ')
    expect((r.bodyConflict as typeof v).body).toBe('こちら')
  })
  it('同じ本文に変えていたら競合にしない', () => {
    const v = { id: 'v', body: '元', updatedAt: 1 }
    const mine = { ...v, body: '同じ' }
    const theirs = { ...v, body: '同じ', updatedAt: 5 }
    const r = mergeRemote('versions', v, mine, theirs, D)
    expect(r.bodyConflict).toBeUndefined()
  })
  it('削除と編集がぶつかったら削除を優先し、編集された内容を返す', () => {
    const m = { id: 'm', body: '元', updatedAt: 1 }
    const edited = { ...m, body: '追記' }
    expect(mergeRemote('memos', m, edited, null, D)).toEqual({ record: null, deletedEdit: edited })
    expect(mergeRemote('memos', m, null, edited, D)).toEqual({ record: null, deletedEdit: edited })
  })
  it('この端末で作ったもの（クラウドに無かったもの）は消さない', () => {
    const m = { id: 'm', body: '新しい' }
    expect(mergeRemote('memos', null, m, null, D)).toEqual({ record: m })
  })
  it('変えていなければクラウドの内容、クラウドが変わっていなければこの端末の内容', () => {
    const m = { id: 'm', body: '元', updatedAt: 1 }
    const t = { ...m, body: 'あちら', updatedAt: 2 }
    expect(mergeRemote('memos', m, m, t, D).record).toBe(t)
    const mine = { ...m, body: 'こちら' }
    expect(mergeRemote('memos', m, mine, { ...m, updatedAt: 9 }, D).record).toBe(mine)
  })
})

describe('文書の形', () => {
  it('大きなレコードは分割し、つなぎ直すと元に戻る（サロゲートペアを切らない）', () => {
    const rec = { id: 'v1', body: 'あ𠮷'.repeat(100) }
    const enc = encodeRecord(rec, 7)
    expect(enc.json).toBeNull()
    expect(enc.parts.length).toBeGreaterThan(10)
    for (const p of enc.parts) {
      const last = p.charCodeAt(p.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    const doc: RecordDoc = {
      table: 'versions',
      id: 'v1',
      json: null,
      chunks: enc.parts.length,
      deleted: false,
      hash: enc.hash,
      updated: null,
      device: 'd',
    }
    const chunk = (i: number): ChunkDoc => ({
      table: '_chunk',
      parent: 'versions:v1',
      index: i,
      json: enc.parts[i],
      hash: enc.hash,
      updated: null,
      device: 'd',
      deleted: false,
    })
    expect(decodeRecord(doc, chunk)).toEqual(rec)
    // 分割文書が揃わない・別の版の分割文書なら読み直しが要る
    expect(decodeRecord(doc, (i) => (i === 3 ? undefined : chunk(i)))).toBeUndefined()
    expect(decodeRecord(doc, (i) => ({ ...chunk(i), hash: 'old' }))).toBeUndefined()
  })
  it('指紋は内容が同じなら同じ', () => {
    const r1 = { id: 'a', x: 1, y: 2 }
    const r2 = { y: 2, id: 'a', x: 1 }
    const r3 = { id: 'a', x: 2 }
    expect(hashRecord(r1)).toBe(hashRecord(r2))
    expect(hashRecord(r1)).not.toBe(hashRecord(r3))
    expect(hashRecord(null)).toBe('')
    expect(splitJson('abcdef', 4)).toEqual(['abcd', 'ef'])
  })
})

describe('共通の履歴が無い時（初めてのログイン・アカウントの切り替え）', () => {
  const N = { device: 'iPhone', noHistory: true }
  it('クラウド側を採り、この端末にしか無い文章は控える', () => {
    const cloud = { id: 'm', body: '新しい', updatedAt: 5 }
    const local = { id: 'm', body: '古い', updatedAt: 9 }
    expect(mergeRemote('memos', null, local, cloud, N)).toEqual({ record: cloud, keptCopy: local })
    const mineV = { id: 'v', body: 'こちら' }
    const theirV = { id: 'v', body: 'あちら' }
    const v = mergeRemote('versions', null, mineV, theirV, N)
    expect(v.record).toEqual({ id: 'v', body: 'あちら' })
    expect(v.bodyConflict).toEqual({ id: 'v', body: 'こちら' })
  })
  it('同じ内容なら控えない。クラウドで削除されていれば削除を優先して控える', () => {
    const a = { id: 'm', body: '同じ', updatedAt: 1 }
    expect(mergeRemote('memos', null, a, { ...a, updatedAt: 2 }, N)).toEqual({ record: { ...a, updatedAt: 2 } })
    expect(mergeRemote('memos', null, a, null, N)).toEqual({ record: null, deletedEdit: a })
  })
  it('並びにはこの端末にしか無い要素を足す', () => {
    const cloud = { id: 'p', versionIds: ['v1', 'v2'] }
    const local = { id: 'p', versionIds: ['v1', 'mine'] }
    expect((mergeRemote('pieces', null, local, cloud, N).record as typeof cloud).versionIds).toEqual(['v1', 'mine', 'v2'])
  })
})

describe('長い文章の項目が両方で書き換えられた時', () => {
  it('クラウド側の文章の後ろに、この端末の文章を印付きでつなぐ', () => {
    const base = { id: 'm', name: 'メモ', body: '元', updatedAt: 1 }
    const mine = { ...base, body: 'こちらの追記' }
    const theirs = { ...base, body: 'あちらの追記' }
    const r = mergeRemote('memos', base, mine, theirs, D)
    expect((r.record as typeof base).body).toBe(
      'あちらの追記\n\n――――（同期の競合: テスト端末で同時に書かれた内容）――――\nこちらの追記',
    )
    expect(r.joined).toEqual(['body'])
  })
  it('名前のような短い項目は、この端末を優先する', () => {
    const base = { id: 'm', name: '元', body: '', updatedAt: 1 }
    const mine = { ...base, name: 'こちら' }
    const theirs = { ...base, name: 'あちら' }
    const r = mergeRemote('memos', base, mine, theirs, D)
    expect((r.record as typeof base).name).toBe('こちら')
    expect(r.joined).toBeUndefined()
  })
  it('応募計画: 規定の備考・提出する梗概・特記事項はつなぎ、キャッチコピーと文字数の規定は短い項目（この端末を優先）', () => {
    const base = {
      id: 's',
      limitNote: '元',
      synopsis: '元',
      specialNotes: '元',
      catchphrase: '元',
      synopsisMax: 800,
      catchphraseMax: 40,
      updatedAt: 1,
    }
    const mine = {
      ...base,
      limitNote: 'こちらの備考',
      synopsis: 'こちらの梗概',
      specialNotes: 'こちらのメモ',
      catchphrase: 'こちら',
      synopsisMax: 600,
      catchphraseMax: 30,
    }
    const theirs = {
      ...base,
      limitNote: 'あちらの備考',
      synopsis: 'あちらの梗概',
      specialNotes: 'あちらのメモ',
      catchphrase: 'あちら',
      synopsisMax: 1000,
      catchphraseMax: 50,
    }
    const r = mergeRemote('submissions', base, mine, theirs, D)
    const rec = r.record as typeof base
    expect(r.joined).toEqual(['limitNote', 'synopsis', 'specialNotes'])
    expect(rec.synopsis).toBe('あちらの梗概\n\n――――（同期の競合: テスト端末で同時に書かれた内容）――――\nこちらの梗概')
    expect(rec.limitNote).toContain('あちらの備考')
    expect(rec.limitNote).toContain('こちらの備考')
    expect(rec.catchphrase).toBe('こちら')
    expect([rec.synopsisMax, rec.catchphraseMax]).toEqual([600, 30])
  })
  it('項目を知らない古い版の端末が応募計画を書き換えても、知らない項目はクラウドの内容のまま残る', () => {
    // 古い版の端末の控え（base）と内容（mine）には新しい項目が無い。クラウド（theirs）では別の端末が書いていた
    const base = { id: 's', overview: '元', updatedAt: 1 }
    const mine = { ...base, overview: '古い端末で書いた概要' }
    const theirs = { ...base, synopsis: '新しい端末で書いた梗概', synopsisMax: 800, updatedAt: 2 }
    const rec = mergeRemote('submissions', base, mine, theirs, D).record as typeof theirs & typeof mine
    expect(rec).toMatchObject({ overview: '古い端末で書いた概要', synopsis: '新しい端末で書いた梗概', synopsisMax: 800 })
  })
  it('同じ内容になっていれば、クラウドの内容そのもの（更新日時も）を使う', () => {
    const base = { id: 'm', body: '元', updatedAt: 1 }
    const theirs = { ...base, body: '同じ', updatedAt: 7 }
    const mine = { ...base, body: '同じ', updatedAt: 9 }
    expect(mergeRemote('memos', base, mine, theirs, D).record).toBe(theirs)
  })
})

describe('共通の履歴が無い時の、控えを作らない表の文章', () => {
  it('タイトルのあらすじ・全体戦略、章のメモはつないで残す', () => {
    const N = { device: 'iPhone', noHistory: true }
    const mine = { id: 'T', synopsis: '新しいあらすじ', strategyNote: '戦略', structure: [] }
    const theirs = { id: 'T', synopsis: '古いあらすじ', strategyNote: '', structure: [] }
    const r = mergeRemote('titles', null, mine, theirs, N)
    const rec = r.record as typeof mine
    expect(rec.synopsis).toContain('古いあらすじ')
    expect(rec.synopsis).toContain('新しいあらすじ')
    expect(rec.strategyNote).toBe('戦略')
    expect(r.joined).toEqual(['synopsis', 'strategyNote'])
    const ch = { id: 'c', note: 'この端末のメモ', pieceIds: [] }
    const cloudCh = { id: 'c', note: '', pieceIds: [] }
    expect((mergeRemote('chapters', null, ch, cloudCh, N).record as typeof ch).note).toBe('この端末のメモ')
  })
})

describe('幕（2.2）: 幕の構成を片方の端末だけが変えていた時の採用稿', () => {
  const E = { id: 'E', kind: 'episode', activeVersionId: 'EV', versionIds: ['EV'], subtitle: '', updatedAt: 1 }
  const A = { id: 'a1', kind: 'act', parentId: 'E', activeVersionId: 'v1', versionIds: ['v1'], updatedAt: 1 }

  it('話: 分けた側の採用稿を採り、もう一方が採用を変えていたら知らせる（ほかの項目は今までどおり）', () => {
    const split = { ...E, actIds: ['a1', 'a2'] }
    const adopted = { ...E, activeVersionId: 'EV2', versionIds: ['EV', 'EV2'], subtitle: 'この端末の題' }
    const r = mergeRemote('pieces', E, adopted, split, { ...D, acts: { structure: 'theirs' } })
    const rec = r.record as typeof split & typeof adopted
    expect(rec.activeVersionId).toBe('EV')
    expect(rec.actIds).toEqual(['a1', 'a2'])
    expect(rec.versionIds).toEqual(['EV', 'EV2'])
    expect(rec.subtitle).toBe('この端末の題')
    expect(r.overridden).toBe('mine')
    // この端末が分けた側: 別の端末の採用を採らない
    const r2 = mergeRemote('pieces', E, split, adopted, { ...D, acts: { structure: 'mine' } })
    expect((r2.record as typeof E).activeVersionId).toBe('EV')
    expect(r2.overridden).toBe('theirs')
    // 幕の構成と関係ない項目だけなら知らせない
    const titled = { ...E, subtitle: '題' }
    expect(mergeRemote('pieces', E, titled, split, { ...D, acts: { structure: 'theirs' } }).overridden).toBeUndefined()
  })

  it('幕: 両方が採用稿を別々に変えていたら、幕の構成を変えた側（つないだ稿・分けた稿）', () => {
    const joined = { ...A, activeVersionId: 'J', versionIds: ['v1', 'J'] }
    const other = { ...A, activeVersionId: 'v1b', versionIds: ['v1', 'v1b'] }
    const r = mergeRemote('pieces', A, other, joined, { ...D, acts: { structure: 'theirs' } })
    expect((r.record as typeof A).activeVersionId).toBe('J')
    expect((r.record as typeof A).versionIds).toEqual(['v1', 'J', 'v1b'])
    expect(r.overridden).toBe('mine')
    // 片方だけが変えていたら、その変更（知らせない）
    const added = { ...A, versionIds: ['v1', 'x'] }
    const r2 = mergeRemote('pieces', A, added, joined, { ...D, acts: { structure: 'mine' } })
    expect((r2.record as typeof A).activeVersionId).toBe('J')
    expect(r2.overridden).toBeUndefined()
  })

  it('幕の構成の指定が無ければ、今までどおり（短い項目はこの端末、幕の並びは要素ごと）', () => {
    const mine = { ...E, activeVersionId: 'EV2', actIds: ['a1', 'm'] }
    const theirs = { ...E, activeVersionId: 'EV3', actIds: ['t', 'a1'] }
    const base = { ...E, actIds: ['a1'] }
    const r = mergeRemote('pieces', base, mine, theirs, D)
    expect((r.record as typeof mine).activeVersionId).toBe('EV2')
    expect((r.record as typeof mine).actIds).toEqual(['t', 'a1', 'm'])
    expect(r.overridden).toBeUndefined()
  })
})

describe('2.3 の記録のマージ', () => {
  const idea = {
    id: 'r',
    titleId: 't',
    heading: '案',
    body: '元の案',
    checked: false,
    checkedAt: null,
    pieceIds: ['p1'],
    order: 0,
    updatedAt: 1,
  }
  it('改稿案: チェックなどの短い項目は項目ごとに合わせ（両方で変えたらこの端末）、本文が両方で変わればつなぐ', () => {
    const mine = { ...idea, checked: true, checkedAt: 5, body: '元の案。こちらで足した', updatedAt: 5 }
    const theirs = {
      ...idea,
      heading: '向こうの見出し',
      checked: false,
      body: '元の案。向こうで足した',
      pieceIds: ['p1', 'p2'],
      updatedAt: 6,
    }
    const r = mergeRemote('revisionIdeas', idea, mine, theirs, D)
    expect(r.record).toMatchObject({
      heading: '向こうの見出し',
      checked: true,
      checkedAt: 5,
      pieceIds: ['p1', 'p2'],
      updatedAt: 6,
    })
    expect((r.record as unknown as { body: string }).body).toContain('こちらで足した')
    expect((r.record as unknown as { body: string }).body).toContain('向こうで足した')
    expect(r.joined).toEqual(['body'])
  })
  it('改稿案を片方で削除・片方で編集したら、削除を優先し、編集された内容を控える。推敲案は短い項目だけ', () => {
    const edited = { ...idea, body: '編集' }
    expect(mergeRemote('revisionIdeas', idea, null, edited, D)).toEqual({ record: null, deletedEdit: edited })
    const s = { id: 's', titleId: 't', flagged: false, done: false, doneAt: null as number | null, updatedAt: 1 }
    const flagged = { ...s, flagged: true }
    const done = { ...s, done: true, doneAt: 3 }
    const r = mergeRemote('proofSuggestions', s, flagged, done, D)
    expect(r.record).toMatchObject({ flagged: true, done: true, doneAt: 3 })
  })
  it('戦略メモのコンテストの候補は候補ごとに合わせる（2台で別々に［応募計画にする］を押しても両方残る）', () => {
    const c = (id: string, submissionId: string | null) => ({ id, name: id, submissionId })
    const note = { id: 'n', titleId: 't', body: 'B', contests: [c('k0', null), c('k1', null)], appliedAt: null, updatedAt: 1 }
    const mine = { ...note, contests: [c('k0', 's1'), c('k1', null)], updatedAt: 2 }
    const theirs = { ...note, contests: [c('k0', null), c('k1', 's2')], appliedAt: 9, updatedAt: 3 }
    const r = mergeRemote('strategyNotes', note, mine, theirs, D)
    expect(r.record).toMatchObject({ contests: [c('k0', 's1'), c('k1', 's2')], appliedAt: 9 })
  })
})

describe('アイデアの済み（チェック）のマージ', () => {
  // 古い版のアイデア（済みの項目を持たない）
  const legacy = { id: 'i', titleId: null, heading: '見出し', body: '元の内容', order: 0, createdAt: 1, updatedAt: 1 }
  it('済みは短い項目として項目ごとに合わせる: 片方で済みにし、もう片方で内容を直しても両方残る', () => {
    // この端末では内容を直し（修復は済みの項目を足さないので、書くレコードにも無い）、別の端末では済みにした
    const mine = { ...legacy, body: '直した内容', updatedAt: 3 }
    const theirs = { ...legacy, checked: true, checkedAt: 2, updatedAt: 2 }
    const r = mergeRemote('ideas', legacy, mine, theirs, D)
    expect(r.record).toMatchObject({ body: '直した内容', checked: true, checkedAt: 2, updatedAt: 3 })
  })
  it('見出しを内容の1行目にまとめて保存しても、別の端末の済みは残る', () => {
    const mine = { ...legacy, heading: '', body: '見出し\n元の内容', updatedAt: 3 }
    const theirs = { ...legacy, checked: true, checkedAt: 2, updatedAt: 2 }
    const r = mergeRemote('ideas', legacy, mine, theirs, D)
    expect(r.record).toMatchObject({ heading: '', body: '見出し\n元の内容', checked: true, checkedAt: 2 })
  })
  it('見出しを内容にまとめて保存した時に、古い版の端末で直した見出しは消えない', () => {
    const base = { ...legacy, heading: 'H', body: 'B' }
    const mine = { ...base, heading: '', body: 'H\nB', updatedAt: 3 }
    const theirs = { ...base, heading: 'H2', updatedAt: 2 }
    expect(mergeRemote('ideas', base, mine, theirs, D).record).toMatchObject({ heading: 'H2', body: 'H\nB' })
    // 逆の向き（古い版の端末で合わせる）も見出しは残る（内容と重なるだけ）
    expect(mergeRemote('ideas', base, theirs, mine, D).record).toMatchObject({ heading: 'H2', body: 'H\nB' })
    // 両方が見出しを書いていたら、従来どおりこの端末
    const rewritten = { ...base, heading: 'H3' }
    expect(mergeRemote('ideas', base, rewritten, theirs, D).record).toMatchObject({ heading: 'H3' })
    // 相手が見出しを空にしていただけなら空のまま
    const cleared = { ...base, heading: '  ' }
    expect(mergeRemote('ideas', base, mine, cleared, D).record).toMatchObject({ heading: '' })
  })
  it('両方で済みを変えていたら、後から合わせる端末（この端末）を優先する', () => {
    const base = { ...legacy, checked: false, checkedAt: null }
    const mine = { ...base, checked: true, checkedAt: 5, updatedAt: 5 }
    const theirs = { ...base, checked: true, checkedAt: 4, updatedAt: 4 }
    expect(mergeRemote('ideas', base, mine, theirs, D).record).toMatchObject({ checked: true, checkedAt: 5 })
  })
})
