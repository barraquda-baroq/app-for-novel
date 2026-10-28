import { describe, expect, it } from 'vitest'
import { joinActWithNext, unseparatePiece } from '../domain/acts'
import { parseRuby, stripRuby, stripRubyMap } from '../domain/ruby'
import { updateVersion } from '../domain/storyOps'
import { novel, splitEpisode } from '../test/claudeFixture'
import { adoptedSegments, locateExcerpt, paragraphAt, reanchor, safeSlice } from './anchor'

describe('stripRubyMap（記法を除いた本文と元の位置の対応）', () => {
  const samples = [
    '',
    '地の文だけ',
    '｜漢字《かんじ》と傍点《《強調》》',
    '東京《とうきょう》へ行く',
    '|半角《はんかく》の縦棒',
    '｜《そのまま》',
    '《《閉じていない',
    '漢字《かんじ\n》改行をまたぐ',
    '𠮷野家《よしのや》の𠮷',
    '前｜漢字《かん》後《《点》》終',
  ]
  it('stripRuby と同じ本文になり、各文字は元の本文の範囲を指す', () => {
    for (const s of samples) {
      const m = stripRubyMap(s)
      expect(m.text).toBe(stripRuby(s))
      expect(m.start.length).toBe(m.text.length)
      for (let i = 0; i < m.text.length; i++) {
        expect(m.start[i]).toBeLessThan(m.end[i])
        expect(m.end[i]).toBeLessThanOrEqual(s.length)
      }
    }
  })
  it('ルビの親文字は記法全体を指す', () => {
    const s = '前｜漢字《かんじ》後'
    const m = stripRubyMap(s)
    expect(m.text).toBe('前漢字後')
    expect([m.start[1], m.end[1]]).toEqual([1, s.indexOf('後')])
    expect(parseRuby(s)).toHaveLength(3)
  })
})

describe('safeSlice・paragraphAt', () => {
  it('サロゲートペアの途中で切らない', () => {
    const s = 'a𠮷b'
    expect(safeSlice(s, 2, 4)).toBe('b')
    expect(safeSlice(s, 0, 2)).toBe('a')
    expect(safeSlice(s, 1, 3)).toBe('𠮷')
  })
  it('段落は空行を数えない', () => {
    const s = '一段落\n\n二段落\r\n三段落'
    expect(paragraphAt(s, 0)).toBe(1)
    expect(paragraphAt(s, s.indexOf('二'))).toBe(2)
    expect(paragraphAt(s, s.indexOf('三'))).toBe(3)
  })
})

