// アイデア領域（仕切り・カード）で使う、表示用の純粋な計算。データは変更しない。
import { jstSlashDate } from '../../claude/dates'
import { appendedTail, ideaLabelLine } from '../../claude/ideaAppend'
import type { IdeaSection } from '../../domain/entityOps'
import {
  containerKey,
  effectiveFolderId,
  ideaFolderName,
  sectionOf,
  type IdeaFolderData,
  type IdeaFolderNode,
} from '../../domain/ideaFolders'
import type { IdeaPlace } from '../../domain/ideaFolderOps'
import type { ID, Idea } from '../../domain/types'

/** Claude がコネクタで作ったアイデアのカードの印（2.8。isClaudeIdea のもの） */
export const CLAUDE_IDEA_BADGE = 'Claude が作成'

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

/** 行の頭の日付と時刻（Claude が作ったアイデアの1行目「2026/11/12 14:32　第3章の動機」の「2026/11/12 14:32　」） */
const STAMP = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(?:[ \u3000]+|$)/u

/**
 * 「この案でタイトルを作る」ときのタイトル名の候補。見出し（古い版）、なければ内容の最初の行（省略記号なし）。
 * 行の頭の日付と時刻（2.8: Claude が作ったアイデアの1行目）は除き、日付と時刻だけの行なら次の空でない行
 */
export function titleNameFromIdea(idea: Pick<Idea, 'heading' | 'body'>, max = 40): string {
  if (idea.heading.trim()) return cutAtBoundary(ideaFirstLine(idea), max)
  const lines = idea.body
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const first = (lines[0] ?? '').replace(STAMP, '').trim()
  return cutAtBoundary(first || (lines[1] ?? ''), max)
}

/**
 * 確認ダイアログやトーストに出す、アイデアの短い呼び名（見出し、なければ内容の最初の行。日付と時刻だけの行（名前を付けずに Claude が
 * 作ったアイデア）は、次の空でない行も付ける「2026/11/12 14:32　【動機】」。ideaLabelLine。カードの表示は変えない）
 */
export function ideaShortLabel(idea: Pick<Idea, 'heading' | 'body'>, max = 24): string {
  return truncate(ideaLabelLine(idea), max) || '（空のアイデア）'
}

/** Ctrl+Enter / ⌘+Enter（変換中の Enter は除く） */
export function isSubmitShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing
}

/** ショートカットの表記（Mac なら ⌘） */
export function submitShortcutLabel(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘+Enter' : 'Ctrl+Enter'
}

/**
 * カードの移動先の候補（2.9: 木の形。仕切り（depth 0。フォルダの外）、その中の1段目（depth 1）、その中の2段目（depth 2））。
 * 今いる入れ物は current として印を付ける。count はその入れ物にじかに入っているカードの数
 */
export interface MoveTarget {
  /** 入れ物の鍵（containerKey） */
  key: string
  titleId: ID | null
  /** null = 仕切りのフォルダの外 */
  folderId: ID | null
  depth: 0 | 1 | 2
  /** 表示名（仕切りは名前。フォルダがある仕切りは「（フォルダの外）」を付ける。フォルダは名前） */
  name: string
  count: number
  current: boolean
}

/** カードの今の入れ物（見せ方の決まりで。削除済みのタイトルを指すカードは「どのタイトルにも属さない」） */
export function ideaPlace(data: IdeaFolderData, idea: Pick<Idea, 'titleId' | 'folderId'>): IdeaPlace {
  return { titleId: sectionOf(data.titles, idea.titleId), folderId: effectiveFolderId(data, idea) }
}

