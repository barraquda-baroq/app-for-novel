// 資料（ホームの棚の、創作のために読む資料。主に利用者が購入した書籍）とその記録の操作。
// 資料はどのタイトルにも属さず、すべてのタイトルで共有する。記録は1つの資料にいくつでも（項目・Markdown の本文・日付）。
// 決まった項目は「要約」「創作に役立つ知識」「描写に使える部分」「サンプルシーン」（ほかの名前の項目も作れる）。
// Claude（コネクタ・貼り付け）が作った記録も、作った後はふつうのレコードとして編集・削除できる。
// 削除はゴミ箱へ（資料はその記録と一緒に1件、記録は1件ずつ）。相対比較（benchOps.ts）と同じ形。
// タグ（ミリタリ・現代・戦闘…）は作者が自分で付けて管理する（Claude は付けない）。1つの資料にいくつでも（20個まで）付けられ、
// 名前の照らし方は refs.ts の refKey（全角と半角・続く空白の違いは同じタグ）。名前の付け替え・外すのは、すべての資料でいっしょに。
// タグの決まりと部品は相対比較の作品のタグと共通（tags.ts）。資料のタグと作品のタグは別の項目で、混ぜない。
import { jstDate, isIsoDate } from '../claude/dates'
import { CLAUDE_RECORD_VERSION } from '../claude/visibility'
import { viewpointKey, type CardTrashOptions } from './benchOps'
import { deepEqual } from './equal'
import {
  normalizeTags,
  removeTagIn,
  renameTagIn,
  rewriteTags,
  TAG_LIMITS,
  tagKey as sharedTagKey,
  tagName,
  tagsInUse,
  type TagUse,
} from './tags'
import { orderOrigin, putInTrash, trashLabel } from './trash'
import { transact, type Tx } from './tx'
import { DomainError, type AppData, type ID, type Material, type MaterialNote } from './types'
import { byOrder, newId, nextOrder, now, stepOrder } from './util'

/**
 * 長さの上限（短い項目だけ。記録の本文・メモには上限を設けない）。資料名・著者・出版社・刊行年・PDF の置き場所・項目は
 * 相対比較の BENCH_LIMITS と同じ値。tag はタグ1つの字数、tags は1つの資料に付けられるタグの数
 */
export const MATERIAL_LIMITS = {
  materialName: 80,
  author: 80,
  publisher: 80,
  year: 20,
  pdfPlace: 200,
  section: 40,
  tag: TAG_LIMITS.tag,
  tags: TAG_LIMITS.tags,
} as const

/** 決まった項目（この順に並べる。ほかの名前の項目は、この後に最初に作った順） */
export const MATERIAL_SECTIONS = ['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン'] as const

/** 文字（コードポイント）の数 */
const chars = (s: string) => Array.from(s).length

// ---------- 読む ----------

/** 棚の並び（order の順） */
export function sortedMaterials(data: Pick<AppData, 'materials'>): Material[] {
  return Object.values(data.materials).sort(byOrder)
}

/** 資料の名前（空なら「無題の資料」） */
export function materialName(material: Pick<Material, 'name'>): string {
  return material.name.trim() || '無題の資料'
}

/** 項目の名前を比べる形（前後の空白を除き、Unicode の正規化をそろえる。相対比較の観点と同じ比べ方） */
export function sectionKey(section: string): string {
  return viewpointKey(section)
}

/**
 * 項目の入力の候補。決まった4つ（この順）の後に、すべての資料の記録で使ったことのあるほかの項目
 * （多く使われているものから、同じ数なら最初に使った順）。資料をまたいで同じ項目の名前にそろえやすいように
 */
export function materialSectionSuggestions(data: Pick<AppData, 'materialNotes'>): string[] {
  const fixed = new Set<string>(MATERIAL_SECTIONS.map(sectionKey))
  const seen = new Map<string, { name: string; count: number; first: number }>()
  for (const n of Object.values(data.materialNotes)) {
    const key = sectionKey(n.section)
    if (!key || fixed.has(key)) continue
    const cur = seen.get(key)
    if (cur) {
      cur.count += 1
      cur.first = Math.min(cur.first, n.createdAt)
    } else seen.set(key, { name: key, count: 1, first: n.createdAt })
  }
  const others = [...seen.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first || (a.name < b.name ? -1 : 1))
    .map((x) => x.name)
  return [...MATERIAL_SECTIONS, ...others]
}

// ---------- 資料 ----------

export interface MaterialInput {
  name?: string
  author?: string
  publisher?: string
  year?: string
  pdfPlace?: string
  note?: string
  /** タグ（付けた順。前後の空白を除き、空のもの・refKey が同じものの2つ目からは除く） */
  tags?: readonly string[]
}

