// Claude がコネクタでアイデア欄に書く（2.8）ための組み立て: novel_add_ideas（アイデアを足す）と novel_append_to_idea（アイデアに追記）。
// コネクタだけが使う（手動連携の貼り付けでは使えない。records.ts の WRITE_TOOLS・WRITE_TOOL_LABELS には入れない）。
// - 本文・id・追記の形・確かめ方は ideaAppend.ts と derivedId.ts の部品で作る（アプリの処理・Claude に見せる内容と同じもの）
// - raw は修復した内容（見せないタイトル・作者が書いたホームのアイデア・ゴミ箱へ移す依頼の出ているアイデアも含む）、view は Claude に
//   見せる内容（claudeView。まだアプリが足していない追記の依頼も当てた形）。重複・並び・依頼済みは raw で、指す先・読んだ印は view で
//   見る（見せないものは「見つからない」と答え、中身を出さない）
// - カードは Markdown を変換せずにそのまま出すので、Markdown の記号がある中身は足さずに、その行を返す（自動では直さない）
import { isIdeaChecked } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import type { AppData, ID, Idea, IdeaAppend, Title } from '../domain/types'
import { stableStringify } from '../sync/merge'
import { canClaudeWrite } from './access'
import { jstDate } from './dates'
import { claudeIdeaId, ideaAppendId } from './derivedId'
import {
  appendIdsOf,
  appendedBody,
  claudeIdeaBody,
  IDEA_APPEND_VERSION,
  IDEA_LIMITS,
  IDEA_RECORD_VERSION,
  ideaHeadLine,
  ideaPlaceLabel,
  ideaReadMark,
  ideaSectionWritable,
  isClaudeIdea,
  normalizeIdeaName,
  normalizeIdeaText,
  normalizeReadMark,
  READ_MARK,
} from './ideaAppend'
import { RECORD_LIMITS } from './records'
import { matchesId, resolveTitle, shortId } from './refs'
import { isTrashedClaudeIdea } from './trashRequest'
import { liveTrashRequests } from './trashTargets'

/** ツールの名前 */
export const IDEA_ADD_TOOL = 'novel_add_ideas'
export const IDEA_APPEND_TOOL = 'novel_append_to_idea'

export type IdeaTool = typeof IDEA_ADD_TOOL | typeof IDEA_APPEND_TOOL

export function isIdeaTool(v: unknown): v is IdeaTool {
  return v === IDEA_ADD_TOOL || v === IDEA_APPEND_TOOL
}

/** 頼み直しの通し番号の上限（trashRequest.ts と同じ） */
const MAX_GENERATION = 100

/** 文字の数（サロゲートペアを1字に数える） */
const charCount = (s: string) => Array.from(s).length

const fmt = (n: number) => n.toLocaleString('ja-JP')

