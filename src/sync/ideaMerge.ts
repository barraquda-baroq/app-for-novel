// アイデアの本文の同期のまとめ方（2.8）。Claude の追記（アプリが追記の依頼を当てて、本文の終わりに足した部分。
// src/claude/ideaAppend.ts の appendedBody）と作者の直しが2台でぶつかった時に、両方の変更を残し、足した部分を1回だけにする
// （今までのつなぎ方では、追記の前の本文が印を挟んで2回出る）。
// merge.ts の mergeFields が、アイデアの本文を両方の端末が別々に変えていた時（mine・theirs が base とも互いとも違う）にだけ呼ぶ。
// 当てはまる形が無ければ null（今までどおり両方をつなぐ。何も失わない）。
// - 足した側: base から appendIds が増え、本文が「base の本文（終わりの空白を除く）＋空行＋何か」になっている側（pure）
// - (a) 相手が足しただけで、その依頼も足した部分もこの端末の本文にある → この端末の本文
// - (b) この端末が足しただけで、その依頼も足した部分も相手の本文にある → 相手の本文
// - (c) 両方が足しただけで、片方の足した部分がもう片方の足した部分の続き → 長い方
// - (d) 相手が足しただけで、その依頼をこの端末は知らない → この端末の本文（作者の直し）の後ろに、相手が足した部分を1回
// - (e) この端末が足しただけで、その依頼を相手は知らない → 相手の本文の後ろに、この端末が足した部分を1回
import { appendedTail, appendIdsOf } from '../claude/ideaAppend'

type Fields = Record<string, unknown>

/** 終わりの空白・改行（全角の空白も）を除く（ideaAppend.ts の appendedBody と同じ） */
const trimEnd = (s: string) => s.replace(/\s+$/u, '')

const idsOf = (r: Fields) => appendIdsOf({ appendIds: r.appendIds as string[] | undefined })

/** 足した部分（'\n\n' から始まる）を本文の後ろに付ける。本文が空なら足した部分だけ（appendedBody と同じ形） */
const onto = (body: string, tail: string) => {
  const core = trimEnd(body)
  return core ? `${core}${tail}` : tail.replace(/^\n+/, '')
}

/**
 * base・mine・theirs のアイデアの本文をまとめる（まとめられなければ null）。呼ぶのは、本文を両方の端末が別々に変えていた時だけ
 */
export function mergeIdeaBody(b: Fields, m: Fields, t: Fields): string | null {
  const bv = b.body
  const mv = m.body
  const tv = t.body
  if (typeof bv !== 'string' || typeof mv !== 'string' || typeof tv !== 'string') return null
  const baseIds = new Set(idsOf(b))
  const mIds = new Set(idsOf(m))
  const tIds = new Set(idsOf(t))
  const addM = [...mIds].filter((x) => !baseIds.has(x))
  const addT = [...tIds].filter((x) => !baseIds.has(x))
  const tailM = addM.length ? appendedTail(bv, mv) : null
  const tailT = addT.length ? appendedTail(bv, tv) : null
  const all = (xs: string[], set: Set<string>) => xs.every((x) => set.has(x))
  const none = (xs: string[], set: Set<string>) => !xs.some((x) => set.has(x))
  if (tailT !== null && all(addT, mIds) && mv.includes(tailT)) return mv
  if (tailM !== null && all(addM, tIds) && tv.includes(tailM)) return tv
  if (tailT !== null && tailM !== null) {
    if (tailT.startsWith(tailM)) return tv
    if (tailM.startsWith(tailT)) return mv
  }
  if (tailT !== null && none(addT, mIds)) return onto(mv, tailT)
  if (tailM !== null && none(addM, tIds)) return onto(tv, tailM)
  return null
}
