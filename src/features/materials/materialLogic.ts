// 資料（ホームの棚「資料」・資料の画面）で使う、表示用の純粋な計算。データは変更しない。相対比較（benchLogic.ts）と同じ作り。
// 資料は数百冊になるので、棚には検索の欄（資料名・著者・タグ・メモの部分一致）と、作者が付けたタグのチップ（選んだタグを
// すべて持つ資料だけにする）を付ける。
// 棚の資料が多くても重くならないように、資料ごとの記録の並びは、中身が変わらない限り同じ配列を使い続ける
// （カードは React.memo でレコード単位の props にしている）。検索に使う形も資料のレコードごとに控える。
import { materialBiblio, materialTagList } from '../../claude/material'
import { materialNotesOf, materialSectionGroups } from '../../claude/materialOrder'
import { refKey } from '../../claude/refs'
import {
  MATERIAL_LIMITS,
  MATERIAL_SECTIONS,
  materialName as nameOf,
  materialTagsInUse,
  sectionKey,
  tagKey,
} from '../../domain/materialOps'
import { trashNotice } from '../../domain/trash'
import type { AppData, ID, Material, MaterialNote } from '../../domain/types'
import { analysisPreview, createdByLabel, runDateLabel, workLastUpdated } from '../bench/benchLogic'

/** 資料の表示名（空なら「無題の資料」） */
export const materialName = nameOf

/** 資料の書誌の1行（「著者・出版社・2019」。無い項目は飛ばす。コネクタの一覧と同じ） */
export const biblioLine = materialBiblio

/** 資料を作ったものの札（「Claude が作成」。手で足した資料は null。相対比較の作品と同じ表記） */
export const materialCreatedBy = createdByLabel

/** 日付の表示（YYYY-MM-DD → 2026/10/30） */
export const noteDateLabel = runDateLabel

/** 本文の1行の見本（閉じた記録に出す。Markdown の記号は除く） */
export const notePreview = analysisPreview

/** 資料の最終更新（資料とその記録のいちばん新しい更新日時） */
export const materialLastUpdated: (
  material: Pick<Material, 'updatedAt'>,
  notes: readonly Pick<MaterialNote, 'updatedAt'>[],
) => number = workLastUpdated

/** 記録の無い資料の記録（いつも同じ配列） */
export const NO_NOTES: readonly MaterialNote[] = []

/**
 * 資料ごとの記録（新しい日付から）。前に作った並び prev と中身（レコード）が同じ資料は、前の配列をそのまま使う
 * （カードの React.memo が効くように）
 */
export function notesByMaterial(
  data: Pick<AppData, 'materialNotes'>,
  prev?: ReadonlyMap<ID, readonly MaterialNote[]>,
): Map<ID, readonly MaterialNote[]> {
  const raw = new Map<ID, MaterialNote[]>()
  for (const n of Object.values(data.materialNotes)) {
    const list = raw.get(n.materialId)
    if (list) list.push(n)
    else raw.set(n.materialId, [n])
  }
  const out = new Map<ID, readonly MaterialNote[]>()
  for (const [materialId, list] of raw) {
    const old = prev?.get(materialId)
    const same = old && old.length === list.length && old.every((n) => data.materialNotes[n.id] === n)
    out.set(
      materialId,
      same ? old : materialNotesOf({ materialNotes: Object.fromEntries(list.map((n) => [n.id, n])) }, materialId),
    )
  }
  return out
}

/** 項目の名前（項目ごとの数つき。カードのチップに出す） */
export interface SectionChip {
  section: string
  count: number
}

/** 項目のチップ（決まった4つの順、その後にほかの項目を最初に記録した順） */
export function sectionChips(notes: readonly MaterialNote[]): SectionChip[] {
  return materialSectionGroups(notes).map((g) => ({ section: g.section, count: g.items.length }))
}

export interface NoteGroup {
  /** 項目の名前 */
  section: string
  /** 新しい日付から（記録の無い決まった項目は空） */
  items: readonly MaterialNote[]
  /** 決まった4つの項目か */
  fixed: boolean
}

const FIXED_KEYS = new Set<string>(MATERIAL_SECTIONS.map(sectionKey))

/**
 * 資料の画面の項目のまとまり。記録が1つでもあれば、決まった4つの項目（要約・創作に役立つ知識・描写に使える部分・
 * サンプルシーン）はまだ記録が無くてもこの順に出し（どの項目がまだかが分かるように）、その後にほかの項目を最初に記録した順。
 * 記録が1つも無ければ空（画面は「まだ記録がありません」）
 */
