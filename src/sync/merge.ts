// 同期の3者マージ。
// base   = 最後にクラウドと揃えた時の内容（null = その時クラウドに無かった）
// mine   = この端末の内容（null = この端末で削除した）
// theirs = クラウドの最新の内容（null = 別の端末で削除された）
// 項目ごとに、この端末が base から変えた項目だけをクラウド側に重ねる。
import { deepEqual } from '../domain/equal'
import type { TableName } from '../domain/types'

export { deepEqual }

export type Rec = { id: string; updatedAt?: number }

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
  // actIds: 幕に分けた話の幕の並び（2.2）
  pieces: { versionIds: asString, actIds: asString },
  settingCategories: { fieldTemplate: asString },
  settingEntries: { fields: byId },
  trashEntries: { recordIds: asString },
  // 2.3: 改稿案の関係する話、戦略メモのコンテストの候補（［応募計画にする］を2台で別々に押しても両方残る）
  revisionIdeas: { pieceIds: asString },
  strategyNotes: { contests: byId },
}

/**
 * 片方で削除・片方で編集された時に、編集された内容をゴミ箱に残す表（文章を持つもの）。
 * 2.3 の推敲案（proofSuggestions）・実行の記録（proofBatches）は短い項目だけなので入れない（削除を優先し、控えない）。
 */
export const TEXT_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'versions',
  'memos',
  'ideas',
  'settingEntries',
  'submissions',
  // 2.3
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
])

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** primary の並びに、secondary にしか無い要素を、secondary での直前の要素の後ろに入れる */
function insertMissing(out: unknown[], seen: Set<string>, secondary: unknown[], skip: Set<string>, key: KeyOf): void {
  secondary.forEach((y, i) => {
    const k = key(y)
    if (seen.has(k) || skip.has(k)) return
    let pos = 0
    for (let j = i - 1; j >= 0; j--) {
      const pk = key(secondary[j])
      const idx = out.findIndex((z) => key(z) === pk)
      if (idx >= 0) {
        pos = idx + 1
        break
      }
    }
    out.splice(pos, 0, y)
    seen.add(k)
  })
}

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
  insertMissing(out, seen, t, new Set(baseItems.keys()), key)
  return out
}

/** 共通の履歴が無い2つの並びを合わせる: primary の並びに、secondary にしか無い要素を足す */
export function unionList(primary: unknown, secondary: unknown, key: KeyOf): unknown[] {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const x of asArray(primary)) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  insertMissing(out, seen, asArray(secondary), new Set(), key)
  return out
}

/**
 * 長い文章の項目。両方の端末で別々に書き換えていたら、どちらも捨てずに、クラウド側の文章の後ろに
 * この端末の文章を印付きで続ける（その場で両方が見え、利用者が整理できる）。
 * 稿の本文（versions.body）だけは別の稿として残す（mergeRemote の bodyConflict）。
 */
export const TEXT_FIELDS: Partial<Record<TableName, readonly string[]>> = {
  memos: ['body'],
  ideas: ['body'],
  settingEntries: ['body'],
  submissions: ['overview', 'result', 'revisionPlan', 'resubmissionPlan'],
  titles: ['synopsis', 'strategyNote'],
  chapters: ['note'],
  versions: ['note'],
  // 2.3（フラグ・チェックなどの短い項目は項目ごとに合わせ、両方で変えていたらこの端末を優先）
  revisionIdeas: ['body'],
  strategyNotes: ['body'],
  critiquePrompts: ['body'],
  critiqueResults: ['resultMarkdown', 'note'],
}

export function joinConflictText(theirs: string, mine: string, device: string): string {
  return `${theirs}\n\n――――（同期の競合: ${device}で同時に書かれた内容）――――\n${mine}`
}

