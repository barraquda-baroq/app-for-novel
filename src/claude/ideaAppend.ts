// Claude がアイデア欄に書く（2.8）ための小さな部品。Claude がコネクタで作るアイデア（id は cy-…）の本文の形と、
// アイデアへの追記の依頼（IdeaAppend。id は cu-…）の形・確かめ・当て方。
// コネクタ（アイデアを足す・追記する・Claude に見せる内容の claudeView）とアプリ（依頼の処理 domain/claudeIdeas.ts・カードの印・
// 編集の画面・同期のまとめ方）が同じものを使うので、アプリが足した後の本文と、Claude がそれより先に見る本文は1字も違わない。
// - カードの1行目は作った日付と時刻（日本時間「2026/11/12 14:32」）。名前があれば同じ行の後ろに全角の空白を挟んで付ける
// - 追記はカードの終わりに、空行を置いて「2026/11/12のセッションで以下の内容へ変更」の行と内容を足す（前の中身は消さない）
// - 「作者が直した」は本文の指紋（claudeHash）で決める（済み・並べ替え・仕切りの移動・Claude の追記は数えない）
// visibility.ts から読み込むので、型・指紋（domain/hash）・日付（dates）・見せる範囲（access）のほかは読み込まない（輪にならないように）。
import { hashJson } from '../domain/hash'
import type { AppData, ID, Idea, IdeaAppend, Title } from '../domain/types'
import { canClaudeWrite } from './access'
import { isJstTimestamp, jstMinute, jstSlashDate } from './dates'

/** Claude が作るアイデアの記録の形の版 */
export const IDEA_RECORD_VERSION = 1

/** このアプリ・コネクタが知っている追記の依頼の形の版 */
export const IDEA_APPEND_VERSION = 1

/** Claude が作るアイデアの id（derivedId.ts の claudeIdeaId。アクセスルールでも同じ形を求める） */
export const CLAUDE_IDEA_ID = /^cy-[0-9a-z.]+$/

/** 追記の依頼の id（derivedId.ts の ideaAppendId。アクセスルールでも同じ形を求める） */
export const IDEA_APPEND_ID = /^cu-[0-9a-z.]+$/

/**
 * 数の上限（文章は文字の数）。perCall = 1回に足すアイデア、name = 名前、content = 1件の中身、appendText = 1回の追記、
 * body = 追記した後の1枚のカード、ref = 指す id、mark = 読んだ印、recordJson・appendJson = コネクタが書ける記録の大きさ
 * （JSON の字数。アクセスルールと同じ値）。
 * 2.9 のフォルダ: folderName = フォルダの名前（domain/ideaFolders.ts の IDEA_FOLDER_NAME_MAX と同じ）、theme = 相談のテーマ
 * （「2026/11/12　」の11字を足して40字）、folderRef = フォルダの指し方（名前か f:…）、folderJson = コネクタが書けるフォルダの
 * 記録の大きさ（アクセスルールと同じ値）、foldersPerCall = 1回に作るフォルダ
 */
export const IDEA_LIMITS = {
  perCall: 10,
  name: 40,
  content: 20_000,
  appendText: 20_000,
  body: 100_000,
  ref: 80,
  mark: 20,
  recordJson: 50_000,
  appendJson: 50_000,
  folderName: 40,
  theme: 29,
  folderRef: 80,
  folderJson: 2_000,
  foldersPerCall: 2,
} as const

/** 文字の数（サロゲートペアを1字に数える） */
const charCount = (s: string) => Array.from(s).length

/** 終わりの空白・改行（全角の空白も）を除く */
const trimEnd = (s: string) => s.replace(/\s+$/u, '')

/**
 * Claude が書く中身・追記をそろえる。改行は LF に、先頭の空の行は除き、終わりの空白・改行（全角の空白も）を除く。
 * 途中は変えない（終わりに空白が残らないので、何も変えずに編集の画面で保存しても、本文が1字も変わらない）
 */
export function normalizeIdeaText(text: string): string {
  return trimEnd(text.replace(/\r\n?/g, '\n').replace(/^(?:[^\S\n]*\n)+/u, ''))
}