export function noteGroups(notes: readonly MaterialNote[]): NoteGroup[] {
  if (notes.length === 0) return []
  const groups = materialSectionGroups(notes)
  const byKey = new Map(groups.map((g) => [sectionKey(g.section), g]))
  return [
    ...MATERIAL_SECTIONS.map((s) => ({ section: s as string, items: byKey.get(sectionKey(s))?.items ?? NO_NOTES, fixed: true })),
    ...groups.filter((g) => !FIXED_KEYS.has(sectionKey(g.section))).map((g) => ({ ...g, fixed: false })),
  ]
}

/** 資料の削除の確認文（記録の数と、PDF は消えないこと） */
export function deleteMaterialMessage(notes: number): string {
  return [
    trashNotice(`この資料を資料の棚から削除し、${notes > 0 ? `記録（${notes}件）もいっしょに` : ''}`),
    'PDF そのものは claude.ai のプロジェクトにあるので、消えません。',
  ].join('\n\n')
}

// ---------- 棚の検索・タグのチップ ----------

/**
 * 探す時の形。refs.ts の refKey（Unicode の正規化 NFKC で全角と半角をそろえ、続く空白を1つに、前後の空白を除く）に
 * 英字の大文字と小文字の違いも問わないようにしたもの（コネクタが資料名で探す時と同じ照らし方に、大文字・小文字を足した）
 */
export const searchFold = (s: string): string => refKey(s).toLowerCase()

/** 資料のタグ（付けた順。空のものは除く） */
export const materialTags = materialTagList

/** 資料ごとの探す形（資料名・著者・タグ・メモ）。資料のレコードが同じなら作り直さない */
const keyCache = new WeakMap<Material, string>()

/** 資料名・著者・タグ（1つずつ）・メモを探す形にしてつないだもの（項目・タグをまたいでは一致しない） */
export function materialSearchKey(m: Material): string {
  const cached = keyCache.get(m)
  if (cached !== undefined) return cached
  const key = [m.name, m.author, ...materialTagList(m), m.note]
    .map((s) => searchFold(typeof s === 'string' ? s : ''))
    .join('\u0000')
  keyCache.set(m, key)
  return key
}

/** 検索の欄の語（空白で区切る。すべての語を含む資料だけを出す） */
export function searchTerms(query: string): string[] {
  return searchFold(query).split(' ').filter(Boolean)
}

/** 資料のタグの照らす形（tagKey）。資料のレコードが同じなら作り直さない */
const tagKeyCache = new WeakMap<Material, ReadonlySet<string>>()

export function materialTagKeys(m: Material): ReadonlySet<string> {
  const cached = tagKeyCache.get(m)
  if (cached) return cached
  const keys = new Set(materialTagList(m).map(tagKey).filter(Boolean))
  tagKeyCache.set(m, keys)
  return keys
}

/** タグのチップ（使っているタグだけ。資料の数の多い順、同じなら名前の順。書き方は棚で最初に出る資料のまま） */
export interface TagChip {
  /** 照らす形（tagKey） */
  key: string
  /** 表示するタグの名前 */
  tag: string
  count: number
}

/** タグのチップ（materialOps.ts の materialTagsInUse に、照らす形を足したもの） */
export function tagChips(data: Pick<AppData, 'materials'>): TagChip[] {
  return materialTagsInUse(data).map((t) => ({ key: tagKey(t.tag), tag: t.tag, count: t.count }))
}

export interface ShelfFilter {
  /** 検索の欄（資料名・著者・タグ・メモの部分一致） */
  query: string
  /** タグのチップで選んだタグ（tagKey の形。選んだ順。空 = タグで絞らない）。いくつか選べば、すべてを持つ資料だけ */
  tags: readonly string[]
}

/** 絞り込んでいるか */
export function isFiltering(filter: ShelfFilter): boolean {
  return searchTerms(filter.query).length > 0 || filter.tags.length > 0
}

/** タグを選ぶ・外す（選んでいれば外し、選んでいなければ末尾に足す） */
export function toggleTag(tags: readonly string[], key: string): string[] {
  return tags.includes(key) ? tags.filter((t) => t !== key) : [...tags, key]
}

