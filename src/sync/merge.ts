// 同期の3者マージ。
// base   = 最後にクラウドと揃えた時の内容（null = その時クラウドに無かった）
// mine   = この端末の内容（null = この端末で削除した）
// theirs = クラウドの最新の内容（null = 別の端末で削除された）
// 項目ごとに、この端末が base から変えた項目だけをクラウド側に重ねる。
import { refKey } from '../claude/refs'
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
/** 資料のタグ（2.6）: アプリと同じく refKey で照らす（全角と半角・空白の違いは同じタグ。どちらかで外す・名前を変えると、もう一方の書き方も外れる） */
const asTag: KeyOf = (x) => refKey(String(x))
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
  // benchWorkIds: 比べるベンチ作品（2.5。2台で別々に足しても両方残り、片方で外せば外れる）
  titles: { structure: byNode, benchWorkIds: asString },
  chapters: { pieceIds: asString },
  // actIds: 幕に分けた話の幕の並び（2.2）
  pieces: { versionIds: asString, actIds: asString },
  settingCategories: { fieldTemplate: asString },
  settingEntries: { fields: byId },
  trashEntries: { recordIds: asString },
  // 2.3: 改稿案の関係する話、戦略メモのコンテストの候補（［応募計画にする］を2台で別々に押しても両方残る）
  revisionIdeas: { pieceIds: asString },
  strategyNotes: { contests: byId },
  // 2.5: 批評で比べたベンチ作品
  critiqueResults: { benchWorkIds: asString },
  // 2.6: 資料のタグ（作者が付ける。2台で別々に付けても両方残り、片方で外せば外れる）
  materials: { tags: asTag },
  // 2.7: 相対比較の作品のタグ（資料のタグと同じ照らし方。2台が別々に自動のタグを付けても両方残る）
  benchWorks: { tags: asTag },
}

type PickNewer = (a: unknown, b: unknown) => unknown

/**
 * 自動のタグを取り込んだ 14 の印（2.7。src/domain/benchTags.ts の AutoTagMark。同期からは benchTags を読まないので、ここで形を見る）。
 * added はその取り込みで足した語（2.7.0 の端末の印には無い）
 */
type AutoTagMark = { analysisId: string; runDate: string; createdAt: number; added?: unknown }

const isMark = (v: unknown): v is AutoTagMark => {
  const m = v as Record<string, unknown> | null
  return (
    !!m &&
    typeof m === 'object' &&
    typeof m.analysisId === 'string' &&
    typeof m.runDate === 'string' &&
    typeof m.createdAt === 'number' &&
    Number.isFinite(m.createdAt)
  )
}

/** 印の足した語（文字列の配列でなければ null） */
const addedOf = (m: AutoTagMark): string[] | null =>
  Array.isArray(m.added) && m.added.every((x) => typeof x === 'string') ? m.added : null

/**
 * 日付 → 作った時刻 → id の順で新しい方（足した語 added は見ない）。同じ 14 の印（2台が別々に取り込んで、added だけが違う）は、
 * どちらの端末で合わせても同じ方になるように、キーを並べ替えた JSON の小さい方
 */
const newerMark: PickNewer = (a, b) => {
  if (!isMark(a)) return isMark(b) ? b : a
  if (!isMark(b)) return a
  if (a.runDate !== b.runDate) return a.runDate > b.runDate ? a : b
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b
  if (a.analysisId !== b.analysisId) return a.analysisId < b.analysisId ? a : b
  return stableStringify(a) <= stableStringify(b) ? a : b
}

/**
 * 2台が同じ 14 を別々に取り込んでいた時の、作品のタグの共通の版（2.7）。この端末と相手の印が同じ 14 で、共通の版の印は
 * それと違う（その前）時は、この端末がその 14 から足した語（autoTagsFrom.added）も共通の版のタグにあったものとする。
 * 相手ももう同じ語を足しているので、その後に相手で外したタグを戻さず、この端末で外したタグも外れる。この端末で手で付けた
 * タグは added に無いので、今までどおり残る。当てはまらない時・added の無い印（2.7.0 の端末）は undefined（今までどおり）
 */