function checkLength(value: string | undefined, max: number, label: string): void {
  if (value !== undefined && chars(value) > max) throw new DomainError(`${label}は${max}字までにしてください`)
}

/** 入力の形を確かめて、資料の項目にする（任意の項目は、空なら持たない） */
function materialFields(input: MaterialInput): Partial<Material> {
  const out: Partial<Material> = {}
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new DomainError('資料名を入れてください')
    checkLength(name, MATERIAL_LIMITS.materialName, '資料名')
    out.name = name
  }
  if (input.author !== undefined) {
    checkLength(input.author.trim(), MATERIAL_LIMITS.author, '著者')
    out.author = input.author.trim()
  }
  if (input.pdfPlace !== undefined) {
    checkLength(input.pdfPlace.trim(), MATERIAL_LIMITS.pdfPlace, 'PDF の置き場所')
    out.pdfPlace = input.pdfPlace.trim()
  }
  if (input.note !== undefined) out.note = input.note
  for (const [key, label] of [
    ['publisher', '出版社'],
    ['year', '刊行年'],
  ] as const) {
    const v = input[key]
    if (v === undefined) continue
    checkLength(v.trim(), MATERIAL_LIMITS[key], label)
    out[key] = v.trim()
  }
  if (input.tags !== undefined) out.tags = normalizeMaterialTags(input.tags)
  return out
}

/** 空の任意項目（出版社・刊行年・タグ）を取り除く */
function dropEmptyOptional(m: Material): Material {
  const out = { ...m }
  for (const key of ['publisher', 'year'] as const) if (out[key] !== undefined && !out[key]!.trim()) delete out[key]
  if (out.tags !== undefined && out.tags.length === 0) delete out.tags
  return out
}

/** 資料を棚の末尾に足す（資料名は必須） */
export function addMaterial(data: AppData, input: MaterialInput): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const fields = materialFields({ ...input, name: input.name ?? '' })
    const ts = now()
    const material: Material = dropEmptyOptional({
      id: newId(),
      name: fields.name!,
      author: fields.author ?? '',
      pdfPlace: fields.pdfPlace ?? '',
      note: fields.note ?? '',
      ...(fields.publisher ? { publisher: fields.publisher } : {}),
      ...(fields.year ? { year: fields.year } : {}),
      ...(fields.tags?.length ? { tags: fields.tags } : {}),
      order: nextOrder(tx.all('materials')),
      createdAt: ts,
      updatedAt: ts,
    })
    tx.put('materials', material)
    return material.id
  })
}

function requireMaterial(tx: Tx, id: ID): Material {
  const m = tx.get('materials', id)
  if (!m) throw new DomainError('資料が見つかりません')
  return m
}

/** 資料の情報を直す（資料名は空にできない。値が変わらなければ何もしない） */
export function updateMaterial(data: AppData, id: ID, patch: MaterialInput): AppData {
  return transact(data, (tx) => {
    const m = requireMaterial(tx, id)
    const next = dropEmptyOptional({ ...m, ...materialFields(patch) })
    if (deepEqual(next, m)) return
    tx.put('materials', { ...next, updatedAt: now() })
  }).data
}

// ---------- タグ ----------

/** タグを比べる形（refs.ts の refKey。全角と半角・続く空白・前後の空白の違いは同じタグ。tags.ts と同じ） */
export const tagKey = sharedTagKey

/**
 * 資料に付けるタグの形にする（付けた順のまま。前後の空白を除き、空のもの・refKey が同じものの2つ目からは除く）。
 * 1つ20字・1つの資料に20個を超えれば DomainError
 */
export function normalizeMaterialTags(tags: readonly string[]): string[] {
  return normalizeTags(tags, '資料')
}

/** 資料のタグを付け直す（並びは渡した順。空にすればタグなし。値が変わらなければ何もしない） */
export function setMaterialTags(data: AppData, id: ID, tags: readonly string[]): AppData {
  return updateMaterial(data, id, { tags })
}

/**
 * タグの名前を変える（すべての資料で付け替える。付け替えた先のタグがもう付いている資料では1つにする（先に付いていた位置のまま））。
 * 名前を変えた資料の数を返す。名前が空・20字を超えれば DomainError
 */
export function renameMaterialTag(data: AppData, from: string, to: string): { data: AppData; result: number } {
  const name = tagName(to)
  return transact(data, (tx) => rewriteTags(tx, 'materials', from, renameTagIn(name)))
}

/** タグをすべての資料から外す。外した資料の数を返す */
export function removeMaterialTag(data: AppData, tag: string): { data: AppData; result: number } {
  return transact(data, (tx) => rewriteTags(tx, 'materials', tag, removeTagIn))
}

/** 使っているタグと、そのタグを付けた資料の数 */
export type MaterialTagUse = TagUse

