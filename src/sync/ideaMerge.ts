// アイデアの本文の同期のまとめ方（2.8）。Claude の追記（アプリが追記の依頼を当てて、本文の終わりに足した部分。
// src/claude/ideaAppend.ts の appendedBody）と作者の直しが2台でぶつかった時に、両方の変更を残し、足した部分を1回だけにする
// （今までのつなぎ方では、追記の前の本文が印を挟んで2回出る）。
// merge.ts の mergeFields が、アイデアの本文を両方の端末が別々に変えていた時（mine・theirs が base とも互いとも違う）と、
// 両方の端末が同じ追記の依頼を当てていて本文が違う時（片方が足した部分をまるごと消して base の本文に戻した時も。sharedIdeaAppends）に呼ぶ。
// 当てはまる形が無ければ null（今までどおり両方をつなぐ。何も失わない）。
// - 足した側: base から appendIds が増え、本文が「base の本文（終わりの空白を除く）＋空行＋何か」になっている側（pure）
// - 直していない側: 共通の版も、その側の本文も Claude が書いた形のまま（指紋 claudeHash が合う。ideaEditedByAuthor）。共通の版の本文に、
//   その側が当てた依頼の追記を足しただけのもの
// - (a) 相手が当てた依頼はどれもこの端末も当てていて、相手は直していない → この端末の本文（この端末で作者が直した所・終わりを消した・
//   足した部分をまるごと消した、も残る）
// - (b) その逆（この端末が当てた依頼はどれも相手も当てていて、この端末は直していない） → 相手の本文
//   両方が同じ依頼を当てた時は、足した部分の長さ（含むか）では決めない（片方で作者が足した部分の終わりを消した・まるごと消したのと、
//   もう片方が足したのとを見分けられない）
// - 指紋で見分けられない時（共通の版がもう直してあった・両方とも直した）は、(a)(b) の「直していない側」の代わりに「足した形のままの側」で決める:
//   その側の本文が、共通の版の本文の終わりに当てた依頼の追記を足しただけの形（足した部分が追記の行から始まり、追記の行の数が当てた依頼の数と同じ）で、
//   その足した部分がもう片方の本文にそのままあり、その後ろが何も無いか、もう片方だけが当てた依頼の追記（追記の行から始まる）だけ → もう片方の本文
//   （もう片方で作者が足した部分の外を直した所が残る）。足した部分の後ろに作者が足した行がある時は使わない（片方で作者が足した部分の終わりの行を
//   消したのと見分けられない）。当たらなければ両方をつなぐ
// - (c) 片方の本文が、もう片方の本文の終わりに追記をいくつか足しただけのもの（足した部分が追記の行から始まり、追記の行の数が当てた依頼の
//   数の差と同じ） → 長い方（短い方の本文は、そのまま長い方の中にある）。追記の行の数が合わない（短い方で作者が足した部分を消した）時と、
//   短い方の本文に、短い方が当てた依頼の追記の行がそろっていない（短い方で作者が足した部分を消し、長い方で別の追記を消した）時は使わない
// - (d) 相手が足しただけで、その依頼をこの端末は知らない → この端末の本文（作者の直し）の後ろに、相手が足した部分を1回
// - (e) この端末が足しただけで、その依頼を相手は知らない → 相手の本文の後ろに、この端末が足した部分を1回
import { appendedTail, appendIdsOf, ideaEditedByAuthor } from '../claude/ideaAppend'
import type { Idea } from '../domain/types'

type Fields = Record<string, unknown>

/** 終わりの空白・改行（全角の空白も）を除く（ideaAppend.ts の appendedBody と同じ） */
const trimEnd = (s: string) => s.replace(/\s+$/u, '')

const idsOf = (r: Fields) => appendIdsOf({ appendIds: r.appendIds as string[] | undefined })

/** 足した部分（'\n\n' から始まる）を本文の後ろに付ける。本文が空なら足した部分だけ（appendedBody と同じ形） */
const onto = (body: string, tail: string) => {
  const core = trimEnd(body)
  return core ? `${core}${tail}` : tail.replace(/^\n+/, '')
}

/** 本文が Claude が書いた形のまま（作者が直していない。古い版の見出しも無い） */
const clean = (r: Fields) => !ideaEditedByAuthor(r as unknown as Pick<Idea, 'heading' | 'body' | 'claudeHash'>)

/** 追記の行（空行の後の「2026/11/12のセッションで以下の内容へ変更」。ideaAppend.ts の appendHeader の形） */
const BLOCK_HEAD = /\n\n\d{4}\/\d{2}\/\d{2}のセッションで以下の内容へ変更(?=\n|$)/gu

/** 本文の中の追記の行の数（本文が空の時に足した、本文の初めの追記の行も数える） */
const headCount = (s: string) => [...`\n\n${s}`.matchAll(BLOCK_HEAD)].length