function sharedImportBase(
  b: Record<string, unknown>,
  m: Record<string, unknown>,
  t: Record<string, unknown>,
): unknown[] | undefined {
  const mine = m.autoTagsFrom
  const theirs = t.autoTagsFrom
  if (!isMark(mine) || !isMark(theirs) || mine.analysisId !== theirs.analysisId) return undefined
  if (isMark(b.autoTagsFrom) && b.autoTagsFrom.analysisId === mine.analysisId) return undefined
  const out = [...asArray(b.tags)]
  const seen = new Set(out.map(asTag))
  for (const w of addedOf(mine) ?? []) {
    const k = asTag(w)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out.length > asArray(b.tags).length ? out : undefined
}

/**
 * 共通の履歴が無い時に、この端末にだけあっても足さない作品のタグ（2.7。asTag の集まり）。クラウドがこの端末と同じ 14 か、
 * もっと新しい 14 をもう取り込んでいたら、この端末がその 14 から自動で足した語（autoTagsFrom.added）のうちクラウドに無いものは
 * 足さない（クラウドで作者が外したタグを戻さない。もっと新しい 14 を取り込んだクラウドでは、古い 14 の判定はもう使わない）。
 * この端末で手で付けたタグは足す。当てはまらない時・added の無い印（2.7.0 の端末）は null
 */
function importedInCloud(m: Record<string, unknown>, t: Record<string, unknown>): Set<string> | null {
  const mine = m.autoTagsFrom
  const theirs = t.autoTagsFrom
  if (!isMark(mine) || !isMark(theirs)) return null
  if (mine.analysisId !== theirs.analysisId && newerMark(mine, theirs) !== theirs) return null
  const skip = new Set((addedOf(mine) ?? []).map(asTag))
  for (const x of asArray(t.tags)) skip.delete(asTag(x))
  return skip.size ? skip : null
}

/**
 * 両方の端末で変わっていたら、新しい方を採る項目（2.7）。相対比較の作品の autoTagsFrom: 古い方に戻ると、新しい 14 をもう一度
 * 取り込んで、作者が外したタグを戻してしまうため
 */
export const NEWER_FIELDS: Partial<Record<TableName, Record<string, PickNewer>>> = {
  benchWorks: { autoTagsFrom: newerMark },
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
  // 2.5: ベンチ作品（メモ）とその分析（本文）
  'benchWorks',
  'benchAnalyses',
  // 2.6: 資料（メモ）とその記録（本文）
  'materials',
  'materialNotes',
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
  // 規定の備考・提出する梗概・あらすじ・特記事項も長い文章（キャッチコピーと文字数の規定は短い項目として項目ごとに合わせる）
  submissions: ['overview', 'limitNote', 'synopsis', 'specialNotes', 'result', 'revisionPlan', 'resubmissionPlan'],
  titles: ['synopsis', 'strategyNote'],
  chapters: ['note'],
  versions: ['note'],
  // 2.3（フラグ・チェックなどの短い項目は項目ごとに合わせ、両方で変えていたらこの端末を優先）
  revisionIdeas: ['body'],
  strategyNotes: ['body'],
  critiquePrompts: ['body'],
  critiqueResults: ['resultMarkdown', 'note'],
  // 2.5（作品名・著者・観点などの短い項目は項目ごとに合わせる）
  benchWorks: ['note'],
  benchAnalyses: ['body'],
  // 2.6（資料名・著者・項目などの短い項目は項目ごとに合わせる）
  materials: ['note'],
  materialNotes: ['body'],
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
  // 2.7: 2台が同じ 14 を別々に取り込んでいたら、作品のタグは取り込んだ語も共通の版にあったものとして合わせる
  const tagsBase = table === 'benchWorks' ? sharedImportBase(b, m, t) : undefined
  if (tagsBase) keys.add('tags')
  for (const k of keys) {
    if (k === 'id' || k === 'updatedAt') continue
    const mv = m[k]
    const bv = k === 'tags' && tagsBase ? tagsBase : b[k]
    const tv = t[k]
    if (deepEqual(mv, bv)) continue
    if (deepEqual(tv, bv) || deepEqual(tv, mv)) {
      out[k] = mv
    } else {
      const listKey = LIST_FIELDS[table]?.[k]
      const newer = NEWER_FIELDS[table]?.[k]
      if (listKey) out[k] = mergeList(bv, mv, tv, listKey)
      else if (newer) out[k] = newer(mv, tv)
      else if (table === 'versions' && k === 'body' && (opts.body ?? 'theirs') === 'theirs') bodyConflict = true
      else if (TEXT_FIELDS[table]?.includes(k) && typeof mv === 'string' && typeof tv === 'string') {
        out[k] = joinConflictText(tv, mv, opts.device)
        joined.push(k)
      }
      // 古い版の端末で直した見出し: この端末で見出しを内容の1行目にまとめた（空にした）時は、相手の見出しを残す
      // （次に編集した時に内容へまとまる。両方が見出しを書いていたら従来どおりこの端末を優先）
      else if (table === 'ideas' && k === 'heading' && mv === '' && typeof tv === 'string' && tv.trim() !== '') out[k] = tv
      else out[k] = mv
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
  // 2.7: クラウドがもう取り込んだ 14 から、この端末が自動で足したタグ（足さない）
  const skip = table === 'benchWorks' ? importedInCloud(m, out) : null
  for (const [field, key] of Object.entries(LIST_FIELDS[table] ?? {})) {
    if (!(field in out || field in m)) continue
    const skipHere = field === 'tags' ? skip : null
    const list = unionList(out[field], skipHere ? asArray(m[field]).filter((x) => !skipHere.has(key(x))) : m[field], key)
    // 足さなかった語しか無かった（クラウドにタグが無い）時は、項目を作らない
    if (skipHere && !list.length && !(field in out)) continue
    out[field] = list
  }
  for (const [field, pick] of Object.entries(NEWER_FIELDS[table] ?? {})) {
    if (!(field in m)) continue
    const v = field in out ? pick(m[field], out[field]) : m[field]
    if (v === undefined) delete out[field]
    else out[field] = v
  }
  const result: MergeResult = { record: out as Rec }
  const mineV = mine as unknown as { body?: unknown }
  const theirV = theirs as unknown as { body?: unknown }
  if (table === 'versions' && mineV.body !== theirV.body) result.bodyConflict = mine
  else if (TEXT_TABLES.has(table)) {
    // 足さなかった自動のタグと取り込んだ印だけが違う時は控えない（作者が書いた内容ではないので）
    const shown = skip ? withoutSkippedTags(m, skip, out.autoTagsFrom) : mine
    if (!contentEqual(shown, result.record)) result.keptCopy = mine
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

/** 控えるかを比べる時の、この端末の内容（足さなかったタグを除き、印は合わせた結果の印にする。mergeUnrelated） */
function withoutSkippedTags(m: Record<string, unknown>, skip: Set<string>, mark: unknown): Rec {
  const out: Record<string, unknown> = { ...m, autoTagsFrom: mark }
  const tags = asArray(m.tags).filter((x) => !skip.has(asTag(x)))
  if (tags.length) out.tags = tags
  else delete out.tags
  return out as Rec
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
