import { describe, expect, it } from 'vitest'
import { appendHeader, ideaEditedByAuthor, withIdeaAppend } from '../claude/ideaAppend'
import { hashJson } from '../domain/hash'
import type { Idea, IdeaAppend } from '../domain/types'
import { decodeRecord, encodeRecord, hashRecord, splitJson, type ChunkDoc, type RecordDoc } from './codec'
import { mergeIdeaBody } from './ideaMerge'
import {
  contentEqual,
  deepEqual,
  LIST_FIELDS,
  mergeFields,
  mergeList,
  mergeRecordLegacy,
  mergeRemote,
  NEWER_FIELDS,
  stableStringify,
  type MergeResult,
} from './merge'

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
  it('資料のタグはアプリと同じく refKey で照らす（全角と半角・空白だけ違う書き方は1つ。片方で外すと、もう一方の書き方も外れる）', () => {
    const m = { id: 'm1', name: '現代の特殊部隊', updatedAt: 1 }
    // 共通の版に無いタグを、2台が書き方を変えて付けた
    const mine = { ...m, tags: ['SF'], updatedAt: 2 }
    const theirs = { ...m, tags: ['ＳＦ'], updatedAt: 3 }
    expect((mergeFields('materials', m, mine, theirs, D).record as typeof mine).tags).toEqual(['SF'])
    // 2つの書き方が残っていても、この端末で外したら（同じタグなので）どちらも外れる
    const both = { ...m, tags: ['ＳＦ', 'SF', '現代'] }
    const removed = { ...both, tags: ['現代'], updatedAt: 4 }
    const other = { ...both, tags: ['ＳＦ', 'SF', '現代', '戦闘'], updatedAt: 5 }
    expect((mergeFields('materials', both, removed, other, D).record as typeof both).tags).toEqual(['現代', '戦闘'])
  })
  it('相対比較の作品のタグ（2.7）: 資料のタグと同じく refKey の並び。自動のタグを2台が別々に足しても両方残る', () => {
    expect(LIST_FIELDS.benchWorks).toEqual({ tags: expect.any(Function) })
    const w = { id: 'w1', name: '港の喫茶店', updatedAt: 1 }
    // 「SF」と「ＳＦ」は1つ
    const mine = { ...w, tags: ['SF'], updatedAt: 2 }
    const theirs = { ...w, tags: ['ＳＦ'], updatedAt: 3 }
    expect((mergeFields('benchWorks', w, mine, theirs, D).record as typeof mine).tags).toEqual(['SF'])
    // 片方で外すと、もう一方の書き方も外れる
    const both = { ...w, tags: ['ＳＦ', 'SF', '宇宙'] }
    const removed = { ...both, tags: ['宇宙'], updatedAt: 4 }
    const other = { ...both, tags: ['ＳＦ', 'SF', '宇宙', '軍事'], updatedAt: 5 }
    expect((mergeFields('benchWorks', both, removed, other, D).record as typeof both).tags).toEqual(['宇宙', '軍事'])
    // 2台が別々の 14 から自動のタグを足した
    const a = { ...w, tags: ['恋愛', '青春'], updatedAt: 6 }
    const b = { ...w, tags: ['恋愛', '家族'], updatedAt: 7 }
    expect((mergeFields('benchWorks', w, a, b, D).record as typeof a).tags).toEqual(['恋愛', '家族', '青春'])
  })
  it('自動のタグを取り込んだ印（autoTagsFrom）は、両方で変わっていたら新しい 14 の方（日付 → 作った時刻 → id）', () => {
    expect(Object.keys(NEWER_FIELDS.benchWorks ?? {})).toEqual(['autoTagsFrom'])
    const mark = (analysisId: string, runDate: string, createdAt: number) => ({ analysisId, runDate, createdAt })
    const w = { id: 'w1', name: '作品', autoTagsFrom: mark('n0', '2026-10-01', 1), updatedAt: 1 }
    const older = { ...w, autoTagsFrom: mark('n1', '2026-11-01', 9), updatedAt: 5 }
    const newer = { ...w, autoTagsFrom: mark('n2', '2026-11-02', 2), updatedAt: 3 }
    // この端末が古い方を持っていても、クラウドの新しい方を採る（逆も）
    expect((mergeFields('benchWorks', w, older, newer, D).record as typeof w).autoTagsFrom).toEqual(newer.autoTagsFrom)
    expect((mergeFields('benchWorks', w, newer, older, D).record as typeof w).autoTagsFrom).toEqual(newer.autoTagsFrom)
    // 同じ日なら作った時刻の新しい方
    const later = { ...w, autoTagsFrom: mark('n3', '2026-11-01', 10), updatedAt: 2 }
    expect((mergeFields('benchWorks', w, older, later, D).record as typeof w).autoTagsFrom).toEqual(later.autoTagsFrom)
    // 形の違う値より、読める値
    const broken = { ...w, autoTagsFrom: 'x' as unknown as ReturnType<typeof mark>, updatedAt: 9 }
    expect((mergeFields('benchWorks', w, broken, older, D).record as typeof w).autoTagsFrom).toEqual(older.autoTagsFrom)
    // 片方の端末だけが変えた時は今までどおり（その端末の値。古い値でも）
    expect((mergeFields('benchWorks', newer, older, newer, D).record as typeof w).autoTagsFrom).toEqual(older.autoTagsFrom)
    // 共通の履歴が無い時も新しい方
    const N = { device: 'iPhone', noHistory: true }
    expect((mergeRemote('benchWorks', null, newer, older, N).record as typeof w).autoTagsFrom).toEqual(newer.autoTagsFrom)
    expect((mergeRemote('benchWorks', null, older, newer, N).record as typeof w).autoTagsFrom).toEqual(newer.autoTagsFrom)
    const { autoTagsFrom: _, ...plain } = w
    expect((mergeRemote('benchWorks', null, newer, plain, N).record as typeof w).autoTagsFrom).toEqual(newer.autoTagsFrom)
    expect('autoTagsFrom' in (mergeRemote('benchWorks', null, plain, newer, N).record as object)).toBe(true)
  })
  describe('2台が同じ 14 を別々に取り込んでいた時の作品のタグ（autoTagsFrom.added。2.7）', () => {
    const mark = (analysisId: string, runDate: string, createdAt: number, added?: string[]) => ({
      analysisId,
      runDate,
      createdAt,
      ...(added ? { added } : {}),
    })
    const M1 = mark('n1', '2026-11-01', 1, ['恋愛'])
    const M2 = mark('n2', '2026-11-05', 2, ['青春'])
    const M3 = mark('n3', '2026-11-08', 3, ['手紙'])
    const w = { id: 'w1', name: '港の喫茶店', updatedAt: 1 }
    type W = typeof w & { tags?: string[]; autoTagsFrom?: ReturnType<typeof mark>; note?: string }
    const tagsOf = (r: MergeResult) => (r.record as W).tags

    it('遅れて送った端末の取り込みで、もう一方の端末で外したタグが戻らない。この端末で手で付けたタグは残る', () => {
      // 共通の版は新しい 14（M2）の前。両方が M2 から「青春」を足し、クラウド側ではその後に作者が「青春」を外した
      const base: W = { ...w, tags: ['恋愛'], autoTagsFrom: M1 }
      const mine: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: M2, updatedAt: 2 }
      const theirs: W = { ...w, tags: ['恋愛'], autoTagsFrom: M2, updatedAt: 3 }
      const r = mergeRemote('benchWorks', base, mine, theirs, D)
      expect(tagsOf(r)).toEqual(['恋愛'])
      expect((r.record as W).autoTagsFrom).toEqual(M2)
      // この端末で手で「港町」を付けていた（added に無い）
      const manual: W = { ...mine, tags: ['恋愛', '港町', '青春'] }
      expect(tagsOf(mergeRemote('benchWorks', base, manual, theirs, D))).toEqual(['恋愛', '港町'])
      // 相手が手で付けたタグも残る
      const theirsManual: W = { ...theirs, tags: ['恋愛', '手紙'] }
      expect(tagsOf(mergeRemote('benchWorks', base, mine, theirsManual, D))).toEqual(['恋愛', '手紙'])
      // 外さずに両方が取り込んだだけなら、そのまま
      expect(tagsOf(mergeRemote('benchWorks', base, mine, { ...mine, updatedAt: 4 }, D))).toEqual(['恋愛', '青春'])
    })

    it('この端末の方で外していて、もう一方の端末の取り込みが先に届いても戻らない（どちらの端末で合わせても同じ）', () => {
      const base: W = { ...w, tags: ['恋愛'], autoTagsFrom: M1 }
      const removedHere: W = { ...w, tags: ['恋愛'], autoTagsFrom: M2, updatedAt: 3 }
      const importedThere: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: M2, updatedAt: 2 }
      expect(tagsOf(mergeRemote('benchWorks', base, removedHere, importedThere, D))).toEqual(['恋愛'])
      // タグを全部外した（項目ごと無い）時も
      const b0: W = { ...w, autoTagsFrom: M1 }
      const none: W = { ...w, autoTagsFrom: mark('n2', '2026-11-05', 2, ['青春']), updatedAt: 3 }
      const there: W = { ...w, tags: ['青春'], autoTagsFrom: M2, updatedAt: 2 }
      const r = mergeRemote('benchWorks', b0, none, there, D)
      expect('tags' in (r.record as object)).toBe(false)
    })

    it('足した語の無い印（2.7.0 の端末）・別々の 14 の取り込み・共通の版がもう同じ 14 の時は今までどおり', () => {
      const base: W = { ...w, tags: ['恋愛'], autoTagsFrom: mark('n1', '2026-11-01', 1) }
      const old2 = mark('n2', '2026-11-05', 2)
      const mine: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: old2, updatedAt: 2 }
      const theirs: W = { ...w, tags: ['恋愛'], autoTagsFrom: old2, updatedAt: 3 }
      expect(tagsOf(mergeRemote('benchWorks', base, mine, theirs, D))).toEqual(['恋愛', '青春'])
      // 別々の 14（この端末は M2、相手は M3）から足した語は両方残る
      const mine2: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: M2, updatedAt: 2 }
      const theirs3: W = { ...w, tags: ['恋愛', '手紙'], autoTagsFrom: M3, updatedAt: 3 }
      const base1: W = { ...base, autoTagsFrom: M1 }
      const r = mergeRemote('benchWorks', base1, mine2, theirs3, D)
      expect(tagsOf(r)).toEqual(['恋愛', '手紙', '青春'])
      expect((r.record as W).autoTagsFrom).toEqual(M3)
      // 共通の版がもう M2（取り込みは揃っている）: この端末で手で付け直した「青春」は残る
      const synced: W = { ...w, tags: ['恋愛'], autoTagsFrom: M2 }
      const readded: W = { ...synced, tags: ['恋愛', '青春'], updatedAt: 2 }
      const noted: W = { ...synced, note: 'メモ', updatedAt: 3 }
      expect(tagsOf(mergeRemote('benchWorks', synced, readded, noted, D))).toEqual(['恋愛', '青春'])
    })

    it('同じ 14 の印が足した語だけ違う時は、どちらの端末で合わせても同じ印になる', () => {
      const base: W = { ...w, tags: ['恋愛'], autoTagsFrom: M1 }
      const a: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: mark('n2', '2026-11-05', 2, ['青春']), updatedAt: 2 }
      const b: W = { ...w, tags: ['恋愛', '港町', '青春'], autoTagsFrom: mark('n2', '2026-11-05', 2, []), updatedAt: 3 }
      const ab = mergeFields('benchWorks', base, a, b, D).record as W
      const ba = mergeFields('benchWorks', base, b, a, D).record as W
      expect(ab.autoTagsFrom).toEqual(ba.autoTagsFrom)
      expect(ab.autoTagsFrom?.analysisId).toBe('n2')
      // 足した語の無い印（2.7.0）とも
      const c: W = { ...a, autoTagsFrom: mark('n2', '2026-11-05', 2) }
      expect((mergeFields('benchWorks', base, a, c, D).record as W).autoTagsFrom).toEqual(
        (mergeFields('benchWorks', base, c, a, D).record as W).autoTagsFrom,
      )
    })

    it('共通の履歴が無い時: クラウドがもう同じ 14（かもっと新しい 14）を取り込んでいたら、この端末が自動で足した語は足さない', () => {
      const N = { device: 'iPhone', noHistory: true }
      // クラウドでは作者が「青春」を外している。この端末は復元したデータで同じ 14 から付けた（手で付けた「港町」もある）
      const cloud: W = { ...w, tags: ['恋愛'], autoTagsFrom: mark('n1', '2026-11-01', 1), updatedAt: 5 }
      const local: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: mark('n1', '2026-11-01', 1, ['恋愛', '青春']), updatedAt: 6 }
      const r = mergeRemote('benchWorks', null, local, cloud, N)
      expect(tagsOf(r)).toEqual(['恋愛'])
      expect((r.record as W).autoTagsFrom?.analysisId).toBe('n1')
      // 自動のタグと印だけの違いは、ゴミ箱に控えない
      expect(r.keptCopy).toBeUndefined()
      const manual: W = { ...local, tags: ['恋愛', '港町', '青春'] }
      expect(tagsOf(mergeRemote('benchWorks', null, manual, cloud, N))).toEqual(['恋愛', '港町'])
      // ほかの項目が違えば今までどおり控える
      const localNote: W = { ...local, note: 'この端末のメモ' }
      expect(mergeRemote('benchWorks', null, localNote, cloud, N).keptCopy).toBeDefined()
      // クラウドにタグが無ければ項目を作らない
      const bare: W = { ...cloud }
      delete bare.tags
      expect('tags' in (mergeRemote('benchWorks', null, local, bare, N).record as object)).toBe(false)
      // クラウドがもっと新しい 14 を取り込んでいた: 古い 14 から足した語は足さない
      const newerCloud: W = { ...cloud, tags: ['恋愛', '手紙'], autoTagsFrom: M3 }
      const r2 = mergeRemote('benchWorks', null, local, newerCloud, N)
      expect(tagsOf(r2)).toEqual(['恋愛', '手紙'])
      expect((r2.record as W).autoTagsFrom?.analysisId).toBe('n3')
    })

    it('共通の履歴が無い時: この端末の方が新しい 14・クラウドに印が無い・足した語の無い印は今までどおり（両方のタグ）', () => {
      const N = { device: 'iPhone', noHistory: true }
      const cloud: W = { ...w, tags: ['恋愛'], autoTagsFrom: mark('n1', '2026-11-01', 1), updatedAt: 5 }
      const newerLocal: W = { ...w, tags: ['恋愛', '手紙'], autoTagsFrom: M3, updatedAt: 6 }
      const r = mergeRemote('benchWorks', null, newerLocal, cloud, N)
      expect(tagsOf(r)).toEqual(['恋愛', '手紙'])
      expect((r.record as W).autoTagsFrom?.analysisId).toBe('n3')
      const unmarked: W = { ...w, tags: ['恋愛'], updatedAt: 5 }
      expect(tagsOf(mergeRemote('benchWorks', null, newerLocal, unmarked, N))).toEqual(['恋愛', '手紙'])
      const oldLocal: W = { ...w, tags: ['恋愛', '青春'], autoTagsFrom: mark('n1', '2026-11-01', 1), updatedAt: 6 }
      expect(tagsOf(mergeRemote('benchWorks', null, oldLocal, cloud, N))).toEqual(['恋愛', '青春'])
    })
  })
  it('構成の並びは要素ごとに合わせる', () => {
    const mine = { ...base, structure: [...base.structure, { type: 'piece', id: 'm' }] }
    const theirs = { ...base, structure: [{ type: 'piece', id: 't' }, ...base.structure] }
    const r = mergeFields('titles', base, mine, theirs, D).record as typeof base
    expect(r.structure.map((n) => n.id)).toEqual(['t', 'p1', 'm'])
  })
  it('縦書きのページ表示の字数×行数は2つの値をまとめて1つの短い項目として合わせる（字数と行数が混ざらない）', () => {
    const t = { ...base, pageSetup: { chars: 40, lines: 32 } }
    const mine = { ...t, pageSetup: { chars: 20, lines: 20 } }
    const theirs = { ...t, pageSetup: { chars: 40, lines: 40 }, name: 'あちら' }
    const r = mergeFields('titles', t, mine, theirs, D).record as typeof t
    expect(r.pageSetup).toEqual({ chars: 20, lines: 20 })
    expect(r.name).toBe('あちら')
    // 片方だけが変えたらその値。この端末で既定に戻した（項目を消した）時は消える
    expect((mergeFields('titles', t, t, theirs, D).record as typeof t).pageSetup).toEqual({ chars: 40, lines: 40 })
    const cleared: Partial<typeof t> = { ...t }
    delete cleared.pageSetup
    const renamed = { ...t, name: 'あちら' }
    expect('pageSetup' in mergeFields('titles', t, cleared as typeof t, renamed, D).record).toBe(false)
    // 字数×行数を決める前の内容から、別の端末が名前だけを変えても、クラウドの字数×行数は残る
    const old: Partial<typeof t> = { ...base, name: '古い端末' }
    expect((mergeFields('titles', base, old as typeof t, t, D).record as typeof t).pageSetup).toEqual({ chars: 40, lines: 32 })
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

describe('アイデアへの Claude の追記（2.8）のマージ', () => {
  /** 2026/11/13 10:00（日本時間）・11/14・11/15 に作った追記の依頼 */
  const DAY13 = Date.UTC(2026, 10, 13, 1, 0, 0)
  const req = (id: string, text: string, createdAt = DAY13): IdeaAppend => ({
    id,
    ideaId: 'cy-abc',
    text,
    readMark: 'abcd1234',
    source: 'claude',
    v: 1,
    createdAt,
    updatedAt: createdAt,
  })
  const X = req('cu-x', '【動機】\n・兄との約束に変える')
  const Y = req('cu-y', '【結末】\n・兄は見つからない', DAY13 + 86_400_000)
  const Z = req('cu-z', '【舞台】\n・港町に変える', DAY13 + 2 * 86_400_000)
  /** 足した部分（空行と追記の行と内容） */
  const blockOf = (r: IdeaAppend) => `\n\n${appendHeader(r.createdAt)}\n${r.text}`
  const BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
  /** Claude が作り、作者が直していないアイデア（同期の共通の版） */
  const base: Idea = {
    id: 'cy-abc',
    titleId: null,
    heading: '',
    body: BODY,
    checked: false,
    checkedAt: null,
    order: 0,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(BODY),
    createdAt: 1,
    updatedAt: 1,
  }
  /** アプリが依頼を当てた（順に） */
  const applied = (idea: Idea, ...reqs: IdeaAppend[]): Idea =>
    reqs.reduce((i, r) => ({ ...withIdeaAppend(i, r), updatedAt: i.updatedAt + 1 }), idea)
  /** 作者がアプリで直した（指紋は変えない） */
  const edited = (idea: Idea, body: string): Idea => ({ ...idea, body, updatedAt: idea.updatedAt + 1 })
  const merged = (mine: Idea, theirs: Idea, b: Idea = base) => mergeRemote('ideas', b, mine, theirs, D)
  const bodyOf = (r: MergeResult) => (r.record as Idea).body
  const count = (s: string, sub: string) => s.split(sub).length - 1
  const AUTHOR_LINE = '\n・作者が足した行'
  const AUTHOR_HEAD = '2026/11/12 14:32　第3章の動機（作者が直した）'
  const authorBody = BODY.replace('2026/11/12 14:32　第3章の動機', AUTHOR_HEAD)

  it('追記の依頼の id は並びとして合わせる（2台が別々の依頼を当てても両方残る）', () => {
    expect(LIST_FIELDS.ideas).toEqual({ appendIds: expect.any(Function) })
    const r = merged(applied(base, Y), applied(base, X))
    expect([...((r.record as Idea).appendIds ?? [])].sort()).toEqual(['cu-x', 'cu-y'])
  })

  it('(a) 相手が足しただけで、この端末にもその依頼と足した部分がある: この端末の本文（作者の直しと追記1回）', () => {
    const theirs = applied(base, X)
    // この端末も同じ依頼を当て、その後に作者が終わりに行を足した
    const mineTail = edited(applied(base, X), applied(base, X).body + AUTHOR_LINE)
    const r1 = merged(mineTail, theirs)
    expect(bodyOf(r1)).toBe(BODY + blockOf(X) + AUTHOR_LINE)
    expect(r1.joined).toBeUndefined()
    // この端末も同じ依頼を当て、その後に作者が元の本文を直した（足した形ではない）
    const mineHead = edited(applied(base, X), authorBody + blockOf(X))
    const r2 = merged(mineHead, theirs)
    expect(bodyOf(r2)).toBe(authorBody + blockOf(X))
    expect(count(bodyOf(r2), appendHeader(X.createdAt))).toBe(1)
    // 作者が直したまま
    expect(ideaEditedByAuthor(r1.record as Idea)).toBe(true)
    expect(ideaEditedByAuthor(r2.record as Idea)).toBe(true)
  })

  it('(b) この端末が足しただけで、相手にもその依頼と足した部分がある: 相手の本文', () => {
    const mine = applied(base, X)
    const theirs = edited(applied(base, X), authorBody + blockOf(X) + AUTHOR_LINE)
    const r = merged(mine, theirs)
    expect(bodyOf(r)).toBe(authorBody + blockOf(X) + AUTHOR_LINE)
    expect(r.joined).toBeUndefined()
    expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
    // 相手が続けて別の依頼も当てていた（作者は直していない）: 相手の本文で、直していないまま
    const r2 = merged(applied(base, X), applied(base, X, Y))
    expect(bodyOf(r2)).toBe(BODY + blockOf(X) + blockOf(Y))
    expect((r2.record as Idea).appendIds).toEqual(['cu-x', 'cu-y'])
    expect(ideaEditedByAuthor(r2.record as Idea)).toBe(false)
  })

  it('(c) 両方が足しただけで、片方の足した部分がもう片方の続き: 長い方（別の id の依頼が同じ内容を足していても1回）', () => {
    const X2 = { ...X, id: 'cu-x2' }
    const mine = applied(base, X)
    const theirs = applied(base, X2, Y)
    const r = merged(mine, theirs)
    expect(bodyOf(r)).toBe(BODY + blockOf(X) + blockOf(Y))
    expect(count(bodyOf(r), appendHeader(X.createdAt))).toBe(1)
    expect(ideaEditedByAuthor(r.record as Idea)).toBe(false)
    const back = merged(theirs, mine)
    expect(bodyOf(back)).toBe(BODY + blockOf(X) + blockOf(Y))
    expect(ideaEditedByAuthor(back.record as Idea)).toBe(false)
    // 共通の版の本文が空（追記の行が本文の初めにある）でも同じ
    const empty = { ...base, body: '', claudeHash: hashJson('') }
    const r2 = merged(applied(empty, X), applied(empty, X2, Y), empty)
    expect(bodyOf(r2)).toBe(applied(empty, X2, Y).body)
    expect(r2.joined).toBeUndefined()
  })

  it('(c) 短い方で作者が足した部分を消していたら、長い方を採らずにつなぐ（長い方で別の追記を消していても、消した追記を黙って戻さない）', () => {
    const marker = '――――（同期の競合: テスト端末で同時に書かれた内容）――――'
    // この端末は X・Y を当て、作者が Y の追記を消した。相手は X・Y・Z を当て、作者が Z の追記を消した（相手の本文 = この端末の本文 + Y の追記）
    const mine = edited(applied(base, X, Y), BODY + blockOf(X))
    const theirs = edited(applied(base, X, Y, Z), BODY + blockOf(X) + blockOf(Y))
    for (const [m, t] of [
      [mine, theirs],
      [theirs, mine],
    ]) {
      const r = merged(m, t)
      expect(r.joined).toEqual(['body'])
      expect(bodyOf(r)).toBe(`${t.body}\n\n${marker}\n${m.body}`)
      expect([...((r.record as Idea).appendIds ?? [])].sort()).toEqual(['cu-x', 'cu-y', 'cu-z'])
      expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
    }
  })

  it('(d)(e) 片方が足しただけで、もう片方は作者が直した: 作者の直しの後ろに追記を1回（どちらの端末で合わせても同じ）', () => {
    const appendedSide = applied(base, X)
    const authorSide = edited(base, authorBody + AUTHOR_LINE + '\n\n')
    for (const r of [merged(authorSide, appendedSide), merged(appendedSide, authorSide)]) {
      expect(bodyOf(r)).toBe(authorBody + AUTHOR_LINE + blockOf(X))
      expect(count(bodyOf(r), appendHeader(X.createdAt))).toBe(1)
      expect(count(bodyOf(r), '【動機】\n・兄を探す')).toBe(1)
      expect(r.joined).toBeUndefined()
      expect((r.record as Idea).appendIds).toEqual(['cu-x'])
      // 作者が直したもの（指紋はどちらの本文とも合わない）
      expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
    }
    // 作者が本文を空にしていたら、追記だけ
    const cleared = edited(base, '')
    expect(bodyOf(merged(cleared, appendedSide))).toBe(blockOf(X).replace(/^\n+/, ''))
  })

  it('(d) 2台が別々の依頼を当てた: 両方の追記を1回ずつ', () => {
    const r = merged(applied(base, Y), applied(base, X))
    expect(bodyOf(r)).toBe(BODY + blockOf(Y) + blockOf(X))
    expect(count(bodyOf(r), appendHeader(X.createdAt))).toBe(1)
    expect(count(bodyOf(r), appendHeader(Y.createdAt))).toBe(1)
    expect(r.joined).toBeUndefined()
  })

  it('当てはまらない形は今までどおり両方をつなぐ（何も失わない）', () => {
    const marker = '――――（同期の競合: テスト端末で同時に書かれた内容）――――'
    // 両方の端末が同じ依頼を当て、どちらでも作者が直した（相手は足した部分の中を直し、この端末は終わりに行を足した）
    const editedTail = edited(applied(base, X), BODY + blockOf(X).replace('兄との約束', '姉との約束'))
    const mineTail = edited(applied(base, X), applied(base, X).body + AUTHOR_LINE)
    const r1 = merged(mineTail, editedTail)
    expect(r1.joined).toEqual(['body'])
    expect(bodyOf(r1)).toBe(`${editedTail.body}\n\n${marker}\n${mineTail.body}`)
    // 同じ依頼を含むが、その先が違う
    const r2 = merged(applied(base, X, Z), applied(base, X, Y))
    expect(r2.joined).toEqual(['body'])
    expect(bodyOf(r2)).toContain(blockOf(Y))
    expect(bodyOf(r2)).toContain(blockOf(Z))
    // 共通の版の本文が空
    const empty = { ...base, body: '', claudeHash: hashJson('') }
    const r3 = merged(applied(empty, X), edited(empty, '作者の案'), empty)
    expect(r3.joined).toEqual(['body'])
    expect(bodyOf(r3)).toContain('作者の案')
    expect(bodyOf(r3)).toContain(appendHeader(X.createdAt))
    // まとめた本文ではないので、作者が直したもの
    for (const r of [r1, r2, r3]) expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
    // 作者のアイデア（追記の依頼の id が無い）は今までどおりつなぐ
    const author = { ...base, id: '3f2a9c1b', source: undefined, claudeHash: undefined, body: '作者の案' }
    const here = { ...author, body: 'こちら' }
    const there = { ...author, body: 'あちら' }
    const r4 = mergeRemote('ideas', author, here, there, D)
    expect(bodyOf(r4)).toBe(`あちら\n\n${marker}\nこちら`)
    expect(mergeIdeaBody(author, here, there)).toBeNull()
  })

  describe('両方の端末が同じ依頼を当てた後、片方で作者が足した部分を直した（同期の後に送った端末の書き込みが競合した）', () => {
    /** 終わりの箇条書きを消せる依頼（「・最後の一行」） */
    const W = req('cu-w', '【動機】\n・兄との約束に変える\n・最後の一行')
    const full = applied(base, W)
    /** 足した部分の終わりの行を消した */
    const trimmed = edited(full, full.body.replace('\n・最後の一行', ''))
    /** 足した部分をまるごと消した（本文は共通の版と同じ） */
    const removed = edited(full, BODY)
    /** 足した部分の中を直した */
    const rewritten = edited(full, full.body.replace('兄との約束', '姉との約束'))

    it.each([
      ['終わりの行を消した', trimmed],
      ['足した部分をまるごと消した', removed],
      ['足した部分の中を直した', rewritten],
    ])('%s: どちらの端末で合わせても直した側の本文で、「作者が直した」のまま', (_, editedSide) => {
      for (const r of [merged(full, editedSide), merged(editedSide, full)]) {
        expect(bodyOf(r)).toBe(editedSide.body)
        expect(r.joined).toBeUndefined()
        expect((r.record as Idea).appendIds).toEqual(['cu-w'])
        expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
      }
    })

    it('片方が続けて別の依頼も当てていたら、終わりを消した本文の後ろには足さずにつなぐ（消した行を黙って戻さない）', () => {
      const more = applied(base, W, Y)
      const marker = '――――（同期の競合: テスト端末で同時に書かれた内容）――――'
      for (const editedSide of [trimmed, removed]) {
        const here = merged(editedSide, more)
        expect(here.joined).toEqual(['body'])
        expect(bodyOf(here)).toBe(`${more.body}\n\n${marker}\n${editedSide.body}`)
        const there = merged(more, editedSide)
        expect(there.joined).toEqual(['body'])
        expect(bodyOf(there)).toBe(`${editedSide.body}\n\n${marker}\n${more.body}`)
        for (const r of [here, there]) {
          expect((r.record as Idea).appendIds).toEqual(['cu-w', 'cu-y'])
          expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
        }
      }
      // 別々の依頼だけを当てていた（消した側の依頼を相手は知らない）: 今までどおり相手の本文で、「作者が直した」
      const other = merged(removed, applied(base, Y))
      expect(bodyOf(other)).toBe(BODY + blockOf(Y))
      expect(ideaEditedByAuthor(other.record as Idea)).toBe(true)
      // 足した部分をまるごと消した側の方が多く当てていた（相手は直していない）: 消した側の本文
      const removedMore = edited(more, BODY)
      for (const r of [merged(removedMore, full), merged(full, removedMore)]) {
        expect(bodyOf(r)).toBe(BODY)
        expect(r.joined).toBeUndefined()
        expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
      }
      // 直していない方が続けて当てていた（もう片方は直していない）: 長い方
      expect(bodyOf(merged(full, more))).toBe(more.body)
      expect(bodyOf(merged(more, full))).toBe(more.body)
    })

    it('この端末で作者が直してから同じ依頼を当てた（指紋は直す前のまま）: この端末の本文', () => {
      const mine = applied(edited(base, authorBody), W)
      expect(mine.claudeHash).toBe(base.claudeHash)
      for (const r of [merged(mine, full), merged(full, mine)]) {
        expect(bodyOf(r)).toBe(authorBody + blockOf(W))
        expect(r.joined).toBeUndefined()
        expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
      }
    })

    it('共通の版がもう直してあった（指紋で見分けられない）: 同じ依頼なら両方をつなぐ。片方が終わりに追記を足しただけなら長い方', () => {
      const authored = edited(base, authorBody)
      const both = applied(authored, W)
      const cut = edited(both, both.body.replace('\n・最後の一行', ''))
      for (const r of [merged(both, cut, authored), merged(cut, both, authored)]) {
        expect(r.joined).toEqual(['body'])
        expect(bodyOf(r)).toContain(cut.body)
        expect(bodyOf(r)).toContain(both.body)
      }
      // 片方が足した部分をまるごと消した（本文は共通の版と同じ）: 片方だけの変更として採らずにつなぐ
      const gone = edited(both, authorBody)
      const r2 = merged(gone, both, authored)
      expect(r2.joined).toEqual(['body'])
      expect(bodyOf(r2)).toBe(`${both.body}\n\n――――（同期の競合: テスト端末で同時に書かれた内容）――――\n${authorBody}`)
      // 片方が続けて別の依頼も当てた（本文は、もう片方の本文の終わりに追記を1件足しただけ）
      const longer = applied(authored, W, Y)
      for (const r of [merged(both, longer, authored), merged(longer, both, authored)]) {
        expect(bodyOf(r)).toBe(authorBody + blockOf(W) + blockOf(Y))
        expect(r.joined).toBeUndefined()
      }
      // 終わりを消した側（短い方）の後ろに、相手は続けて当てていた: 追記の行の数が合わないのでつなぐ
      expect(merged(cut, longer, authored).joined).toEqual(['body'])
    })

    it('共通の版がもう直してあった: 片方で足した部分の外（初めの行・元の本文の途中）を直したら、どちらの端末で合わせても直した側の本文', () => {
      const authored = edited(base, authorBody)
      const both = applied(authored, W)
      const head = edited(both, both.body.replace('第3章', '第4章'))
      const mid = edited(both, both.body.replace('・兄を探す', '・港で兄を探す'))
      for (const editedSide of [head, mid]) {
        for (const r of [merged(both, editedSide, authored), merged(editedSide, both, authored)]) {
          expect(bodyOf(r)).toBe(editedSide.body)
          expect(r.joined).toBeUndefined()
          expect((r.record as Idea).appendIds).toEqual(['cu-w'])
          expect(count(bodyOf(r), appendHeader(W.createdAt))).toBe(1)
          expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
        }
      }
      // 直した側が続けて別の依頼も当てていた: 直した側の本文
      const headMore = applied(head, Y)
      for (const r of [merged(both, headMore, authored), merged(headMore, both, authored)]) {
        expect(bodyOf(r)).toBe(authorBody.replace('第3章', '第4章') + blockOf(W) + blockOf(Y))
        expect(r.joined).toBeUndefined()
        expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
      }
      // 足した部分の終わりに作者が行を足した（もう片方が終わりの行を消したのと見分けられない）・終わりを消した側と初めの行を直した側: つなぐ
      const cut = edited(both, both.body.replace('\n・最後の一行', ''))
      const tail = edited(both, both.body + AUTHOR_LINE)
      for (const [x, y] of [
        [both, tail],
        [cut, head],
        [cut, headMore],
      ]) {
        for (const r of [merged(x, y, authored), merged(y, x, authored)]) {
          expect(r.joined).toEqual(['body'])
          expect(bodyOf(r)).toContain(x.body)
          expect(bodyOf(r)).toContain(y.body)
          expect(ideaEditedByAuthor(r.record as Idea)).toBe(true)
        }
      }
    })
  })

  it('指紋（claudeHash）は採った本文の側のもの。済みだけを変えた端末と追記した端末では、追記した側の指紋', () => {
    // 項目ごとに合わせると、両方で変わった指紋はこの端末の方になるが、採った本文は相手の方
    const r = merged(applied(base, X), applied(base, X, Y))
    expect((r.record as Idea).claudeHash).toBe(hashJson(BODY + blockOf(X) + blockOf(Y)))
    const checkedOnly = { ...base, checked: true, checkedAt: 5, updatedAt: 5 }
    const r2 = merged(checkedOnly, applied(base, X))
    expect(r2.record).toMatchObject({ body: BODY + blockOf(X), checked: true, checkedAt: 5 })
    expect((r2.record as Idea).claudeHash).toBe(hashJson(BODY + blockOf(X)))
    expect(ideaEditedByAuthor(r2.record as Idea)).toBe(false)
    const r3 = merged(applied(base, X), checkedOnly)
    expect(ideaEditedByAuthor(r3.record as Idea)).toBe(false)
    // 指紋の無い側の本文を採ったら、指紋は無い
    const noHash = { ...applied(base, X, Y), claudeHash: undefined }
    const r4 = merged(applied(base, X), noHash)
    expect(bodyOf(r4)).toBe(noHash.body)
    expect('claudeHash' in (r4.record as Idea)).toBe(false)
  })

  it('別のタブの保存（mergeRecordLegacy に表を渡す）も同じまとめ方', () => {
    const authorSide = edited(base, authorBody)
    const r = mergeRecordLegacy(base, authorSide, applied(base, X), 'ideas') as Idea
    expect(r.body).toBe(authorBody + blockOf(X))
    expect(r.appendIds).toEqual(['cu-x'])
    expect(ideaEditedByAuthor(r)).toBe(true)
  })

  it('共通の履歴が無い時は、追記の依頼の id もクラウドの値のまま（本文と組。この端末の内容は控える）', () => {
    const N = { device: 'iPhone', noHistory: true }
    const mine = applied(base, X)
    const r = mergeRemote('ideas', null, mine, base, N)
    expect(r.record).toEqual(base)
    expect(r.keptCopy).toEqual(mine)
    const r2 = mergeRemote('ideas', null, mine, applied(base, Y), N)
    expect((r2.record as Idea).appendIds).toEqual(['cu-y'])
    expect(bodyOf(r2)).toBe(BODY + blockOf(Y))
  })
})
