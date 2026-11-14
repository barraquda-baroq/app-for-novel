// 資料（2.6）とその記録を Claude に渡す形（コネクタの読むツール・手動連携の依頼文で同じものを使う）と、資料の指し方。
// 相対比較の作品（bench.ts）と同じ作り。
// - 資料は短い id（d:3f2a9c1b）・id・資料名そのもの（前後や続く空白・全角と半角・Unicode の正規化の違いは問わない。refs.ts の
//   refKey。タイトル名で指す時と同じ）で指せる
// - 資料はどのタイトルにも属さない利用者の覚え書きなので、タイトルの「Claude に見せる」とは関係なく見せる
// - タグ（ミリタリ・現代・戦闘…）は作者が自分で付けて管理するもの。Claude には見せる（「タグ: ミリタリ・現代」）が、Claude は付けない
import { MATERIAL_SECTIONS, materialName, sectionKey, sortedMaterials } from '../domain/materialOps'
import { bodyMetrics, formatCount } from '../domain/text'
import type { AppData, Material, MaterialNote } from '../domain/types'
import { materialNotesOf, materialSectionGroups } from './materialOrder'
import { matchesId, refKey, shortId, type Resolved } from './refs'
import { joinBlocks, type TextBlock } from './resume'
import { pendingTrashCount, pendingTrashLine } from './trashTargets'

/** 資料の指し方（d:… の短い id・id・資料名）から資料を探す */
export function resolveMaterial(data: Pick<AppData, 'materials'>, ref: string): Resolved<Material> {
  const materials = sortedMaterials(data)
  const byId = materials.filter((m) => matchesId('material', ref, m.id))
  const key = refKey(ref)
  const hits = byId.length ? byId : materials.filter((m) => refKey(m.name) === key)
  if (hits.length === 1) return { ok: true, value: hits[0] }
  const candidates = (hits.length ? hits : materials).slice(0, 30).map((m) => materialRef(m))
  return hits.length
    ? {
        ok: false,
        reason: 'ambiguous',
        message: `資料の棚に資料名「${ref}」の資料が${hits.length}件あります。d:… の短い id で指してください`,
        candidates,
      }
    : { ok: false, reason: 'not_found', message: `資料 '${ref}' が見つかりません`, candidates }
}

/** 「d:3f2a9c1b『資料名』（著者）」 */
export function materialRef(m: Pick<Material, 'id' | 'name' | 'author'>): string {
  return `${shortId('material', m.id)}『${materialName(m)}』${m.author.trim() ? `（${m.author.trim()}）` : ''}`
}

/** 資料の書誌（「著者・出版社・2019」。無い項目は飛ばす） */
export function materialBiblio(m: Material): string {
  return [m.author, m.publisher, m.year]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .join('・')
}

/** 資料のタグ（付けた順。空のものは除く） */
export function materialTagList(m: Pick<Material, 'tags'>): string[] {
  return (Array.isArray(m.tags) ? m.tags : []).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)
}

/** 「タグ: ミリタリ・現代・戦闘」（タグが無ければ空） */
export function materialTagsLine(m: Pick<Material, 'tags'>): string {
  const tags = materialTagList(m)
  return tags.length ? `タグ: ${tags.join('・')}` : ''
}

/** 項目ごとの数と最新の日付（「要約 1件（最新 2026-11-02）・創作に役立つ知識 2件（…）」） */
export function sectionSummary(notes: readonly MaterialNote[]): string {
  return materialSectionGroups(notes)
    .map((g) => `${g.section} ${g.items.length}件（最新 ${g.items[0]?.runDate || '日付なし'}）`)
    .join('・')
}

/** 項目の名前だけ（「要約・創作に役立つ知識・年表」） */
export function sectionNames(notes: readonly MaterialNote[]): string[] {
  return materialSectionGroups(notes).map((g) => g.section)
}

/** 項目で絞る（前後の空白・正規化の違いは問わない。空なら絞らない） */
export function filterBySections(notes: readonly MaterialNote[], sections: readonly string[] | undefined): MaterialNote[] {
  const want = new Set((sections ?? []).map(sectionKey).filter(Boolean))
  return want.size ? notes.filter((n) => want.has(sectionKey(n.section))) : [...notes]
}

/** 1つの記録の見出しと本文（「#### 要約（2026-11-02・Claude）[k:…]」＋本文） */
export function noteText(n: MaterialNote): string {
  const by = n.source === 'claude' ? 'Claude' : n.source === 'paste' ? 'Claude（貼り付け）' : '手で記録'
  return `#### ${n.section.trim() || '項目なし'}（${n.runDate || '日付なし'}・${by}${n.model ? `・${n.model}` : ''}）[${shortId('materialNote', n.id)}]\n${n.body.trim() || '（本文なし）'}`
}