/** アイデアの名前をそろえる（空白・改行は半角の空白1つにまとめ、前後を除き、40字まで） */
export function normalizeIdeaName(name: string | null | undefined): string {
  const s = (name ?? '').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(s)
  return chars.length > IDEA_LIMITS.name ? chars.slice(0, IDEA_LIMITS.name).join('').trim() : s
}

/**
 * Claude が作るアイデアの本文。1行目は作った日付と時刻（日本時間）と、名前があれば全角の空白を挟んだ名前、
 * 2行目から中身（「2026/11/12 14:32　第3章の動機\n…」）
 */
export function claudeIdeaBody(now: number, name: string | null | undefined, content: string): string {
  const n = normalizeIdeaName(name)
  const head = `${jstMinute(now)}${n ? `\u3000${n}` : ''}`
  const c = normalizeIdeaText(content)
  return c ? `${head}\n${c}` : head
}

/** 追記の1行目（「2026/11/12のセッションで以下の内容へ変更」。日付は依頼を作った時の日本時間） */
export function appendHeader(createdAt: number): string {
  return `${jstSlashDate(createdAt)}のセッションで以下の内容へ変更`
}

/** 追記した後の本文（終わりの空白を除いた本文に、空行を1つ置いて追記の行と内容を足す。本文が空なら追記だけ） */
export function appendedBody(body: string, req: Pick<IdeaAppend, 'createdAt' | 'text'>): string {
  const core = trimEnd(body)
  const block = `${appendHeader(req.createdAt)}\n${normalizeIdeaText(req.text)}`
  return core ? `${core}\n\n${block}` : block
}

/**
 * current が base の後ろに何かを足しただけのものなら、足した部分（'\n\n' から始まる）。そうでなければ null。
 * 編集の画面の保存（開いている間に届いた追記を残す）と、同期のまとめ方（作者の直しと追記を両方残す）で使う
 */
export function appendedTail(base: string, current: string): string | null {
  const b = trimEnd(base)
  if (!b || !current.startsWith(`${b}\n\n`) || current.length <= b.length + 2) return null
  return current.slice(b.length)
}

/** Claude がコネクタで作ったアイデアか（source と id の形の両方。source だけでは決めない。id の形はアクセスルールが守る） */
export function isClaudeIdea(idea: Pick<Idea, 'id' | 'source'>): boolean {
  return idea.source === 'claude' && typeof idea.id === 'string' && CLAUDE_IDEA_ID.test(idea.id)
}

/**
 * 作者がアプリで直したか（古い版の見出しがある・Claude が書いた形の指紋が無い・今の本文の指紋と違う）。
 * 済み・並べ替え・仕切りの移動・Claude の追記では変わらない。Claude が書いた形に1字も違わず戻すと、直していないものに戻る
 */
export function ideaEditedByAuthor(idea: Pick<Idea, 'heading' | 'body' | 'claudeHash'>): boolean {
  if (typeof idea.heading === 'string' && idea.heading.trim() !== '') return true
  if (typeof idea.claudeHash !== 'string') return true
  return hashJson(typeof idea.body === 'string' ? idea.body : '') !== idea.claudeHash
}

/** アプリが足した追記の依頼の id（壊れた値は除く） */
export function appendIdsOf(idea: Pick<Idea, 'appendIds'>): string[] {
  return Array.isArray(idea.appendIds) ? idea.appendIds.filter((x): x is string => typeof x === 'string') : []
}

/** タイトルの表から引く（自分の項目だけ。'constructor' などの id で Object の中身を拾わない） */
function titleOf<T>(titles: Record<ID, T>, idea: Pick<Idea, 'titleId'>): T | undefined {
  const id = idea.titleId
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(titles, id) ? titles[id] : undefined
}

/**
 * Claude がこのアイデアの場所に書き込めるか。どのタイトルにも属さないホームのアイデア（タイトルが無いものもホームとして
 * 表示・修復される）は書き込める（「書き込みを許可」はコネクタが見る）。タイトルのアイデアは「読む＋書き込む」の時だけ
 */