/**
 * 棚の資料を絞る（materials は棚の順のまま。検索の語はすべてを含み、タグはチップで選んだものをすべて持つ資料だけ。
 * タグは tagKey で照らす）
 */
export function filterMaterials(materials: readonly Material[], filter: ShelfFilter): Material[] {
  const terms = searchTerms(filter.query)
  const tags = filter.tags
  if (terms.length === 0 && tags.length === 0) return [...materials]
  return materials.filter((m) => {
    if (tags.length) {
      const have = materialTagKeys(m)
      if (!tags.every((t) => have.has(t))) return false
    }
    if (terms.length === 0) return true
    const key = materialSearchKey(m)
    return terms.every((t) => key.includes(t))
  })
}

// ---------- タグの入力 ----------

/** タグを区切る文字（読点「、」・カンマ「,」。全角のカンマ・半角の読点も） */
const TAG_SEPARATORS = /[、,，､]/

/**
 * タグの入力欄の文字を、区切りの前（足すタグ）と、まだ打っている途中（最後の区切りの後）に分ける
 * （「ミリタリ、現代、戦」→ 足すのは「ミリタリ」「現代」、残りは「戦」）
 */
export function splitTagInput(text: string): { done: string[]; rest: string } {
  const parts = text.split(TAG_SEPARATORS)
  const rest = parts.pop() ?? ''
  return { done: parts.map((p) => p.trim()).filter(Boolean), rest }
}

/** タグの入力欄に区切りの文字があるか */
export const hasTagSeparator = (text: string): boolean => TAG_SEPARATORS.test(text)

/**
 * タグを末尾に足す（前後の空白を除き、空のもの・もう付いているもの（tagKey が同じ）は足さない）。
 * 20字を超えるタグ・20個を超える分は足さず、その理由を error に返す
 */
export function addTags(
  current: readonly string[],
  add: readonly string[],
): { tags: string[]; error: string | null; rejected: string[] } {
  const tags = [...current]
  const have = new Set(tags.map(tagKey))
  let error: string | null = null
  /** 足せなかったタグ（入力欄に残して、打ち直さずに直せるように） */
  const rejected: string[] = []
  for (const raw of add) {
    const tag = raw.trim()
    const key = tagKey(tag)
    if (!key || have.has(key)) continue
    if (Array.from(tag).length > MATERIAL_LIMITS.tag) {
      error = `タグは${MATERIAL_LIMITS.tag}字までにしてください（「${Array.from(tag).slice(0, MATERIAL_LIMITS.tag).join('')}…」）`
      rejected.push(tag)
      continue
    }
    if (tags.length >= MATERIAL_LIMITS.tags) {
      error = `タグは1つの資料に${MATERIAL_LIMITS.tags}個までです`
      rejected.push(tag)
      continue
    }
    tags.push(tag)
    have.add(key)
  }
  return { tags, error, rejected }
}

/**
 * タグの候補（使っているタグのうち、まだ付けていないもの。多く使われている順。打っている途中の文字があれば、それを含むものだけ）
 */
export function tagSuggestions(inUse: readonly string[], current: readonly string[], text: string, limit = 12): string[] {
  const have = new Set(current.map(tagKey))
  const q = searchFold(text)
  return inUse.filter((t) => !have.has(tagKey(t)) && (!q || searchFold(t).includes(q))).slice(0, limit)
}

/** 絞り込んだ時の件数（「3件／全120件」） */
export function filterCountLabel(shown: number, total: number): string {
  return `${shown}件／全${total}件`
}

/**
 * 絞り込んだ棚で、見えている隣の資料を越えて1つ上（-1）・下（+1）へ動かす時の、棚全体での移動先（moveMaterialTo の index）。
 * 見えている資料の中で端にある時は null（動かさない）。all・shown は棚の順
 */
export function visibleStepTarget(
  all: readonly Pick<Material, 'id'>[],
  shown: readonly Pick<Material, 'id'>[],
  id: ID,
  dir: -1 | 1,
): number | null {
  const at = shown.findIndex((m) => m.id === id)
  const neighbor = at < 0 ? undefined : shown[at + dir]
  if (!neighbor) return null
  // 上へも下へも、棚全体での隣の資料の位置へ入れる（moveMaterialTo は取り除いてから入れるので、上へなら隣の前、
  // 下へなら隣の後ろに入る）
  const index = all.findIndex((m) => m.id === neighbor.id)
  return index < 0 ? null : index
}