export interface MergeOptions {
  /** 稿の本文が両方で変わっていた時: theirs = クラウド側を採って bodyConflict を返す、mine = この端末を採る */
  body?: 'theirs' | 'mine'
  /** この端末の呼び名（文章をつないだ時の印に使う） */
  device: string
  /**
   * 幕（2.2）: 話の幕の構成（分ける・さらに分ける・つなぐ・解除）を片方の端末だけが変えていた時の、その側（structure）。
   * 話の採用稿はその側のもの（分けた時の採用稿。分けている間は変えられない）、幕の採用稿を両方が別々に変えていたら
   * その側のもの（つないだ稿・分けた稿が採用原稿から抜けないように）。採らなかった側は overridden で返す
   */
  acts?: { structure: 'mine' | 'theirs' }
}

export interface FieldMerge {
  record: Rec
  bodyConflict: boolean
  /** 両方の文章をつないだ項目 */
  joined: string[]
  /** 幕の構成を変えた側の採用稿を採ったため、採らなかった側（acts の時） */
  overridden?: 'mine' | 'theirs'
}

/** 幕のレコードか（古い版の端末が第n話として書いた幕も、属する話 parentId を持つ） */
const isActLike = (r: Record<string, unknown>) => r.kind === 'act' || (r.kind !== 'special' && typeof r.parentId === 'string')

/**
 * 両方にあるレコードを項目ごとに合わせる。同じ項目を両方が別々に変えていたら、並びは要素ごとに合わせ、
 * 長い文章はつなぎ、それ以外はこの端末を優先する。
 */
export function mergeFields(table: TableName, base: Rec | null, mine: Rec, theirs: Rec, opts: MergeOptions): FieldMerge {
  const out: Record<string, unknown> = { ...theirs }
  const b = (base ?? {}) as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  let bodyConflict = false
  const joined: string[] = []
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
      else if (table === 'versions' && k === 'body' && (opts.body ?? 'theirs') === 'theirs') bodyConflict = true
      else if (TEXT_FIELDS[table]?.includes(k) && typeof mv === 'string' && typeof tv === 'string') {
        out[k] = joinConflictText(tv, mv, opts.device)
        joined.push(k)
      } else out[k] = mv
    }
    if (out[k] === undefined) delete out[k]
  }
  let overridden: FieldMerge['overridden']
  if (table === 'pieces' && opts.acts) {
    const side = opts.acts.structure
    const other = side === 'mine' ? 'theirs' : 'mine'
    const w = side === 'mine' ? m : t
    const l = side === 'mine' ? t : m
    const bv = b.activeVersionId
    const lostChanged = !deepEqual(l.activeVersionId, bv) && !deepEqual(l.activeVersionId, w.activeVersionId)
    if (isActLike(m) || isActLike(t)) {
      // 幕: 両方が採用稿を別々に変えていたら、幕の構成を変えた側（つないだ稿・分けた稿を採用している）
      if (!deepEqual(w.activeVersionId, bv) && lostChanged) {
        out.activeVersionId = w.activeVersionId
        overridden = other
      }
    } else {
      // 話: 幕の構成を変えた側の採用稿（分けた時の採用稿・解除した時の幕をつないだ稿）
      if (w.activeVersionId === undefined) delete out.activeVersionId
      else out.activeVersionId = w.activeVersionId
      if (lostChanged) overridden = other
    }
  }
  if (mine.updatedAt !== undefined || theirs.updatedAt !== undefined)
    out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return { record: out as Rec, bodyConflict, joined, ...(overridden ? { overridden } : {}) }
}

export interface MergeResult {
  /** 合わせた結果（null = 削除） */
  record: Rec | null
  /** 稿の本文が両方で変わっていた: クラウド側の本文を採り、この端末の稿（mine）を別の稿として残す */
  bodyConflict?: Rec
  /** 片方で削除・片方で編集されていた: 削除を優先し、編集された内容をここに返す（文章の表ならゴミ箱へ） */
  deletedEdit?: Rec
  /** 共通の履歴が無く、クラウド側を採った時のこの端末の内容（文章の表ならゴミ箱へ） */
  keptCopy?: Rec
  /** 両方の文章をつないだ項目 */
  joined?: string[]
  /** 幕の構成を変えた側の採用稿を採ったため、採らなかった側（MergeOptions.acts の時） */
  overridden?: 'mine' | 'theirs'
}