/**
 * 資料の記録を全部つないだ文（コネクタで1つの資料の記録を読む時）。項目ごとに（決まった項目の順、その後ほかの項目を
 * 最初に記録した順）、新しい日付から
 */
export function materialNotesText(
  data: Pick<AppData, 'materialNotes'>,
  material: Material,
  sections?: readonly string[],
): string {
  return materialNotesBlocks(data, material, sections).text
}

/**
 * materialNotesText と同じ文と、その中の記録ごとの位置（コネクタで続きを読む時に、読んでいた記録を id で探し直す。resume.ts）。
 * 頭（見出し・書誌・タグの行）は key '' の区切り
 */
export function materialNotesBlocks(
  data: Pick<AppData, 'materialNotes'>,
  material: Material,
  sections?: readonly string[],
): { text: string; blocks: TextBlock[] } {
  const list = filterBySections(materialNotesOf(data, material.id), sections)
  const head = [`=== 資料 ${materialRef(material)} ===`, materialBiblio(material), materialTagsLine(material)]
    .filter(Boolean)
    .join('\n')
  if (!list.length)
    return {
      text: `${head}\n（${sections?.length ? 'この項目の' : ''}記録はまだありません）`,
      blocks: [{ key: '', from: 0, start: 0, text: head }],
    }
  return joinBlocks(
    head,
    materialSectionGroups(list).map((g) => ({
      title: `--- 項目「${g.section}」（${g.items.length}件）---`,
      items: g.items.map((n) => ({ key: n.id, text: noteText(n) })),
    })),
  )
}

/**
 * 資料の1行（一覧用。「d:…『資料名』（著者）…」の下に、タグがあれば「  タグ: ミリタリ・現代」、
 * 「  記録 3件（…字）: 要約 1件（最新 …）・…」、ゴミ箱へ移す依頼中の記録の数と PDF の置き場所）
 */
export function materialLine(data: Pick<AppData, 'materialNotes' | 'trashRequests'>, m: Material): string {
  const notes = materialNotesOf(data, m.id)
  // 字数はアプリの資料の画面の「合計 n字」と同じ数え方（空白・改行・ルビの記法と読みを除く）
  const total = notes.reduce((n, x) => n + bodyMetrics(x).chars, 0)
  const tags = materialTagsLine(m)
  const pending = pendingTrashLine(pendingTrashCount(data, 'materialNotes', m.id))
  return [
    `${materialRef(m)}${materialBiblio(m) ? ` ${materialBiblio(m)}` : ''}`,
    ...(tags ? [`  ${tags}`] : []),
    `  記録 ${notes.length}件${notes.length ? `（${formatCount(total)}字）: ${sectionSummary(notes)}` : ''}`,
    ...(pending ? [pending] : []),
    ...(m.pdfPlace.trim() ? [`  PDF の置き場所: ${m.pdfPlace.trim()}`] : []),
  ].join('\n')
}

// ---------- 項目ごとの書き方（手動連携の依頼文と、コネクタの追加のツールの説明で同じものを使う） ----------

export type MaterialSection = (typeof MATERIAL_SECTIONS)[number]

/** 決まった項目ごとの、記録の書き方 */
export const MATERIAL_SECTION_GUIDE: Record<MaterialSection, string> = {
  要約: '資料の全体の要約（章立てに沿って）',
  創作に役立つ知識:
    '小説の設定・展開・人物に使えそうな知識・事実・数字・用語を、資料の中からすべて拾う（箇条書き。章・ページなどの出どころを添える）',
  描写に使える部分:
    '五感・道具・手順・場所・時代の空気など、小説の描写に使えそうな具体的な部分を、資料の中からすべて拾う（短い引用か言い換えと、出どころ）',
  サンプルシーン:
    '拾った知識と描写を使って仮想の場面を1つ立ち上げ、短いサンプルを書く（場面の設定を1〜2行で示してから本文。数百〜2,000字ほど）',
}

/** 長くなる時の分け方（項目ごとに分けて送る。1件が大きすぎれば番号を付けて分ける） */
export const MATERIAL_SPLIT_GUIDE =
  '長くなる時は項目ごとに分けて送る（1件が 200,000 字を超えるなら、body_markdown の1行目の先頭に「（1/2）」「（2/2）」…と番号を付けて分ける）'

/** 項目の書き方の行（「- 要約: 資料の全体の要約（章立てに沿って）」。決まった項目でなければ名前だけ） */
export function materialSectionLines(sections: readonly string[]): string[] {
  return sections.map((s) => {
    const fixed = MATERIAL_SECTIONS.find((f) => sectionKey(f) === sectionKey(s))
    return fixed ? `- ${fixed}: ${MATERIAL_SECTION_GUIDE[fixed]}` : `- ${s.trim()}`
  })
}