/** 移動先の候補を、仕切りの並び・木の順に返す。current（今いる入れ物）が null なら印を付けない（まとめて移す時の、場所の違うカード） */
export function moveTargets(sections: IdeaSection[], current: IdeaPlace | null): MoveTarget[] {
  const rows: MoveTarget[] = []
  const isCurrent = (titleId: ID | null, folderId: ID | null) =>
    current !== null && current.titleId === titleId && current.folderId === folderId
  for (const s of sections) {
    const name = sectionDisplayName(s)
    rows.push({
      key: containerKey(s.titleId, null),
      titleId: s.titleId,
      folderId: null,
      depth: 0,
      name: s.tree.folders.length ? `${name}（フォルダの外）` : name,
      count: s.tree.loose.length,
      current: isCurrent(s.titleId, null),
    })
    const add = (n: IdeaFolderNode) => {
      rows.push({
        key: containerKey(s.titleId, n.folder.id),
        titleId: s.titleId,
        folderId: n.folder.id,
        depth: n.depth,
        name: ideaFolderName(n.folder),
        count: n.ideas.length,
        current: isCurrent(s.titleId, n.folder.id),
      })
      for (const sub of n.folders) add(sub)
    }
    for (const top of s.tree.folders) add(top)
  }
  return rows
}

/** 仕切りの木の中の入れ物のカード（folderId = null はフォルダの外。見つからなければ空） */
export function containerIdeas(section: Pick<IdeaSection, 'tree'>, folderId: ID | null): Idea[] {
  if (folderId === null) return section.tree.loose
  const find = (nodes: IdeaFolderNode[]): IdeaFolderNode | undefined => {
    for (const n of nodes) {
      if (n.folder.id === folderId) return n
      const sub = find(n.folders)
      if (sub) return sub
    }
    return undefined
  }
  return find(section.tree.folders)?.ideas ?? []
}

/**
 * フォルダの移動先の候補（2.9）。仕切りごとに、1段目にする行（depth 0）と、1段目のフォルダ（depth 1。移すフォルダ自身は除く）。
 * 今の場所に印を付ける。中にフォルダのあるフォルダは、フォルダの行を選べない（3段目は作れない）
 */
export interface FolderMoveTarget {
  key: string
  titleId: ID | null
  /** 移す先の親（null = 1段目にする） */
  parentId: ID | null
  depth: 0 | 1
  /** 仕切りの名前（depth 0）・フォルダの名前（depth 1） */
  name: string
  current: boolean
  disabled: boolean
}

export function folderMoveTargets(
  sections: IdeaSection[],
  moving: { id: ID; place: { titleId: ID | null; parentId: ID | null }; hasSubfolders: boolean },
): FolderMoveTarget[] {
  const rows: FolderMoveTarget[] = []
  for (const s of sections) {
    const isCurrent = (parentId: ID | null) => moving.place.titleId === s.titleId && moving.place.parentId === parentId
    rows.push({
      key: containerKey(s.titleId, null),
      titleId: s.titleId,
      parentId: null,
      depth: 0,
      name: sectionDisplayName(s),
      current: isCurrent(null),
      disabled: false,
    })
    for (const top of s.tree.folders) {
      if (top.folder.id === moving.id) continue
      rows.push({
        key: containerKey(s.titleId, top.folder.id),
        titleId: s.titleId,
        parentId: top.folder.id,
        depth: 1,
        name: ideaFolderName(top.folder),
        current: isCurrent(top.folder.id),
        disabled: moving.hasSubfolders,
      })
    }
  }
  return rows
}

// ---------- フォルダ（2.9） ----------

/** アプリの画面で場所をつなぐ記号（「星の庭 › 場面の相談 › 雨の駅」。Claude 側は「＞」） */
export const PLACE_SEP = ' › '

/** 場所の表記（仕切りの名前と、入っているフォルダの名前のつながり）。編集ダイアログの「場所」「追加先」 */
export function ideaPlaceName(sectionName: string, folderNames: readonly string[]): string {
  return [sectionName, ...folderNames].join(PLACE_SEP)
}

/** フォルダの件数の説明（「12件（うち済み 2件）」） */
export function folderCountTitle(count: number, done: number): string {
  return done ? `${count}件（うち済み ${done}件）` : `${count}件`
}

/**
 * フォルダを削除する時の確かめの主語（trashNotice に渡す）。「フォルダ「場面の相談」と、中のフォルダ2つ・カード12件を」。
 * 中に何も無ければ「フォルダ「場面の相談」を」
 */
