// アイデア領域（仕切り・カード）で使う、表示用の純粋な計算。データは変更しない。
import type { IdeaSection } from '../../domain/entityOps'
import type { ID, Idea } from '../../domain/types'

/** 「どのタイトルにも属さない」仕切りの名前（entityOps.ideaSections と同じ文言） */
export const UNASSIGNED_NAME = 'どのタイトルにも属さない'

/** <select> や localStorage で仕切りを表すキー。titleId = null は 'none' */
export const UNASSIGNED_KEY = 'none'

export function sectionKey(titleId: ID | null): string {
  return titleId ?? UNASSIGNED_KEY
}

export function titleIdFromKey(key: string): ID | null {
  return key === UNASSIGNED_KEY || key === '' ? null : key
}

export function sectionDisplayName(section: Pick<IdeaSection, 'titleId' | 'name'>): string {
  if (section.titleId === null) return UNASSIGNED_NAME
  return section.name.trim() || '無題のタイトル'
}

/** 内容があれば保存できる（見出しの入力欄はない） */
export function canSaveIdea(text: string): boolean {
  return text.trim().length > 0
}

/**
 * 編集ダイアログに出す文章。古い版で付けた見出しがあれば、内容の1行目にまとめる（見出し＋改行＋内容）。
 * 保存すると、この文章が内容になり見出しは空になる（保存するまでは元のまま）
 */
export function ideaEditText(idea: Pick<Idea, 'heading' | 'body'>): string {
  return mergeHeading(idea.heading, idea.body)
}

function mergeHeading(heading: string, body: string): string {
  const h = heading.trim()
  if (!h) return body
  return body ? `${h}\n${body}` : h
}

/**
 * カードに出す内容を、1行目とそれ以降に分ける。2行目以降に何か書いてある時だけ lead（1行目。少し目立たせる）を返す。
 * 1行だけのアイデアは全体をふつうの文字で出す
 */
export function splitLead(body: string): { lead: string; rest: string } {
  const m = /^([^\r\n]*)((?:\r\n?|\n)[\s\S]*)?$/u.exec(body)
  const first = m?.[1] ?? body
  const rest = m?.[2] ?? ''
  if (!first.trim() || !rest.trim()) return { lead: '', rest: body }
  return { lead: first, rest }
}

