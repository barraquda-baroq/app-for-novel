// 同期の3者マージ。
// base   = 最後にクラウドと揃えた時の内容（null = その時クラウドに無かった）
// mine   = この端末の内容（null = この端末で削除した）
// theirs = クラウドの最新の内容（null = 別の端末で削除された）
// 項目ごとに、この端末が base から変えた項目だけをクラウド側に重ねる。
import type { TableName } from '../domain/types'

export type Rec = { id: string; updatedAt?: number }

/** 同じ内容か（キーの順番は問わない） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false
  return true
}

/** 更新日時を除いて同じ内容か（null 同士も同じ） */
export function contentEqual(a: Rec | null | undefined, b: Rec | null | undefined): boolean {
  if (!a || !b) return !a && !b
  if (a === b) return true
  return deepEqual({ ...a, updatedAt: undefined }, { ...b, updatedAt: undefined })
}

/** キーを並べ替えた JSON（同じ内容なら同じ文字列になる）。undefined の項目は書かない */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    if (v === undefined || typeof v === 'function') continue
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`)
  }
  return `{${parts.join(',')}}`
}

type KeyOf = (item: unknown) => string

const asString: KeyOf = (x) => String(x)
const byId: KeyOf = (x) => String((x as { id?: unknown })?.id)
const byNode: KeyOf = (x) => {
  const n = x as { type?: unknown; id?: unknown }
  return `${String(n?.type)}:${String(n?.id)}`
}

/**
 * 並び（ID の一覧など）として合わせる項目。両方の端末で変わっていたら、この端末の並びを基本に、
 * 相手が消したものを除き、相手が足したものを相手の並びでの直前の要素の後ろに入れる。
 */
export const LIST_FIELDS: Partial<Record<TableName, Record<string, KeyOf>>> = {
  titles: { structure: byNode },
  chapters: { pieceIds: asString },
  pieces: { versionIds: asString },
  settingCategories: { fieldTemplate: asString },
  settingEntries: { fields: byId },
  trashEntries: { recordIds: asString },
}

/** 片方で削除・片方で編集された時に、編集された内容をゴミ箱に残す表（文章を持つもの） */
export const TEXT_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'versions',
  'memos',
  'ideas',
  'settingEntries',
  'submissions',
])

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function mergeList(base: unknown, mine: unknown, theirs: unknown, key: KeyOf): unknown[] {
  if (deepEqual(mine, base)) return asArray(theirs)
  if (deepEqual(theirs, base)) return asArray(mine)
  const b = asArray(base)
  const m = asArray(mine)
  const t = asArray(theirs)
  const baseItems = new Map(b.map((x) => [key(x), x]))
  const theirItems = new Map(t.map((x) => [key(x), x]))
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const x of m) {
    const k = key(x)
    if (seen.has(k)) continue
    // 相手が消したものは除く
    if (baseItems.has(k) && !theirItems.has(k)) continue
    seen.add(k)
    // 中身を持つ要素は、この端末で変えていなければ相手の中身を使う
    const bx = baseItems.get(k)
    const tx = theirItems.get(k)
    out.push(tx !== undefined && bx !== undefined && deepEqual(x, bx) ? tx : x)
  }
  // 相手が足したもの（この端末で消したものは足さない）
  t.forEach((y, i) => {
    const k = key(y)
    if (seen.has(k) || baseItems.has(k)) return
    let pos = 0
    for (let j = i - 1; j >= 0; j--) {
      const pk = key(t[j])
      const idx = out.findIndex((z) => key(z) === pk)
      if (idx >= 0) {
        pos = idx + 1
        break
      }
    }
    out.splice(pos, 0, y)
    seen.add(k)
  })
  return out
}

/**
 * 両方にあるレコードを項目ごとに合わせる。同じ項目を両方が別々に変えていたら、並びは合わせ、それ以外はこの端末を優先する。
 * 稿の本文だけは opts.body で決める（theirs = クラウド側を採って bodyConflict を返す、mine = この端末を採る）。
 */
export function mergeFields(
  table: TableName,
  base: Rec | null,
  mine: Rec,
  theirs: Rec,
  opts: { body: 'theirs' | 'mine' } = { body: 'theirs' },
): { record: Rec; bodyConflict: boolean } {
  const out: Record<string, unknown> = { ...theirs }
  const b = (base ?? {}) as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  let bodyConflict = false
  const keys = new Set([...Object.keys(m), ...Object.keys(b)])
  for (const k of keys) {
    if (k === 'id' || k === 'updatedAt') continue
    const mv = m[k]
    const bv = b[k]
    const tv = t[k]
    if (deepEqual(mv, bv)) continue
    if (deepEqual(tv, bv) || deepEqual(tv, mv)) {
      out[k] = mv
    } else {
      const listKey = LIST_FIELDS[table]?.[k]
      if (listKey) out[k] = mergeList(bv, mv, tv, listKey)
      else if (table === 'versions' && k === 'body' && opts.body === 'theirs') bodyConflict = true
      else out[k] = mv
    }
    if (out[k] === undefined) delete out[k]
  }
  if (mine.updatedAt !== undefined || theirs.updatedAt !== undefined)
    out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return { record: out as Rec, bodyConflict }
}

export interface MergeResult {
  /** 合わせた結果（null = 削除） */
  record: Rec | null
  /** 稿の本文が両方で変わっていた: クラウド側の本文を採り、この端末の稿（mine）を別の稿として残す */
  bodyConflict?: Rec
  /** 片方で削除・片方で編集されていた: 削除を優先し、編集された内容をここに返す（文章の表ならゴミ箱へ） */
  deletedEdit?: Rec
}

export function mergeRemote(table: TableName, base: Rec | null, mine: Rec | null, theirs: Rec | null): MergeResult {
  if (contentEqual(mine, base)) return { record: theirs }
  if (contentEqual(theirs, base) || contentEqual(theirs, mine)) return { record: mine }
  if (!mine) {
    // この端末で削除・別の端末で編集
    return theirs ? { record: null, deletedEdit: theirs } : { record: null }
  }
  if (!theirs) {
    // 別の端末で削除・この端末で編集（クラウドに無かったものはこの端末で作ったものなので残す）
    return base ? { record: null, deletedEdit: mine } : { record: mine }
  }
  const { record, bodyConflict } = mergeFields(table, base, mine, theirs)
  return bodyConflict ? { record, bodyConflict: mine } : { record }
}