/** 足した部分（'\n\n' から始まる）が、追記を n 件足しただけの形か（追記の行から始まり、追記の行がちょうど n 個） */
const blocksOf = (extra: string, n: number) => n > 0 && extra.search(BLOCK_HEAD) === 0 && headCount(extra) === n

/** long が short の終わりに、追記を n 件だけ足したものか */
function extendsBy(short: string, long: string, n: number): boolean {
  const extra = n > 0 ? appendedTail(short, long) : null
  return extra !== null && blocksOf(extra, n)
}

/**
 * pure の本文が共通の版の本文 bv の終わりに、当てた依頼 n 件の追記を足しただけの形で、その足した部分が other の本文にそのままあり、
 * その後ろが何も無い（終わりの空白だけ）か、other だけが当てた依頼 extra 件の追記（追記の行から始まる）だけか
 */
function keptIn(bv: string, pure: string, other: string, n: number, extra: number): boolean {
  const tail = n > 0 ? appendedTail(bv, pure) : null
  if (tail === null || !blocksOf(tail, n)) return false
  const at = other.lastIndexOf(tail)
  if (at < 0) return false
  const rest = other.slice(at + tail.length)
  return extra > 0 ? blocksOf(rest, extra) : trimEnd(rest) === ''
}

/** base から増えた追記の依頼の id */
const addedIds = (b: Fields, r: Fields) => {
  const baseIds = new Set(idsOf(b))
  return [...new Set(idsOf(r))].filter((x) => !baseIds.has(x))
}

/**
 * 両方の端末が、base から同じ追記の依頼を当てていたか（両方が1件以上当て、片方が当てた依頼はどれももう片方も当てている）。
 * この時は、片方の本文が base と同じ（作者が足した部分をまるごと消した）でも mergeIdeaBody でまとめる（片方だけの変更として、
 * 消した追記を戻さない）。別々の依頼だけを当てていた時は今までどおり（消した側の依頼を相手は知らないので、戻すものが無い）
 */
export function sharedIdeaAppends(b: Fields, m: Fields, t: Fields): boolean {
  const addM = addedIds(b, m)
  const addT = addedIds(b, t)
  if (!addM.length || !addT.length) return false
  const mIds = new Set(idsOf(m))
  const tIds = new Set(idsOf(t))
  return addM.every((x) => tIds.has(x)) || addT.every((x) => mIds.has(x))
}

/**
 * base・mine・theirs のアイデアの本文をまとめる（まとめられなければ null）。呼ぶのは、本文を両方の端末が別々に変えていた時と、
 * 両方が同じ追記の依頼を当てていて本文が違う時だけ
 */
export function mergeIdeaBody(b: Fields, m: Fields, t: Fields): string | null {
  const bv = b.body
  const mv = m.body
  const tv = t.body
  if (typeof bv !== 'string' || typeof mv !== 'string' || typeof tv !== 'string') return null
  const mIds = new Set(idsOf(m))
  const tIds = new Set(idsOf(t))
  const addM = addedIds(b, m)
  const addT = addedIds(b, t)
  if (!addM.length && !addT.length) return null
  const all = (xs: string[], set: Set<string>) => xs.every((x) => set.has(x))
  const none = (xs: string[], set: Set<string>) => !xs.some((x) => set.has(x))
  // (a)(b): 片方は、もう片方も当てた依頼を当てただけ（直していない）
  if (clean(b)) {
    if (addT.length && all(addT, mIds) && clean(t)) return mv
    if (addM.length && all(addM, tIds) && clean(m)) return tv
  }
  // (a)(b) を指紋で見分けられない時: 片方は、もう片方も当てた依頼の追記を足した形のままで、その足した部分がもう片方の本文にそのままある
  if (all(addT, mIds) && keptIn(bv, tv, mv, addT.length, addM.length - addT.length)) return mv
  if (all(addM, tIds) && keptIn(bv, mv, tv, addM.length, addT.length - addM.length)) return tv
  // (c): 片方の本文は、もう片方の本文の終わりに追記を足しただけ（短い方の本文に、短い方が当てた依頼の追記の行がそろっている）
  const keptAll = (body: string, n: number) => headCount(body) - headCount(bv) === n
  if (extendsBy(mv, tv, addT.length - addM.length) && keptAll(mv, addM.length)) return tv
  if (extendsBy(tv, mv, addM.length - addT.length) && keptAll(tv, addT.length)) return mv
  const tailM = addM.length ? appendedTail(bv, mv) : null
  const tailT = addT.length ? appendedTail(bv, tv) : null
  if (tailT !== null && none(addT, mIds)) return onto(mv, tailT)
  if (tailM !== null && none(addM, tIds)) return onto(tv, tailM)
  return null
}