/**
 * 共通の履歴が無い（初めてのログイン・アカウントの切り替えで、この端末の内容をクラウドの内容と突き合わせる）時。
 * クラウド側を正とし、この端末にしか無い文章は控える。並びにはこの端末にしか無い要素を足す。
 */
function mergeUnrelated(table: TableName, mine: Rec | null, theirs: Rec | null, device: string): MergeResult {
  if (!mine) return { record: theirs }
  // クラウドで削除されていた: 削除を優先し、この端末の内容は控える
  if (!theirs) return { record: null, deletedEdit: mine }
  if (contentEqual(mine, theirs)) return { record: theirs }
  const out: Record<string, unknown> = { ...theirs }
  const m = mine as unknown as Record<string, unknown>
  for (const [field, key] of Object.entries(LIST_FIELDS[table] ?? {})) {
    if (field in out || field in m) out[field] = unionList(out[field], m[field], key)
  }
  const result: MergeResult = { record: out as Rec }
  const mineV = mine as unknown as { body?: unknown }
  const theirV = theirs as unknown as { body?: unknown }
  if (table === 'versions' && mineV.body !== theirV.body) result.bodyConflict = mine
  else if (TEXT_TABLES.has(table)) {
    if (!contentEqual(mine, result.record)) result.keptCopy = mine
  } else {
    // 控えを作らない表（タイトルのあらすじ・全体戦略、章のメモ）は、この端末の文章をつないで残す
    const joined: string[] = []
    for (const f of TEXT_FIELDS[table] ?? []) {
      const mv = m[f]
      const tv = out[f]
      if (typeof mv !== 'string' || mv === '' || mv === tv) continue
      if (typeof tv === 'string' && tv.includes(mv)) continue
      out[f] = typeof tv === 'string' && tv !== '' ? joinConflictText(tv, mv, device) : mv
      joined.push(f)
    }
    if (joined.length) result.joined = joined
  }
  return result
}

export function mergeRemote(
  table: TableName,
  base: Rec | null,
  mine: Rec | null,
  theirs: Rec | null,
  opts: MergeOptions & { noHistory?: boolean },
): MergeResult {
  if (opts.noHistory) return mergeUnrelated(table, mine, theirs, opts.device)
  if (contentEqual(mine, base)) return { record: theirs }
  // 同じ内容になっていれば、クラウドの内容をそのまま使う（端末内とクラウドを完全に揃えるため）
  if (contentEqual(theirs, mine)) return { record: theirs }
  if (contentEqual(theirs, base)) return { record: mine }
  if (!mine) {
    // この端末で削除・別の端末で編集
    return theirs ? { record: null, deletedEdit: theirs } : { record: null }
  }
  if (!theirs) {
    // 別の端末で削除・この端末で編集（クラウドに無かったものはこの端末で作ったものなので残す）
    return base ? { record: null, deletedEdit: mine } : { record: mine }
  }
  const { record, bodyConflict, joined, overridden } = mergeFields(table, base, mine, theirs, opts)
  const result: MergeResult = { record }
  if (bodyConflict) result.bodyConflict = mine
  if (joined.length) result.joined = joined
  if (overridden) result.overridden = overridden
  return result
}

/**
 * 同期の規則を使わない時（控えの作り方を渡さずに保存した時）の3者マージ: base から mine で変えた項目だけを
 * theirs に重ね、同じ項目を両方が変えていたらこの端末を優先する。
 */
export function mergeRecordLegacy(base: Rec, mine: Rec, theirs: Rec, table?: TableName): Rec {
  if (table) return mergeFields(table, base, mine, theirs, { body: 'mine', device: 'この端末' }).record
  const out: Record<string, unknown> = { ...theirs }
  const b = base as unknown as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  for (const key of Object.keys(m)) {
    if (key === 'updatedAt') continue
    if (!deepEqual(m[key], b[key])) out[key] = m[key]
  }
  out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return out as Rec
}