/** 短く切る（max 字を超えれば「…」） */
function cut(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

// ---------- Markdown の記号 ----------

/** 行の頭の Markdown の記号（見出し・箇条書き・引用・コードの囲み・表・区切り線）。「1. 」「#12」「・」【】は使える */
const MARKDOWN_LINE = [
  /^\s{0,3}#{1,6}\s/,
  /^\s*[-*+]\s+\S/,
  /^\s*>\s/,
  /^\s*```/,
  /^\s*\|.*\|\s*$/,
  /^\s*\|?\s*:?-{3,}:?\s*\|/,
  /^\s*([-*_])(\s*\1){2,}\s*$/,
]

/** 行の中の Markdown の記号（太字・リンク） */
const MARKDOWN_INLINE = [/\*\*[^*\n]+\*\*/, /__[^_\n]+__/, /\[[^\]\n]+\]\((https?:|#)/]

export interface MarkdownLine {
  /** 何行目か（1から） */
  line: number
  text: string
}

/** Markdown の記号がある行（何行目か・その行）。改行は LF・CRLF・CR のどれでもよい */
export function ideaMarkdownLines(text: string): MarkdownLine[] {
  const out: MarkdownLine[] = []
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      if (MARKDOWN_LINE.some((re) => re.test(l)) || MARKDOWN_INLINE.some((re) => re.test(l))) out.push({ line: i + 1, text: l })
    })
  return out
}

/** Markdown の記号がある時の直し方（3行まで。1行は20字まで） */
export function markdownHint(lines: readonly MarkdownLine[]): string {
  const shown = lines
    .slice(0, 3)
    .map((l) => `${l.line}行目「${cut(l.text.trim(), 20)}」`)
    .join('・')
  const more = lines.length > 3 ? `・ほか${lines.length - 3}行` : ''
  return `Markdown の記号があります（${shown}${more}）。カードは Markdown を変換せずにそのまま出すので、記号を使わず、箇条書きは「・」、小見出しは【】で書き直して送ってください`
}

// ---------- アイデアを足す（novel_add_ideas） ----------

export interface AddIdeasInput {
  /** タイトル（t:… かタイトル名）。省くとどのタイトルにも属さないホームのアイデア */
  title_id?: unknown
  items?: unknown
  model?: unknown
}

export interface IdeaWriteContext {
  /** 作った時刻（ms）。1行目の日付と時刻・id の日付もこの時刻の日本時間 */
  now: number
  /**
   * 以前に削除された記録か（コネクタ: クラウドの削除の印・ゴミ箱の中身・ゴミ箱へ移す依頼の出ているカード）。
   * 追記の依頼は、クラウドの削除の印（アプリが処理して消した依頼）だけを見る
   */
  wasDeleted: (table: 'ideas' | 'ideaAppends', id: ID) => boolean
}

/**
 * 1件の結果。created = 足す、duplicate = 同じ日に同じ場所・名前・中身のアイデアがもうある、previously_deleted = 以前に削除された
 * （ゴミ箱にある・ゴミ箱へ移す依頼中も）、invalid = 形が違う・長すぎる・Markdown の記号がある
 */
export type IdeaAddStatus = 'created' | 'duplicate' | 'previously_deleted' | 'invalid'

export interface IdeaAddItem {
  /** 入力の items の何番目か（0から） */
  index: number
  status: IdeaAddStatus
  /** 足す・足したアイデアの id（invalid は無い） */
  id?: ID
  /**
   * 「2026/11/12 14:32　第3章の動機」（1行目。入力から作る。名前が無い時は日付と時刻の後ろに中身の最初の行。ideaHeadLine）。
   * 重複で、もうあるカードが Claude に見えている時は、そのカードの1行目。形が違う時は「アイデア（2件目）」
   */
  label: string
  hint?: string
  /** 重複: もうあるカード（Claude が作ったもの）が Claude に見えている（答えにその i:… を出せる） */
  existing?: boolean
}

export interface IdeaAddBuild {
  /** false = 呼び出し全体を断った（error に理由） */
  ok: boolean
  error?: string
  candidates?: string[]
  /** 入れる場所（タイトルの id。null = ホームのアイデア） */
  titleId: ID | null
  /** 「ホームのアイデア」か「タイトル『星の庭』のアイデア」 */
  place: string
  /** タイトルの名前（ホームのアイデアは空） */
  titleName: string
  records: { table: 'ideas'; record: Idea }[]
  items: IdeaAddItem[]
}

export const IDEA_ADD_HINTS = {
  duplicate: '同じ内容のアイデアがもうあります（追加しません）',
  previously_deleted: '以前に削除されたアイデアです（追加しません。作者はアプリのゴミ箱から戻せます）',
} as const

/** 長すぎる中身の直し方（いくつに分ければよいか） */
function splitHint(chars: number): string {
  const k = Math.max(2, Math.ceil(chars / IDEA_LIMITS.content))
  return `${k}つのアイデアに分け、name に「（1/${k}）」のような番号を付けて足してください`
}

const modelOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? Array.from(v.trim()).slice(0, RECORD_LIMITS.model).join('') : undefined

/** タイトルの表記（空の名前は「無題のタイトル」） */
const titleName = (t: Pick<Title, 'name'>) => (typeof t.name === 'string' ? t.name.trim() : '') || '無題のタイトル'

/**
 * アイデアを足す記録を作る。title_id を省くとどのタイトルにも属さないホームのアイデア（コネクタが「書き込みを許可」を確かめる）、
 * 渡すとそのタイトル（「読む＋書き込む」の時だけ）。足すアイデアは、その場所の済みでないアイデアの先頭に、入力の順で並ぶ
 * （raw の済みでないアイデアの最小の order より前。見せないアイデアも数える）
 */
export function buildAddIdeas(raw: AppData, view: AppData, input: AddIdeasInput, ctx: IdeaWriteContext): IdeaAddBuild {
  const fail = (error: string, candidates?: string[]): IdeaAddBuild => ({
    ok: false,
    error,
    ...(candidates ? { candidates } : {}),
    titleId: null,
    place: '',
    titleName: '',
    records: [],
    items: [],
  })
  const x: AddIdeasInput = input && typeof input === 'object' ? input : {}
  let title: Title | null = null
  if (x.title_id !== undefined) {
    if (typeof x.title_id !== 'string' || !x.title_id.trim())
      return fail('title_id が空です（ホームのアイデアに入れる時は省いてください）')
    const r = resolveTitle(view, x.title_id)
    if (!r.ok)
      return fail(
        `${r.message}（Claude に見せていないタイトルは使えません。アプリのタイトル画面の「Claude に見せる」を確かめてください）`,
        r.candidates,
      )
    if (!canClaudeWrite(r.value))
      return fail(
        `タイトル『${titleName(r.value)}』は「Claude に見せる」が「読むだけ」なので書き込めません（アプリのタイトル画面で「読む＋書き込む」にすると書き込めます。ホームのアイデアに入れる時は、作者に確かめてから title_id を省いて送ってください）`,
      )
    title = r.value
  }
  const items = x.items
  if (!Array.isArray(items) || !items.length) return fail('items がありません（足すアイデアを1件以上渡してください）')
  if (items.length > IDEA_LIMITS.perCall)
    return fail(`1回に足せるアイデアは${IDEA_LIMITS.perCall}件までです（いま ${items.length}件。分けて呼んでください）`)
  const section = title ? title.id : null
  const model = modelOf(x.model)
  const day = jstDate(ctx.now)
  const out: IdeaAddItem[] = []
  /** 足すアイデア（入力の順。並びの位置は後で決める） */
  const made: { item: IdeaAddItem; record: Idea }[] = []
  const seen = new Set<ID>()
  items.forEach((it, index) => {
    const bad = (hint: string) => out.push({ index, status: 'invalid', label: `アイデア（${index + 1}件目）`, hint })
    const o = it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null
    if (!o) return bad('アイデアの形が違います（name と content のオブジェクトにしてください）')
    if (o.name !== undefined && o.name !== null && typeof o.name !== 'string') return bad('name は文字列にしてください')
    const name = normalizeIdeaName(typeof o.name === 'string' ? o.name : '')
    if (typeof o.content !== 'string') return bad('content がありません')
    const content = normalizeIdeaText(o.content)
    if (!content) return bad('content が空です')
    const chars = charCount(content)
    if (chars > IDEA_LIMITS.content)
      return bad(`content は${fmt(IDEA_LIMITS.content)}字までです（いま ${fmt(chars)}字）。${splitHint(chars)}`)
    // 行の番号はカードと同じ（1行目は日付と時刻・名前、2行目から中身）
    const md = ideaMarkdownLines(`${name}\n${content}`)
    if (md.length) return bad(markdownHint(md))
    const body = claudeIdeaBody(ctx.now, name, content)
    const id = claudeIdeaId(section, day, name, content)
    const label = `「${ideaHeadLine({ heading: '', body }, 40)}」`
    if (ctx.wasDeleted('ideas', id)) {
      out.push({ index, status: 'previously_deleted', id, label, hint: IDEA_ADD_HINTS.previously_deleted })
      return
    }
    // 見せないタイトルへ移したアイデアも raw で見る（中身は出さず、入力から作った表記だけを返す）。Claude に見えているカードなら、
    // そのカードの1行目と i:…（作った時刻は、送り直した時刻ではなく、もうあるカードのもの）
    if (Object.prototype.hasOwnProperty.call(raw.ideas, id) || seen.has(id)) {
      const known = Object.prototype.hasOwnProperty.call(view.ideas, id) ? view.ideas[id] : undefined
      out.push(
        known && isClaudeIdea(known)
          ? {
              index,
              status: 'duplicate',
              id,
              label: `「${ideaHeadLine(known, 40)}」`,
              hint: IDEA_ADD_HINTS.duplicate,
              existing: true,
            }
          : { index, status: 'duplicate', id, label, hint: IDEA_ADD_HINTS.duplicate },
      )
      return
    }
    seen.add(id)
    const record: Idea = {
      id,
      titleId: section,
      heading: '',
      body,
      checked: false,
      checkedAt: null,
      order: 0,
      source: 'claude',
      v: IDEA_RECORD_VERSION,
      ...(model ? { model } : {}),
      claudeHash: hashJson(body),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }
    const item: IdeaAddItem = { index, status: 'created', id, label }
    out.push(item)
    made.push({ item, record })
  })
  // 並びの位置: その場所の済みでないアイデアの最小の order から、足す数だけ前（入力の順）。大きさは決めた位置で確かめる
  const open = Object.values(raw.ideas).filter(
    (i) => i.titleId === section && !isIdeaChecked(i) && typeof i.order === 'number' && Number.isFinite(i.order),
  )
  const top = open.length ? Math.min(...open.map((i) => i.order)) : 0
  const place = (list: typeof made) => list.forEach((m, j) => (m.record.order = top - list.length + j))
  place(made)
  const fits = made.filter((m) => {
    const length = stableStringify(m.record).length
    if (length <= IDEA_LIMITS.recordJson) return true
    m.item.status = 'invalid'
    m.item.id = undefined
    m.item.hint = `アイデアが大きすぎます（1件は JSON にして ${fmt(IDEA_LIMITS.recordJson)}字まで。いま ${fmt(length)}字）。${splitHint(charCount(m.record.body))}`
    return false
  })
  if (fits.length !== made.length) place(fits)
  return {
    ok: true,
    titleId: section,
    place: ideaPlaceLabel(view.titles, { titleId: section }),
    titleName: title ? titleName(title) : '',
    records: fits.map((m) => ({ table: 'ideas' as const, record: m.record })),
    items: out.sort((a, b) => a.index - b.index),
  }
}

// ---------- アイデアに追記（novel_append_to_idea） ----------

export interface AppendIdeaInput {
  /** 追記するアイデア（i:…） */
  idea_id?: unknown
  /** 読んだ印（novel_get_notes の本文の見出しの「印: 」の後ろの8字。「印: …」のまま・英大文字でもよい。normalizeReadMark） */
  read_mark?: unknown
  content?: unknown
}

/**
 * 結果。created = 依頼を作る、pending = 同じ依頼がもう出ている（書かない）、applied = 同じ依頼をもうアプリが足した（書かない）、
 * stale = 読んだ後に中身が変わった、not_claude = 作者が書いたアイデア、not_writable = 「読む＋書き込む」でないタイトルのアイデア、
 * pending_trash = ゴミ箱へ移す依頼中、in_trash = ゴミ箱にある、not_found = 見つからない（作者が書いたホームのアイデア・見せない
 * タイトルのアイデアも同じ）、ambiguous = 短い id が何枚にも当たる、too_long = 足すと1枚が長くなりすぎる、invalid = 形が違う
 */
export type IdeaAppendItemStatus =
  | 'created'
  | 'pending'
  | 'applied'
  | 'stale'
  | 'not_claude'
  | 'not_writable'
  | 'pending_trash'
  | 'in_trash'
  | 'not_found'
  | 'ambiguous'
  | 'too_long'
  | 'invalid'

export interface IdeaAppendBuild {
  status: IdeaAppendItemStatus
  /** 入力のまま（短く切る） */
  ref: string
  /** 指したアイデア（見つかった時） */
  ideaId?: ID
  /** 「「2026/11/12 14:32　第3章の動機」（ホームのアイデア）」 */
  label?: string
  hint?: string
  candidates?: string[]
  /** 作る依頼・もう出ている依頼（created・pending）と、その id（applied も） */
  request?: IdeaAppend
  requestId?: ID
  /** 足す内容（そろえた後） */
  text?: string
  records: { table: 'ideaAppends'; record: IdeaAppend }[]
}

/** 追記できる時の印の行・答えの表記（「「1行目」（場所）」） */
function ideaLabel(view: AppData, idea: Idea): string {
  return `「${ideaHeadLine(idea, 40)}」（${ideaPlaceLabel(view.titles, idea)}）`
}

export const IDEA_APPEND_HINTS = {
  stale:
    '読んだ後にこのアイデアの中身が変わりました（作者がアプリで直した・ほかの追記が入った）。novel_get_notes で読み直し、今の中身を踏まえて書いてから、新しい印（本文の見出しの「印: 」の後ろの8字）を read_mark に渡して送ってください',
  read_mark_missing:
    'read_mark がありません（novel_get_notes で今の中身を読み、本文の見出しの「印: 」の後ろの8字を渡してください）',
  read_mark_format:
    'read_mark の形が違います（novel_get_notes（kind=ideas・ids にこの id）の本文の見出しの「印: 」の後ろの8字を渡してください。例 1i30lfcq）',
  not_claude: '作者が書いたアイデアには追記できません（追記できるのは、Claude がこのコネクタで作ったアイデアだけ）',
  pending_trash: 'ゴミ箱へ移す依頼の出ているアイデアです（追記できません）',
  in_trash: 'アプリのゴミ箱にあります（作者がゴミ箱から戻すと追記できます）',
  not_found:
    '見つかりません（novel_get_notes の kind=ideas で id を確かめてください。作者が書いたホームのアイデアと「見せない」タイトルのアイデアは見えません）',
  ambiguous: '短い id が何枚ものアイデアに当たります（id を長く指定してください）',
} as const

/**
 * アイデアに追記する依頼を作る。指せるのは Claude に見せているアイデアだけ（view。追記の依頼を当てた形）。
 * 同じ内容をもう一度送っても増えない（依頼の id は、アイデア・読んだ印・内容から作る。読んだ印を確かめる前に見る）
 */
export function buildIdeaAppend(raw: AppData, view: AppData, input: AppendIdeaInput, ctx: IdeaWriteContext): IdeaAppendBuild {
  const x: AppendIdeaInput = input && typeof input === 'object' ? input : {}
  const rawRef = typeof x.idea_id === 'string' ? x.idea_id.trim() : ''
  const ref = cut(rawRef || String(x.idea_id ?? ''), IDEA_LIMITS.ref)
  const refuse = (status: IdeaAppendItemStatus, hint: string, more: Partial<IdeaAppendBuild> = {}): IdeaAppendBuild => ({
    status,
    ref,
    hint,
    records: [],
    ...more,
  })
  if (!rawRef || charCount(rawRef) > IDEA_LIMITS.ref) return refuse('invalid', 'idea_id の形が違います（i:… を渡してください）')
  if (typeof x.read_mark !== 'string' || !x.read_mark.trim()) return refuse('invalid', IDEA_APPEND_HINTS.read_mark_missing)
  if (typeof x.content !== 'string') return refuse('invalid', 'content がありません')
  // 「印: 1i30lfcq」・全角のコロン・英大文字でも、印の8字にそろえる（依頼の id と読んだ印の比べ方はそろえた後の印で。形は下で確かめる）
  const mark = charCount(x.read_mark) > IDEA_LIMITS.mark ? '' : normalizeReadMark(x.read_mark)
  const hits = Object.values(view.ideas).filter((i) => matchesId('idea', rawRef, i.id))
  if (hits.length > 1)
    return refuse('ambiguous', IDEA_APPEND_HINTS.ambiguous, {
      candidates: hits.slice(0, 10).map((i) => `${shortId('idea', i.id)} ${ideaLabel(view, i)}`),
    })
  if (!hits.length) {
    if (liveTrashRequests(raw).some((r) => r.table === 'ideas' && matchesId('idea', rawRef, r.targetId)))
      return refuse('pending_trash', IDEA_APPEND_HINTS.pending_trash)
    const trashed = Object.values(raw.trashRecords).some((r) => {
      const id = (r.record as { id?: unknown } | undefined)?.id
      return r.table === 'ideas' && typeof id === 'string' && isTrashedClaudeIdea(r.record) && matchesId('idea', rawRef, id)
    })
    return trashed ? refuse('in_trash', IDEA_APPEND_HINTS.in_trash) : refuse('not_found', IDEA_APPEND_HINTS.not_found)
  }
  const idea = hits[0]
  const found = { ideaId: idea.id, label: ideaLabel(view, idea) }
  if (!isClaudeIdea(idea)) return refuse('not_claude', IDEA_APPEND_HINTS.not_claude, found)
  if (!ideaSectionWritable(view.titles, idea)) {
    const t = view.titles[idea.titleId ?? '']
    return refuse(
      'not_writable',
      `タイトル『${t ? titleName(t) : ''}』は「Claude に見せる」が「読むだけ」なので追記できません（作者がタイトル画面で「読む＋書き込む」にすると追記できます）`,
      found,
    )
  }
  const text = normalizeIdeaText(x.content)
  if (!text) return refuse('invalid', 'content が空です', found)
  const chars = charCount(text)
  if (chars > IDEA_LIMITS.appendText)
    return refuse(
      'invalid',
      `content は${fmt(IDEA_LIMITS.appendText)}字までです（いま ${fmt(chars)}字。分けて追記してください）`,
      found,
    )
  const md = ideaMarkdownLines(text)
  if (md.length) return refuse('invalid', markdownHint(md), found)
  // 印の形が違う（8字の英小文字と数字でない）: 中身が変わったのではないので、読み直しではなく形を直すように答える
  if (!READ_MARK.test(mark)) return refuse('invalid', IDEA_APPEND_HINTS.read_mark_format, found)
  // 同じ依頼（同じアイデア・読んだ印・内容）。読んだ印を確かめる前に見る（送り直しは、当てた後の印が変わっていても同じ答え）
  const rawIdea = Object.prototype.hasOwnProperty.call(raw.ideas, idea.id) ? raw.ideas[idea.id] : undefined
  const applied = new Set(rawIdea ? appendIdsOf(rawIdea) : [])
  let id: ID | null = null
  for (let g = 1; g <= MAX_GENERATION; g++) {
    const candidate = ideaAppendId(idea.id, mark, text, g)
    if (Object.prototype.hasOwnProperty.call(raw.ideaAppends ?? {}, candidate)) {
      const request = raw.ideaAppends[candidate]
      return { status: 'pending', ref, ...found, request, requestId: candidate, text, records: [] }
    }
    if (applied.has(candidate)) return { status: 'applied', ref, ...found, requestId: candidate, text, records: [] }
    // アプリが当てずに消した依頼（削除の印だけ残る）: 次の番号で頼み直す
    if (ctx.wasDeleted('ideaAppends', candidate)) continue
    id = candidate
    break
  }
  if (!id)
    return refuse('invalid', 'このアイデアには、もうこの内容で頼み直せません（作者にアプリで直してもらってください）', found)
  if (mark !== ideaReadMark(idea.body)) return refuse('stale', IDEA_APPEND_HINTS.stale, found)
  const nextBody = appendedBody(idea.body, { createdAt: ctx.now, text })
  if (charCount(nextBody) > IDEA_LIMITS.body)
    return refuse(
      'too_long',
      `カードが長くなりすぎます（1枚 ${fmt(IDEA_LIMITS.body)}字まで。いま ${fmt(charCount(idea.body))}字・追記 ${fmt(chars)}字）。新しいアイデアとして novel_add_ideas で足してください`,
      found,
    )
  const record: IdeaAppend = {
    id,
    ideaId: idea.id,
    text,
    readMark: mark,
    source: 'claude',
    v: IDEA_APPEND_VERSION,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
  const length = stableStringify(record).length
  if (length > IDEA_LIMITS.appendJson)
    return refuse(
      'invalid',
      `追記の依頼が大きすぎます（1件は JSON にして ${fmt(IDEA_LIMITS.appendJson)}字まで。いま ${fmt(length)}字。分けて追記してください）`,
      found,
    )
  return {
    status: 'created',
    ref,
    ...found,
    request: record,
    requestId: id,
    text,
    records: [{ table: 'ideaAppends', record }],
  }
}