export function folderDeleteSubject(name: string, folders: number, cards: number): string {
  const inner = [folders ? `フォルダ${folders}つ` : '', cards ? `カード${cards}件` : ''].filter(Boolean).join('・')
  return inner ? `フォルダ「${name}」と、中の${inner}を` : `フォルダ「${name}」を`
}

/** まとめて移した時の知らせ（「8件を「…」へ移しました（2件はもうありません）」） */
export function bulkMovedMessage(moved: number, requested: number, place: string): string {
  const missing = requested - moved
  return `${moved}件を「${place}」へ移しました${missing > 0 ? `（${missing}件はもうありません）` : ''}`
}

/** 2段目のフォルダを作る時の名前の初期値（今日の日付と全角の空白。後ろにテーマを書く。「2026/11/13　」） */
export function subfolderInitialName(now: number): string {
  return `${jstSlashDate(now)}\u3000`
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

/** 追加は仕切りごと（2.9: フォルダに足す時はフォルダごと。new:f:<フォルダの id>）、編集はアイデアごとに下書きを分ける */
export function ideaModalDraftKey(
  target: { mode: 'add'; section: string } | { mode: 'add'; folderId: ID } | { mode: 'edit'; ideaId: ID },
): string {
  if (target.mode === 'edit') return `${MODAL_DRAFT_PREFIX}edit:${target.ideaId}`
  return 'folderId' in target ? `${MODAL_DRAFT_PREFIX}new:f:${target.folderId}` : `${MODAL_DRAFT_PREFIX}new:${target.section}`
}

export interface IdeaModalDraft {
  /** 書きかけの内容（見出しの入力欄があった頃の下書きは、見出しを1行目にまとめたもの） */
  body: string
  /**
   * 2.8: 書き始めた時のアイデアの内容（編集の時だけ）。下書きを書いた後に Claude の追記が足されていても、保存の時に追記を
   * 下書きの後ろに残せるように控える。2.7 までの下書きには無い
   */
  base?: string
}

/**
 * 下書きとして書く形。見出しは常に空（更新前の版の画面が開いていても読めるように heading も書く）。
 * base（書き始めた時の内容）は渡した時だけ書く（前の版の画面は知らない項目として読み飛ばす）
 */
export function serializeIdeaModalDraft(body: string, base?: string): string {
  return JSON.stringify(base === undefined ? { heading: '', body } : { heading: '', body, base })
}

/**
 * 保存した下書きを読む（壊れた値は null）。見出しのある古い下書きは、編集ダイアログと同じく見出しを1行目にまとめる。
 * base の無い・文字列でない下書きは、base 無しとして読む
 */
export function parseIdeaModalDraft(raw: string | null): IdeaModalDraft | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { heading?: unknown; body?: unknown; base?: unknown } | null
    if (!v || typeof v.body !== 'string') return null
    if (v.heading !== undefined && typeof v.heading !== 'string') return null
    const body = mergeHeading(typeof v.heading === 'string' ? v.heading : '', v.body)
    return typeof v.base === 'string' ? { body, base: v.base } : { body }
  } catch {
    return null
  }
}

/**
 * 保存する内容（2.8）。base は編集を始めた時の内容、text は保存する内容、current は今のアイデアの内容（ideaEditText）。
 * 編集している間に Claude の追記が足された（current が base の後ろに足しただけのもの）なら、保存する内容の後ろに追記を残す
 * （carried = true）。変わっていない・ほかの変わり方の時は、保存する内容のまま（今までどおり）
 */
export function rebaseIdeaEdit(base: string, text: string, current: string): { body: string; carried: boolean } {
  if (current === base) return { body: text, carried: false }
  const tail = appendedTail(base, current)
  if (tail === null) return { body: text, carried: false }
  const mine = text.replace(/\s+$/u, '')
  return { body: mine ? mine + tail : tail.replace(/^\n+/, ''), carried: true }
}
