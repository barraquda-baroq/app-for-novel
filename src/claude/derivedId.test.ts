// 内容から作る id のうち、2.8 の Claude のアイデア（cy-…）とアイデアへの追記の依頼（cu-…）。
// ほかの種類の id は basics.test.ts（内容から作る id）で確かめている。
import { describe, expect, it } from 'vitest'
import { hashJson } from '../domain/hash'
import { jstDate } from './dates'
import { claudeIdeaId, DERIVED_ID_LETTERS, derivedId, derivedKindOf, ideaAppendId } from './derivedId'
import { CLAUDE_IDEA_ID, IDEA_APPEND_ID } from './ideaAppend'

const DAY1_0900 = Date.UTC(2026, 10, 12, 0, 0)
const DAY1_2359 = Date.UTC(2026, 10, 12, 14, 59)
const DAY2_0000 = Date.UTC(2026, 10, 12, 15, 0)

describe('Claude のアイデアと追記の依頼の id（2.8）', () => {
  it('種類の1文字（y・u）はほかの種類と重ならない', () => {
    const letters = Object.values(DERIVED_ID_LETTERS)
    expect(new Set(letters).size).toBe(letters.length)
    expect(DERIVED_ID_LETTERS.claudeIdea).toBe('y')
    expect(DERIVED_ID_LETTERS.ideaAppend).toBe('u')
    // 改稿案（ci-…）とは別の文字
    expect(DERIVED_ID_LETTERS.revisionIdea).toBe('i')
  })

  it('claudeIdeaId: 同じ場所・日（日本時間）・名前・中身なら同じ id。時刻（分）は使わず、日が変われば別の id', () => {
    const id = claudeIdeaId(null, jstDate(DAY1_0900), '第3章の動機', '・兄を探す')
    expect(id).toMatch(CLAUDE_IDEA_ID)
    expect(id.length).toBeLessThanOrEqual(40)
    expect(derivedKindOf(id)).toBe('claudeIdea')
    expect(claudeIdeaId(null, jstDate(DAY1_2359), '第3章の動機', '・兄を探す')).toBe(id)
    expect(claudeIdeaId(null, jstDate(DAY2_0000), '第3章の動機', '・兄を探す')).not.toBe(id)
    // 場所・名前・中身が違えば別の id
    expect(claudeIdeaId('t1', jstDate(DAY1_0900), '第3章の動機', '・兄を探す')).not.toBe(id)
    expect(claudeIdeaId(null, jstDate(DAY1_0900), '', '・兄を探す')).not.toBe(id)
    expect(claudeIdeaId(null, jstDate(DAY1_0900), '第3章の動機', '・弟を探す')).not.toBe(id)
    // 名前・中身は本文と同じくそろえてから使う（空白の違い・改行の形・終わりの空白は同じ）
    expect(claudeIdeaId(null, jstDate(DAY1_0900), ' 第3章の　動機 ', '・兄を探す')).toBe(
      claudeIdeaId(null, jstDate(DAY1_0900), '第3章の 動機', '・兄を探す'),
    )
    expect(claudeIdeaId(null, jstDate(DAY1_0900), '第3章の動機', '\r\n・兄を探す\r\n　')).toBe(id)
    expect(claudeIdeaId(null, jstDate(DAY1_0900), undefined, 'x')).toBe(claudeIdeaId(null, jstDate(DAY1_0900), '', 'x'))
  })

  it('ideaAppendId: 同じアイデア・読んだ印・内容なら同じ id。印が変われば別の id。頼み直しの番号は2から', () => {
    const id = ideaAppendId('cy-abc', 'abcd1234', '変えた内容')
    expect(id).toMatch(IDEA_APPEND_ID)
    expect(id.length).toBeLessThanOrEqual(40)
    expect(derivedKindOf(id)).toBe('ideaAppend')
    expect(ideaAppendId('cy-abc', 'abcd1234', '変えた内容\n')).toBe(id)
    expect(ideaAppendId('cy-abc', 'efgh5678', '変えた内容')).not.toBe(id)
    expect(ideaAppendId('cy-abd', 'abcd1234', '変えた内容')).not.toBe(id)
    expect(ideaAppendId('cy-abc', 'abcd1234', '別の内容')).not.toBe(id)
    // generation 1 は番号を入れない（2.7 の trashRequestId と同じ作り方）
    expect(ideaAppendId('cy-abc', 'abcd1234', '変えた内容', 1)).toBe(id)
    expect(id).toBe(derivedId('ideaAppend', ['cy-abc', 'abcd1234', hashJson('変えた内容')]))
    const g2 = ideaAppendId('cy-abc', 'abcd1234', '変えた内容', 2)
    expect(g2).not.toBe(id)
    expect(g2).toBe(derivedId('ideaAppend', ['cy-abc', 'abcd1234', hashJson('変えた内容'), 2]))
    expect(ideaAppendId('cy-abc', 'abcd1234', '変えた内容', 3)).not.toBe(g2)
  })

  it('決まった値（アプリとコネクタで同じ値になることの目印。変えると、送り直したアイデア・依頼を重複と見分けられなくなる）', () => {
    expect(claudeIdeaId(null, '2026-11-12', '第3章の動機', '・兄を探す')).toBe('cy-1pv6bgp7u9w.1xo2to2glr2.1n')
    expect(ideaAppendId('cy-abc', 'abcd1234', '変えた内容')).toBe('cu-16zck4mf4xf.26pmazzfl8r.1g')
  })
})