/** 使っているタグ（資料の数の多い順、同じなら名前の順。refKey が同じものは1つに数える） */
export function materialTagsInUse(data: Pick<AppData, 'materials'>): MaterialTagUse[] {
  return tagsInUse(sortedMaterials(data))
}

/** 棚の index 番目（0から）へ移す */
export function moveMaterialTo(data: AppData, id: ID, index: number): AppData {
  return transact(data, (tx) => {
    const list = tx.all('materials').sort(byOrder)
    const from = list.findIndex((m) => m.id === id)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved)
    const ts = now()
    list.forEach((m, i) => {
      if (m.order !== i) tx.put('materials', { ...m, order: i, updatedAt: ts })
    })
  }).data
}

/** 棚の中で1つ上（-1）・下（+1）へ */
export function moveMaterialStep(data: AppData, id: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const ts = now()
    for (const m of stepOrder(tx.all('materials'), id, dir)) tx.put('materials', { ...m, updatedAt: ts })
  }).data
}

/** 資料の記録（作った順） */
function notesOf(tx: Tx, materialId: ID): MaterialNote[] {
  return tx
    .all('materialNotes')
    .filter((n) => n.materialId === materialId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 資料を、その記録といっしょにゴミ箱の1件へ移す（種類「資料」、場所「資料」。戻すと棚の元の位置へ） */
export function deleteMaterial(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const material = tx.get('materials', id)
    if (!material) return
    putInTrash(tx, {
      kind: 'material',
      label: trashLabel.material(material),
      titleName: '',
      origin: { titleId: null, ...orderOrigin(tx.all('materials'), id) },
      records: [
        { table: 'materials', record: material },
        ...notesOf(tx, id).map((record) => ({ table: 'materialNotes' as const, record })),
      ],
    })
  }).data
}

// ---------- 記録 ----------

export interface MaterialNoteInput {
  section?: string
  body?: string
  /** 記録した日（YYYY-MM-DD。省略時は今日） */
  runDate?: string
}

function noteFields(input: MaterialNoteInput): Partial<MaterialNote> {
  const out: Partial<MaterialNote> = {}
  if (input.section !== undefined) {
    const v = input.section.trim()
    if (!v) throw new DomainError('項目を入れてください（要約・創作に役立つ知識など）')
    checkLength(v, MATERIAL_LIMITS.section, '項目')
    out.section = v
  }
  if (input.body !== undefined) out.body = input.body
  if (input.runDate !== undefined) {
    const d = input.runDate.trim()
    if (!isIsoDate(d)) throw new DomainError('日付は YYYY-MM-DD で入れてください')
    out.runDate = d
  }
  return out
}

/** 記録を手で足す（項目は必須。日付を省けば今日） */
export function addMaterialNote(data: AppData, materialId: ID, input: MaterialNoteInput): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireMaterial(tx, materialId)
    const fields = noteFields({ ...input, section: input.section ?? '' })
    const ts = now()
    const n: MaterialNote = {
      id: newId(),
      materialId,
      section: fields.section!,
      body: fields.body ?? '',
      runDate: fields.runDate ?? jstDate(ts),
      source: 'manual',
      v: CLAUDE_RECORD_VERSION,
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('materialNotes', n)
    return n.id
  })
}

/** 記録を直す（項目・本文・日付。値が変わらなければ何もしない） */
export function updateMaterialNote(data: AppData, id: ID, patch: MaterialNoteInput): AppData {
  return transact(data, (tx) => {
    const n = tx.get('materialNotes', id)
    if (!n) throw new DomainError('資料の記録が見つかりません')
    const fields = noteFields(patch)
    if ((Object.keys(fields) as (keyof MaterialNote)[]).every((k) => fields[k] === n[k])) return
    tx.put('materialNotes', { ...n, ...fields, updatedAt: now() })
  }).data
}

/** 記録を1件ずつゴミ箱へ（種類「資料の記録」、場所「資料 › 資料名」。資料が無ければ戻せない） */
export function deleteMaterialNote(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const n = tx.get('materialNotes', id)
    if (!n) return
    trashMaterialNote(tx, n)
  }).data
}

/**
 * 記録1つをゴミ箱の1件にする（作者の削除と Claude の依頼で同じ形。資料の名前を parentLabel に、資料を origin.materialId に
 * 控える。相対比較の trashBenchAnalysis と同じ）
 */
export function trashMaterialNote(tx: Tx, n: MaterialNote, opts: CardTrashOptions = {}): ID {
  const material = tx.get('materials', n.materialId)
  return putInTrash(tx, {
    kind: 'materialNote',
    label: trashLabel.materialNote(n),
    titleName: '',
    ...(material ? { parentLabel: trashLabel.material(material) } : {}),
    origin: { titleId: null, index: -1, materialId: n.materialId },
    records: [{ table: 'materialNotes', record: n }],
    ...opts,
  })
}
