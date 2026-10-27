// 設定タブで使う表示用・編集用の純粋な計算（ストアには触れない）。
import { newId } from '../../../domain/util'
import type { SettingEntry, SettingField } from '../../../domain/types'

/** 「＋項目を追加」で選べるひな形。名前とフィールドのテンプレートをまとめて入れる */
export interface CategoryPreset {
  name: string
  fieldTemplate: string[]
  hint: string
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  { name: 'キャラクター', fieldTemplate: ['読み', '年齢', '性別', '立場・役割', '性格', '外見', '背景'], hint: '登場人物' },
  { name: '世界観', fieldTemplate: [], hint: '舞台・ルール' },
  { name: '用語集', fieldTemplate: ['読み', '意味'], hint: '造語・専門用語' },
  { name: '地理・地名', fieldTemplate: ['読み', '概要'], hint: '国・街・場所' },
  { name: '組織・勢力', fieldTemplate: ['目的', '構成員', '拠点'], hint: '国家・団体' },
  { name: '歴史・年表', fieldTemplate: ['時期', '出来事'], hint: '過去の出来事' },
  { name: '魔法・技術', fieldTemplate: ['原理', '制約', '代償'], hint: '能力・仕組み' },
  { name: 'アイテム', fieldTemplate: ['所有者', '効果', '由来'], hint: '道具・宝物' },
]

export function categoryDisplayName(name: string): string {
  return name.trim() || '無題の設定項目'
}

export function entryDisplayName(name: string): string {
  return name.trim() || '（名前未設定）'
}

/** テンプレート編集欄（1行に1つ）の文字列をフィールド名の配列にする。空行と重複は除く */
export function parseTemplate(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const key = line.trim()
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

export function templateToText(template: string[]): string {
  return template.join('\n')
}

/** 一覧で畳んでいる時に出す短い要約。入力済みのフィールドを「キー：値」で並べ、なければ自由記述の冒頭 */
export function entrySummary(entry: Pick<SettingEntry, 'fields' | 'body'>, maxLength = 90): string {
  const oneLine = (s: string) => s.replace(/\s+/gu, ' ').trim()
  const parts = entry.fields
    .filter((f) => f.value.trim())
    .map((f) => (f.key.trim() ? `${f.key.trim()}：${oneLine(f.value)}` : oneLine(f.value)))
  let text = parts.join(' ／ ')
  if (!text) text = oneLine(entry.body)
  const chars = Array.from(text)
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : text
}

// ---------- フィールドの配列操作（変更がなければ null を返す） ----------

export function patchField(
  fields: SettingField[],
  fieldId: string,
  patch: { key?: string; value?: string },
): SettingField[] | null {
  const i = fields.findIndex((f) => f.id === fieldId)
  if (i < 0) return null
  const f = fields[i]
  const next = { ...f, ...patch }
  if (next.key === f.key && next.value === f.value) return null
  return fields.map((x, j) => (j === i ? next : x))
}

export function removeField(fields: SettingField[], fieldId: string): SettingField[] | null {
  if (!fields.some((f) => f.id === fieldId)) return null
  return fields.filter((f) => f.id !== fieldId)
}

export function moveField(fields: SettingField[], fieldId: string, dir: -1 | 1): SettingField[] | null {
  const i = fields.findIndex((f) => f.id === fieldId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= fields.length) return null
  const next = [...fields]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function appendField(fields: SettingField[], key = ''): { fields: SettingField[]; fieldId: string } {
  const field: SettingField = { id: newId(), key, value: '' }
  return { fields: [...fields, field], fieldId: field.id }
}

/** テンプレートにあって、エントリにまだないフィールドを末尾に足す（既存の値は変えない） */
export function addMissingTemplateFields(fields: SettingField[], template: string[]): SettingField[] | null {
  const have = new Set(fields.map((f) => f.key.trim()))
  const missing = template.filter((k) => !have.has(k))
  if (missing.length === 0) return null
  return [...fields, ...missing.map((key): SettingField => ({ id: newId(), key, value: '' }))]
}