export function ideaSectionWritable(titles: Record<ID, Pick<Title, 'claudeAccess'>>, idea: Pick<Idea, 'titleId'>): boolean {
  const t = titleOf(titles, idea)
  return t ? canClaudeWrite(t) : true
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 追記の依頼の形が正しいか（版は問わない。新しい版の依頼は isNewerIdeaAppend で見分ける）。createdAt は追記の行の日付になるので、
 * 日付にできる時刻だけ（isJstTimestamp。範囲の外の値は形の違う依頼として、アプリが消し、Claude に見せる内容にも当てない）
 */
export function isIdeaAppend(r: unknown): r is IdeaAppend {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const x = r as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    IDEA_APPEND_ID.test(x.id) &&
    isStr(x.ideaId) &&
    typeof x.text === 'string' &&
    typeof x.readMark === 'string' &&
    x.source === 'claude' &&
    isNum(x.v) &&
    isJstTimestamp(x.createdAt) &&
    isNum(x.updatedAt)
  )
}

/** 新しい版のコネクタが書いた依頼（形が違うかもしれないので、アプリは触らずに残し、Claude に見せる内容にも当てない） */
export function isNewerIdeaAppend(r: unknown): boolean {
  const v = (r as { v?: unknown } | null | undefined)?.v
  return typeof v === 'number' && v > IDEA_APPEND_VERSION
}

