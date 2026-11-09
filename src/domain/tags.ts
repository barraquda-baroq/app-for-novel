// タグの共通の部品（資料のタグ（2.6。materialOps.ts）と相対比較の作品のタグ（benchOps.ts）で同じ決まりを使う）。
// - 1つ20字まで・1つの資料（作品）に20個まで。並びは付けた順
// - 名前の照らし方は refs.ts の refKey（全角と半角・続く空白・前後の空白の違いは同じタグ）
// - 名前の付け替え・外すのは、その表のすべてのレコードでいっしょに
// 資料のタグと作品のタグは別の項目・別の表で、混ぜない。コネクタも読み込むので、dexie・react は読み込まない。
import { refKey } from '../claude/refs'
import { deepEqual } from './equal'
import type { Tx } from './tx'
import { DomainError, type BenchWork, type Material } from './types'
import { now } from './util'

/** タグの上限（tag はタグ1つの字数、tags は1つの資料・作品に付けられるタグの数） */
export const TAG_LIMITS = { tag: 20, tags: 20 } as const

/** タグを付ける物の呼び名（エラーの文に使う） */
export type TagNoun = '資料' | '作品'

/** 文字（コードポイント）の数 */
const chars = (s: string) => Array.from(s).length

/** タグを比べる形（refs.ts の refKey。全角と半角・続く空白・前後の空白の違いは同じタグ） */
export const tagKey = (tag: string): string => refKey(tag)

/** 並びの中で、前後の空白を除き、空のもの・refKey が同じものの2つ目から（と文字列でないもの）を除く。上限は確かめない */
export function uniqueTags(tags: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    const key = tagKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

function checkTagLength(tag: string): void {
  if (chars(tag) > TAG_LIMITS.tag) throw new DomainError(`タグは${TAG_LIMITS.tag}字までにしてください`)
}

/**
 * 付けるタグの形にする（付けた順のまま。前後の空白を除き、空のもの・refKey が同じものの2つ目からは除く）。
 * 1つ20字・1つの{noun}に20個を超えれば DomainError
 */
export function normalizeTags(tags: readonly string[], noun: TagNoun): string[] {
  const out = uniqueTags(tags)
  for (const tag of out) checkTagLength(tag)
  if (out.length > TAG_LIMITS.tags) throw new DomainError(`タグは1つの${noun}に${TAG_LIMITS.tags}個までにしてください`)
  return out
}

/** 新しいタグの名前を確かめる（前後の空白を除いたもの。空・20字を超えれば DomainError） */
export function tagName(to: string): string {
  const name = to.trim()
  if (!tagKey(name)) throw new DomainError('タグの名前を入れてください')
  checkTagLength(name)
  return name
}

/** タグを持つ表 */
export type TaggedTable = 'materials' | 'benchWorks'

/** 表示できる形のタグ（文字列の配列だけ。空のもの・重なるもの・20字を超えるもの・21個目からは外す）。配列でなければ undefined */
export function displayTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const tag = x.trim()
    const key = tagKey(tag)
    if (!key || seen.has(key) || chars(tag) > TAG_LIMITS.tag) continue
    seen.add(key)
    out.push(tag)
    if (out.length === TAG_LIMITS.tags) break
  }
  return out
}

/**
 * 表 table のすべてのレコードで、タグ from（refKey で照らす）を書き換える（fn は重なりを除いた今のタグを受け取る）。
 * 書き換えたレコードの数を返す。空になったら項目ごと消す
 */
export function rewriteTags(tx: Tx, table: TaggedTable, from: string, fn: (tags: string[], fromKey: string) => string[]): number {
  const fromKey = tagKey(from)
  if (!fromKey) return 0
  const ts = now()
  let changed = 0
  for (const r of tx.all(table) as (Material | BenchWork)[]) {
    const tags: readonly unknown[] = Array.isArray(r.tags) ? r.tags : []
    if (!tags.some((t) => typeof t === 'string' && tagKey(t) === fromKey)) continue
    const next = fn(uniqueTags(tags), fromKey)
    if (deepEqual(next, r.tags)) continue
    const out = { ...r, tags: next, updatedAt: ts }
    if (next.length === 0) delete (out as { tags?: string[] }).tags
    if (table === 'materials') tx.put('materials', out as Material)
    else tx.put('benchWorks', out as BenchWork)
    changed += 1
  }
  return changed
}

/** タグの名前を to にする書き換え（付け替えた先のタグがもう付いていれば1つにする（先に付いていた位置のまま））。名前は tagName で確かめたもの */
export const renameTagIn =
  (name: string) =>
  (tags: string[], fromKey: string): string[] =>
    uniqueTags(tags.map((t) => (tagKey(t) === fromKey ? name : t)))

/** タグを外す書き換え */
export const removeTagIn = (tags: string[], fromKey: string): string[] => tags.filter((t) => tagKey(t) !== fromKey)

/** 使っているタグと、そのタグを付けたレコードの数 */
export interface TagUse {
  /** タグの名前（書き方は並びで最初に出るレコードのまま） */
  tag: string
  count: number
}

/** 使っているタグ（records は棚の順。数の多い順、同じなら名前の順。refKey が同じものは1つに数える） */
export function tagsInUse(records: readonly { tags?: unknown }[]): TagUse[] {
  const out = new Map<string, TagUse>()
  for (const r of records) {
    for (const tag of uniqueTags(Array.isArray(r.tags) ? r.tags : [])) {
      const key = tagKey(tag)
      const cur = out.get(key)
      if (cur) cur.count += 1
      else out.set(key, { tag, count: 1 })
    }
  }
  return [...out.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja') || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  )
}