describe('locateExcerpt（抜き出した箇所の場所）', () => {
  it('記法込みのまま見つかる', () => {
    const n = novel(['窓から見れる景色は\n二段落目の東京《とうきょう》'])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '見れる')
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.matchedBy).toBe('raw')
    expect(r.anchor).toMatchObject({ offset: 3, length: 3, paragraph: 1, before: '窓から', after: '景色は\n二段落目の東京《とうきょう》' })
    expect(r.occurrence).toBe(0)
  })
  it('ルビの記法を除いて見つけ、元の本文の位置（記法全体）に戻す', () => {
    const body = '一行目\n彼は｜東京《とうきょう》駅へ向かった'
    const n = novel([body])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '東京駅')
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.matchedBy).toBe('strip')
    expect(body.slice(r.anchor.offset, r.anchor.offset + r.anchor.length)).toBe('｜東京《とうきょう》駅')
    expect(r.anchor.paragraph).toBe(2)
  })
  it('記法の一部にかかる一致は、記法全体に広げる', () => {
    const body = '彼は｜東京《とうきょう》へ'
    const n = novel([body])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '東京')
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(body.slice(r.anchor.offset, r.anchor.offset + r.anchor.length)).toBe('｜東京《とうきょう》')
  })
  it('何か所もあって直前の文字で絞れなければ ambiguous、絞れれば found', () => {
    const n = novel(['猫が来た。猫が来た。犬が来た。'])
    const p = n.data.pieces[n.ids[0]]
    const amb = locateExcerpt(n.data, p, '来た')
    expect(amb.status).toBe('ambiguous')
    if (amb.status === 'ambiguous') expect(amb.count).toBe(3)
    const one = locateExcerpt(n.data, p, '来た', '犬が')
    expect(one.status).toBe('found')
    if (one.status === 'found') {
      expect(one.anchor.offset).toBe(12)
      expect(one.occurrence).toBe(2)
    }
  })
  it('見つからなければ not_found（直前の文字が合わなくても一意なら found）', () => {
    const n = novel(['ここに無い'])
    const p = n.data.pieces[n.ids[0]]
    expect(locateExcerpt(n.data, p, '別の文').status).toBe('not_found')
    expect(locateExcerpt(n.data, p, '無い', '関係ない').status).toBe('found')
  })
  it('幕に分けた話は各幕の採用稿で探し、見つけた幕を返す', () => {
    const n = novel(['第一幕の本文。\n第二幕の見れる本文。'])
    const { acts } = splitEpisode(n, n.ids[0], [8])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '見れる')
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.segment.piece.id).toBe(acts[1])
    expect(r.segment.parentId).toBe(n.ids[0])
    expect(r.anchor.offset).toBe(4)
    expect(adoptedSegments(n.data, n.data.pieces[n.ids[0]])).toHaveLength(2)
  })
  it('サロゲートペアの後ろ半分からの一致は使わず、前後の文字も切らない', () => {
    const n = novel(['𠮷𠮷野'])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '𠮷野')
    expect(r.status).toBe('found')
    if (r.status === 'found') {
      expect(r.anchor.offset).toBe(2)
      expect(r.anchor.before).toBe('𠮷')
    }
  })
  it('NFC にそろえて探す', () => {
    const n = novel(['ガラスの靴'])
    const decomposed = 'ガラス'
    expect(locateExcerpt(n.data, n.data.pieces[n.ids[0]], decomposed).status).toBe('found')
  })
})

describe('reanchor（本文が変わった後に探し直す）', () => {
  it('同じ稿・同じ本文なら exact、本文が変われば前後の文字が合う所（moved）、無ければ lost', () => {
    const n = novel(['あいう見れるえお。かき見れるくけ。'])
    const p = n.data.pieces[n.ids[0]]
    const r = locateExcerpt(n.data, p, '見れる', 'かき')
    if (r.status !== 'found') throw new Error(r.status)
    const s = { pieceId: p.id, parentId: null, versionId: r.segment.version.id, anchor: r.anchor, excerpt: '見れる' }
    expect(reanchor(n.data, s)).toMatchObject({ status: 'exact', offset: r.anchor.offset })
    const changed = updateVersion(n.data, p.versionIds[0], { body: '前に足した。あいう見れるえお。かき見れるくけ。' })
    expect(reanchor(changed, s)).toMatchObject({ status: 'moved', offset: 6 + 11 })
    const fixed = updateVersion(n.data, p.versionIds[0], { body: 'あいう見られるえお。かき見られるくけ。' })
    expect(reanchor(fixed, s)).toEqual({ status: 'lost' })
  })
  it('幕をつないだ・セパレートを解除した後も、属していた話で探す', () => {
    const n = novel(['第一幕。\n第二幕の見れる本文。'])
    const { acts } = splitEpisode(n, n.ids[0], [5])
    const r = locateExcerpt(n.data, n.data.pieces[n.ids[0]], '見れる')
    if (r.status !== 'found') throw new Error(r.status)
    const s = { pieceId: acts[1], parentId: n.ids[0], versionId: r.segment.version.id, anchor: r.anchor, excerpt: '見れる' }
    const joined = joinActWithNext(n.data, acts[0]).data
    expect(reanchor(joined, s)).toMatchObject({ status: 'moved', pieceId: acts[0], offset: 9 })
    const unsplit = unseparatePiece(n.data, n.ids[0]).data
    expect(reanchor(unsplit, s)).toMatchObject({ status: 'moved', pieceId: n.ids[0], offset: 9 })
  })
})