/** 形が正しく、知っている版の依頼（作った順。同じ時刻なら id の順） */
export function liveIdeaAppends(data: Partial<Pick<AppData, 'ideaAppends'>>): IdeaAppend[] {
  return Object.values(data.ideaAppends ?? {})
    .filter((r) => isIdeaAppend(r) && !isNewerIdeaAppend(r))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 追記の依頼を当てられない理由。not_found = アイデアが無い、applied = もう足した、not_claude = Claude が作ったアイデアでない、
 * not_writable = 書き込めない場所（「読む＋書き込む」でないタイトル）、invalid = 内容が空・長すぎる、too_long = 足すと1枚が長くなりすぎる
 */
export type IdeaAppendProblem = 'not_found' | 'applied' | 'not_claude' | 'not_writable' | 'invalid' | 'too_long'

/** 依頼を当てられるか（当てられれば null）。アプリの処理と Claude に見せる内容で同じ順に確かめる */
export function ideaAppendProblem(
  titles: Record<ID, Pick<Title, 'claudeAccess'>>,
  idea: Pick<Idea, 'id' | 'source' | 'titleId' | 'body' | 'appendIds'> | undefined,
  req: Pick<IdeaAppend, 'id' | 'createdAt' | 'text'>,
): IdeaAppendProblem | null {
  if (!idea) return 'not_found'
  if (appendIdsOf(idea).includes(req.id)) return 'applied'
  if (!isClaudeIdea(idea)) return 'not_claude'
  if (!ideaSectionWritable(titles, idea)) return 'not_writable'
  const text = normalizeIdeaText(typeof req.text === 'string' ? req.text : '')
  if (!text || charCount(text) > IDEA_LIMITS.appendText) return 'invalid'
  if (charCount(appendedBody(typeof idea.body === 'string' ? idea.body : '', req)) > IDEA_LIMITS.body) return 'too_long'
  return null
}

/**
 * 依頼を当てたアイデア。本文の終わりに足し、依頼の id を appendIds に足す。作者が直していなければ指紋も新しい本文のものにする
 * （追記は「作者が直した」に数えない。一度直したものは、追記しても直したまま）。並び・済み・場所・updatedAt は変えない
 */
export function withIdeaAppend<T extends Pick<Idea, 'heading' | 'body' | 'claudeHash' | 'appendIds'>>(
  idea: T,
  req: Pick<IdeaAppend, 'id' | 'createdAt' | 'text'>,
): T {
  const body = appendedBody(idea.body, req)
  return {
    ...idea,
    body,
    appendIds: [...appendIdsOf(idea), req.id],
    ...(ideaEditedByAuthor(idea) ? {} : { claudeHash: hashJson(body) }),
  }
}

/**
 * まだアプリが当てていない追記の依頼を、アイデアに当てた形（Claude に見せる内容。依頼を作った直後から追記した後の中身が見える）。
 * requests は liveIdeaAppends の順に渡す。当てた分を足していきながら、アプリの処理と同じ確かめ方で1件ずつ当てる（同じアイデアへの
 * 2件目は1件目を足した本文に足す）。当てた依頼を applied に返す。何も当てなければ同じ表を返し、渡した表は書き換えない
 */
export function overlayIdeaAppends(
  titles: Record<ID, Pick<Title, 'claudeAccess'>>,
  ideas: Record<ID, Idea>,
  requests: readonly IdeaAppend[],
): { ideas: Record<ID, Idea>; applied: IdeaAppend[] } {
  let out: Record<ID, Idea> | null = null
  const applied: IdeaAppend[] = []
  for (const req of requests) {
    const cur = out ?? ideas
    const idea = Object.prototype.hasOwnProperty.call(cur, req.ideaId) ? cur[req.ideaId] : undefined
    let next: Idea
    try {
      if (!idea || ideaAppendProblem(titles, idea, req) !== null) continue
      next = withIdeaAppend(idea, req)
    } catch {
      // 1件の依頼で投げても、ほかの依頼と見せる内容は止めない（当てられない依頼として扱う。アプリの処理も形の違う依頼として消す）
      continue
    }
    if (!out) out = { ...ideas }
    out[req.ideaId] = next
    applied.push(req)
  }
  return { ideas: out ?? ideas, applied }
}

/**
 * 読んだ印（本文の指紋の頭8字）。Claude は追記の前にアイデアの中身を読み、この印を渡す（読んだ後に中身が変わっていれば断る）
 */
export function ideaReadMark(body: string): string {
  return hashJson(body).replace(/\./g, '').slice(0, 8)
}

/** 読んだ印の形（ideaReadMark。英小文字と数字の8字） */
export const READ_MARK = /^[0-9a-z]{8}$/

/**
 * Claude が渡した読んだ印をそろえる。novel_get_notes の見出しの「印: 1i30lfcq」をそのまま渡しても（全角のコロン・英大文字・全角の英数字・
 * 前後の空白も）、印の8字だけにする。形が合うかは READ_MARK で確かめる（同じ印なら、そろえる前の書き方によらず同じ依頼の id になる）
 */
export function normalizeReadMark(mark: string): string {
  return mark
    .normalize('NFKC')
    .trim()
    .replace(/^印\s*:\s*/u, '')
    .trim()
    .toLowerCase()
}

/** アイデアの場所（「ホームのアイデア」か「タイトル『灰の庭』のアイデア」。タイトルが無いものはホーム） */
export function ideaPlaceLabel(titles: Record<ID, Pick<Title, 'name'>>, idea: Pick<Idea, 'titleId'>): string {
  const t = titleOf(titles, idea)
  return t ? `タイトル『${(typeof t.name === 'string' ? t.name.trim() : '') || '無題のタイトル'}』のアイデア` : 'ホームのアイデア'
}

/** 日付と時刻だけの行（名前を付けずに Claude が作ったアイデアの1行目「2026/11/12 14:32」） */
const STAMP_ONLY = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/

/**
 * アイデアの呼び名（切る前）。古い版の見出しがあれば見出し、なければ内容の最初の空でない行（前後の空白を除く）。その行が日付と時刻
 * だけ（名前を付けずに Claude が作ったアイデア）なら、全角の空白を挟んで次の空でない行を付ける（「2026/11/12 14:32　【動機】」。
 * 同じ時刻に作ったカードを見分けるため）。コネクタの答え・ゴミ箱へ移す依頼の表記・アプリのお知らせ・ゴミ箱の一覧・確認の画面で
 * 同じものを使う（カードの表示は変えない）。切るのは使う所（それぞれの字数）
 */
export function ideaLabelLine(idea: Pick<Idea, 'heading' | 'body'>): string {
  const heading = typeof idea.heading === 'string' ? idea.heading.trim() : ''
  if (heading) return heading
  const body = typeof idea.body === 'string' ? idea.body : ''
  let first = ''
  for (const raw of body.split(/\r\n?|\n/)) {
    const l = raw.trim()
    if (!l) continue
    if (!first) {
      first = l
      if (!STAMP_ONLY.test(first)) return first
      continue
    }
    return `${first}\u3000${l}`
  }
  return first
}

/** アイデアの1行目（ideaLabelLine。max 字を超えれば「…」で切る。空なら「（空のアイデア）」） */
export function ideaHeadLine(idea: Pick<Idea, 'heading' | 'body'>, max = 40): string {
  const line = ideaLabelLine(idea)
  const chars = Array.from(line)
  return (chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line) || '（空のアイデア）'
}