/** 文字数で切り詰める（サロゲートペアを壊さない） */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** 見出し（古い版で付けたもの）、なければ内容の最初の空でない行 */
export function ideaFirstLine(idea: Pick<Idea, 'heading' | 'body'>): string {
  const heading = idea.heading.trim()
  if (heading) return heading
  return (
    idea.body
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

const SENTENCE_END = /[。！？!?．]/u
const CLAUSE_END = /[、，,；;：:・…‥\s]/u
/** 名前の末尾に残すと不自然な句読点 */
const TRAILING_PUNCT = /[\s、，,。．]+$/u
/** 途中で切った時に末尾に残すと不自然な記号（句読点・開きかっこ・空白・省略記号） */
const TRAILING_JUNK = /[\s、，,。．.・…‥「『（(【〈《［[]+$/u

/**
 * 長い文を名前に使える長さにする。省略記号（…）は付けない。
 * max 文字に収まらない時は、その範囲内の最後の文の区切り（。！？）、なければ読点などの区切りで切り、
 * どちらもなければ max 文字で切る。
 */
export function cutAtBoundary(text: string, max = 40): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('').replace(TRAILING_PUNCT, '')
  const finish = (cs: string[]) => cs.join('').replace(TRAILING_JUNK, '')
  // 短すぎる切れ端にはしない
  const min = Math.min(4, max)
  // ちょうど max 文字の直後にある区切りも使う
  const head = chars.slice(0, max + 1)
  const lastIndex = (re: RegExp) => {
    for (let i = head.length - 1; i >= min; i--) if (re.test(head[i])) return i
    return -1
  }
  const sentence = lastIndex(SENTENCE_END)
  if (sentence >= 0) {
    // ！？ は題名の一部として残す（max を超える場合は除く）
    const keep = /[！？!?]/u.test(head[sentence]) && sentence < max ? sentence + 1 : sentence
    return finish(chars.slice(0, keep))
  }
  const clause = lastIndex(CLAUSE_END)
  if (clause >= 0) return finish(chars.slice(0, clause))
  return finish(chars.slice(0, max))
}

/** 「この案でタイトルを作る」ときのタイトル名の候補。見出し（古い版）、なければ内容の最初の行（省略記号なし） */
export function titleNameFromIdea(idea: Pick<Idea, 'heading' | 'body'>, max = 40): string {
  return cutAtBoundary(ideaFirstLine(idea), max)
}

/** 確認ダイアログやトーストに出す、アイデアの短い呼び名 */
export function ideaShortLabel(idea: Pick<Idea, 'heading' | 'body'>, max = 24): string {
  return truncate(ideaFirstLine(idea), max) || '（空のアイデア）'
}

/** Ctrl+Enter / ⌘+Enter（変換中の Enter は除く） */
export function isSubmitShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing
}

/** ショートカットの表記（Mac なら ⌘） */
export function submitShortcutLabel(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘+Enter' : 'Ctrl+Enter'
}

/** 移動先の候補。今いる仕切りは current として印を付ける */
export interface MoveTarget {
  titleId: ID | null
  name: string
  count: number
  current: boolean
}

export function moveTargets(
  sections: IdeaSection[],
  idea: Pick<Idea, 'titleId'>,
  titleExists: (id: ID) => boolean,
): MoveTarget[] {
  // 削除済みタイトルを指すアイデアは「どのタイトルにも属さない」に表示されている
  const currentTitleId = idea.titleId !== null && titleExists(idea.titleId) ? idea.titleId : null
  return sections.map((s) => ({
    titleId: s.titleId,
    name: sectionDisplayName(s),
    count: s.ideas.length,
    current: s.titleId === currentTitleId,
  }))
}

/** 折りたたんだ仕切りのキー一覧を読み込む（壊れた値は無視） */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

// ---------- 位置を選んで移動 ----------

export interface PositionOption {
  /** 移動後の位置（移動するもの自身を除いた並びでの 0 始まりの位置） */
  index: number
  label: string
}

/**
 * 「位置を選んで移動」の候補。names は移動するもの自身を除いた並び（表示名）。
 * 先頭（「A」の前）／「A」の後／…／末尾（「Z」の後）。同じ表記が並ぶ時は何番目かを添える。
 */
export function positionOptions(names: string[], nameMax = 16): PositionOption[] {
  const q = (n: string) => `「${truncate(n, nameMax)}」`
  const n = names.length
  if (n === 0) return [{ index: 0, label: '先頭' }]
  const opts: PositionOption[] = []
  for (let k = 0; k <= n; k++) {
    const label = k === 0 ? `先頭（${q(names[0])}の前）` : k === n ? `末尾（${q(names[n - 1])}の後）` : `${q(names[k - 1])}の後`
    opts.push({ index: k, label })
  }
  const seen = new Map<string, number>()
  for (const o of opts) seen.set(o.label, (seen.get(o.label) ?? 0) + 1)
  return opts.map((o) => ((seen.get(o.label) ?? 0) > 1 ? { ...o, label: `${o.label}（${o.index + 1}番目）` } : o))
}

// ---------- 追加・編集ダイアログの下書き ----------

const MODAL_DRAFT_PREFIX = 'novel-studio:idea-modal-draft:'

/** 追加は仕切りごと、編集はアイデアごとに下書きを分ける */
export function ideaModalDraftKey(target: { mode: 'add'; section: string } | { mode: 'edit'; ideaId: ID }): string {
  return target.mode === 'add' ? `${MODAL_DRAFT_PREFIX}new:${target.section}` : `${MODAL_DRAFT_PREFIX}edit:${target.ideaId}`
}

export interface IdeaModalDraft {
  /** 書きかけの内容（見出しの入力欄があった頃の下書きは、見出しを1行目にまとめたもの） */
  body: string
}

/** 下書きとして書く形。見出しは常に空（更新前の版の画面が開いていても読めるように heading も書く） */
export function serializeIdeaModalDraft(body: string): string {
  return JSON.stringify({ heading: '', body })
}

/** 保存した下書きを読む（壊れた値は null）。見出しのある古い下書きは、編集ダイアログと同じく見出しを1行目にまとめる */
export function parseIdeaModalDraft(raw: string | null): IdeaModalDraft | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { heading?: unknown; body?: unknown } | null
    if (!v || typeof v.body !== 'string') return null
    if (v.heading !== undefined && typeof v.heading !== 'string') return null
    return { body: mergeHeading(typeof v.heading === 'string' ? v.heading : '', v.body) }
  } catch {
    return null
  }
}
