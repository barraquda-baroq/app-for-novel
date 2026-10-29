// 読むツール（R1〜R9）の結果の文字の形。目次・採用原稿・検索はアプリの手動連携と同じ src/claude/view.ts を使う。
// ここで見るデータは、いつも見せる内容（claudeView: 見せないタイトル・ゴミ箱・応募時の原稿の控えなどを除いたもの）。
import { proofCategoryLabel, isProofCategory } from '../../../../src/claude/categories'
import { jstDate, shortDate } from '../../../../src/claude/dates'
import { reanchor } from '../../../../src/claude/anchor'
import {
  critiquePromptsOf,
  critiqueResultsOf,
  proofCoverage,
  proofRunsOf,
  proofSuggestionsOf,
  revisionIdeasOf,
  strategyNotesOf,
} from '../../../../src/claude/order'
import { matchesId, pieceRefLabel, readingOrder, resolvePiece, shortId, type ReadingItem } from '../../../../src/claude/refs'
import { manuscriptLabel, manuscriptOf } from '../../../../src/claude/snapshot'
import {
  cutPoint,
  decodeCursor,
  encodeCursor,
  outlineView,
  readTextView,
  searchTextView,
  titleHeadline,
} from '../../../../src/claude/view'
import { claudeAccessLabel, claudeAccessOf, isNewerRecord, NEWER_RECORD_LABEL } from '../../../../src/claude/visibility'
import {
  categoriesOf,
  entriesOf,
  memosOf,
  sortedTitles,
  submissionStatusLabel,
  submissionsOf,
  titleLastEdited,
  titleSummary,
} from '../../../../src/domain/entityOps'
import { actParts, adoptedMetrics, isSplit, pieceFullLabel, pieceLabel } from '../../../../src/domain/structure'
import {
  SUBMISSION_TEXT,
  SUBMISSION_TEXT_FIELDS,
  submissionExtraLines,
  submissionTextStatus,
  textLimitRange,
} from '../../../../src/domain/submissionTexts'
import { bodyMetrics, formatCount } from '../../../../src/domain/text'
import type { AppData, ID, Piece, ProofSuggestion, Submission, Title } from '../../../../src/domain/types'
import { bool, fail, head, itemBudget, length, num, ok, pageBody, str, strList, titleArg, type ToolResult } from './common'

export type { ToolResult }

export interface ReadContext {
  /** 見せる内容（claudeView） */
  view: AppData
  now: number
  /** 呼び出したクライアント（Claude Code なら本文の既定の文字数を減らす） */
  client?: string
  /** 1回に調べる本文の文字数の上限（検索） */
  workBudget: number
}

type Args = Record<string, unknown>

const isClaudeCode = (client?: string) => Boolean(client && /claude[-_ ]?code/i.test(client))

// ---------- R1 タイトル一覧 ----------

export function listTitles(ctx: ReadContext, hiddenCount: number): ToolResult {
  const titles = sortedTitles(ctx.view)
  const lines: string[] = [`=== Claude に見せているタイトル（${titles.length}件） ===`]
  if (!titles.length) lines.push('（ありません。アプリのタイトル画面の「Claude に見せる」で、見せるタイトルを選んでください）')
  for (const t of titles) {
    lines.push(titleHeadline(ctx.view, t))
    const openProof = Object.values(ctx.view.proofSuggestions).filter((s) => s.titleId === t.id && !s.done).length
    const openIdeas = Object.values(ctx.view.revisionIdeas).filter((r) => r.titleId === t.id && !r.checked).length
    const notes = Object.values(ctx.view.strategyNotes).filter((n) => n.titleId === t.id).length
    const latest = critiqueResultsOf(ctx.view, t.id)[0]
    const edited = titleLastEdited(ctx.view, t.id)
    lines.push(
      `  Claude: ${claudeAccessLabel(claudeAccessOf(t))}・最終更新 ${edited ? jstDate(edited) : '―'}・推敲案 未チェック ${openProof}件・改稿案 未チェック ${openIdeas}件・戦略メモ ${notes}件・作品批評 ${latest ? `最新 ${latest.runDate}` : 'なし'}`,
    )
  }
  if (hiddenCount > 0) lines.push(`（Claude に見せていないタイトルが ${hiddenCount}件あります）`)
  return ok(lines.join('\n'))
}

// ---------- R2 目次 ----------

export function getOutline(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const r = outlineView(ctx.view, t.title.id, {
    chapter: str(args.chapter),
    from: str(args.from),
    to: str(args.to),
    includeActs: bool(args.include_acts) ?? true,
    format: args.response_format === 'detailed' ? 'detailed' : 'concise',
    cursor: str(args.cursor),
  })
  return r.ok ? ok(r.text) : fail(r.error, r.candidates)
}

// ---------- R3 採用原稿 ----------

export function readText(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const budget = num(args.char_budget) ?? (isClaudeCode(ctx.client) ? 12_000 : 20_000)
  const r = readTextView(ctx.view, t.title.id, {
    chapter: str(args.chapter),
    from: str(args.from),
    to: str(args.to),
    pieces: strList(args.pieces),
    versionId: str(args.version_id),
    cursor: str(args.cursor),
    charBudget: budget,
    ruby: args.ruby === 'strip' ? 'strip' : 'raw',
  })
  return r.ok ? ok(r.text) : fail(r.error, r.candidates)
}

// ---------- R4 稿の一覧 ----------

/** 話の表記（「#12 第12話」「#12.2 第12話 第2幕」）。並びに無ければ控えの表記 */
function locationOf(view: AppData, order: readonly ReadingItem[], pieceId: ID, fallback = ''): string {
  const piece = view.pieces[pieceId]
  if (!piece) return fallback ? `${fallback}（いまは見つかりません）` : '（話が見つかりません）'
  if (piece.kind === 'act' && piece.parentId) {
    const item = order.find((x) => x.piece.id === piece.parentId)
    const n = item ? (item.piece.actIds ?? []).indexOf(piece.id) + 1 : 0
    return item ? `#${item.index}.${n} ${item.label} ${pieceLabel(view, piece)}` : pieceFullLabel(view, piece)
  }
  const item = order.find((x) => x.piece.id === piece.id)
  return item ? `#${item.index} ${item.label}` : pieceFullLabel(view, piece)
}

function versionLine(view: AppData, piece: Piece, versionId: ID): string[] {
  const v = view.versions[versionId]
  if (!v) return []
  const adopted = piece.activeVersionId === v.id
  const conflict = /（競合[:：]/.test(v.name)
  const out = [
    `${adopted ? '*' : '-'} ${v.name.trim() || '（名前のない稿）'} [${shortId('version', v.id)}] ${formatCount(bodyMetrics(v).chars)}字 作成 ${jstDate(v.createdAt)} 更新 ${jstDate(v.updatedAt)}${adopted ? ' 採用中' : ''}${conflict ? ' 同期の競合で残した稿' : ''}`,
  ]
  if (v.note.trim()) out.push(`  推敲メモ: ${head(v.note, 60)}`)
  return out
}

export function listVersions(ctx: ReadContext, args: Args): ToolResult {
  const ref = str(args.piece)
  if (!ref) return fail('piece がありません（#12・p:… など）')
  let piece: Piece | undefined
  if (args.title_id !== undefined) {
    const t = titleArg(ctx.view, args.title_id)
    if ('error' in t) return t.error
    const r = resolvePiece(ctx.view, t.title.id, ref)
    if (!r.ok) return fail(r.message, r.candidates)
    piece = r.value
  } else {
    const hits = Object.values(ctx.view.pieces).filter((p) => matchesId('piece', ref, p.id))
    if (hits.length === 1) piece = hits[0]
    else if (hits.length > 1)
      return fail(
        `'${ref}' に当たる話が${hits.length}つあります。もっと長い id か title_id を付けてください`,
        hits.slice(0, 10).map((p) => pieceRefLabel(ctx.view, p)),
      )
    else {
      const titles = sortedTitles(ctx.view)
      if (titles.length !== 1)
        return fail(`'${ref}' は title_id と一緒に指定してください（#12・「第12話」はタイトルごとの番号のため）`)
      const r = resolvePiece(ctx.view, titles[0].id, ref)
      if (!r.ok) return fail(r.message, r.candidates)
      piece = r.value
    }
  }
  const view = ctx.view
  const order = readingOrder(view, piece.titleId)
  const lines: string[] = []
  const own = piece.versionIds.filter((id) => view.versions[id])
  lines.push(`=== ${pieceRefLabel(view, piece, order)} の稿（全${own.length}稿）===`)
  if (isSplit(piece)) {
    const parts = actParts(view, piece)
    lines.push(`幕に分けた話（${parts.length}幕）。採用原稿は各幕の採用稿をつないだもの:`)
    for (const p of parts) {
      const all = p.act.versionIds.filter((id) => view.versions[id]).length
      lines.push(
        `  #${order.find((x) => x.piece.id === piece!.id)?.index ?? '?'}.${p.number} 第${p.number}幕 [${shortId('piece', p.act.id)}] ${
          p.version
            ? `採用: ${p.version.name.trim() || '（名前のない稿）'} [${shortId('version', p.version.id)}] ${formatCount(bodyMetrics(p.version).chars)}字`
            : '採用原稿なし'
        }（全${all}稿。幕の稿は piece に幕を指定して見る）`,
      )
    }
    if (own.length) lines.push('分ける前の話自身の稿（幕に分けている間は変えられない）:')
  }
  for (const id of own) lines.push(...versionLine(view, piece, id))
  if (!own.length && !isSplit(piece)) lines.push('（稿がありません）')
  lines.push('稿の本文は novel_read_text の version_id で読めます。')
  return ok(lines.join('\n'))
}

// ---------- R5 検索 ----------

export function searchText(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const r = searchTextView(ctx.view, t.title.id, {
    query: typeof args.query === 'string' ? args.query : '',
    mode: args.mode === 'regex' ? 'regex' : 'literal',
    scope: args.scope === 'all_versions' ? 'all_versions' : 'adopted',
    from: str(args.from),
    to: str(args.to),
    contextChars: num(args.context_chars),
    maxHits: num(args.max_hits),
    countOnly: bool(args.count_only) ?? false,
    cursor: str(args.cursor),
    workBudget: ctx.workBudget,
  })
  return r.ok ? ok(r.text) : fail(r.error, r.candidates)
}

// ---------- R6 設定・メモ・アイデア ----------

interface NoteItem {
  id: ID
  ref: string
  name: string
  /** 一覧の1行 */
  line: string
  /** 本文の形 */
  full: () => string
}

function noteItems(view: AppData, title: Title, kind: 'settings' | 'memos' | 'ideas'): NoteItem[] {
  if (kind === 'memos')
    return memosOf(view, title.id).map((m) => ({
      id: m.id,
      ref: shortId('memo', m.id),
      name: m.name,
      line: `${shortId('memo', m.id)} ${m.name.trim() || '（無題のメモ）'}（${formatCount(length(m.body))}字）${m.body.trim() ? `: ${head(m.body)}` : ''}`,
      full: () => `=== メモ: ${m.name.trim() || '（無題のメモ）'} [${shortId('memo', m.id)}] ===\n${m.body}`,
    }))
  if (kind === 'ideas')
    return Object.values(view.ideas)
      .filter((i) => i.titleId === title.id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((i) => ({
        id: i.id,
        ref: shortId('idea', i.id),
        name: i.heading,
        line: `${shortId('idea', i.id)} ${i.heading.trim() || '（見出しなし）'}（${formatCount(length(i.body))}字）${i.body.trim() ? `: ${head(i.body)}` : ''}`,
        full: () => `=== アイデア: ${i.heading.trim() || '（見出しなし）'} [${shortId('idea', i.id)}] ===\n${i.body}`,
      }))
  const out: NoteItem[] = []
  for (const c of categoriesOf(view, title.id)) {
    for (const e of entriesOf(view, c.id)) {
      const fields = e.fields.filter((f) => f.key.trim() || f.value.trim())
      out.push({
        id: e.id,
        ref: shortId('settingEntry', e.id),
        name: e.name,
        line: `${shortId('settingEntry', e.id)} ${c.name.trim() || '（無題の項目）'} / ${e.name.trim() || '（無題）'}（フィールド${fields.length}・本文 ${formatCount(length(e.body))}字）${fields[0] ? `: ${head(`${fields[0].key}: ${fields[0].value}`, 40)}` : ''}`,
        full: () =>
          [
            `=== 設定: ${c.name.trim() || '（無題の項目）'} / ${e.name.trim() || '（無題）'} [${shortId('settingEntry', e.id)}] ===`,
            ...fields.map((f) => `${f.key.trim() || '（名前なし）'}: ${f.value}`),
            ...(e.body.trim() ? [e.body] : []),
          ].join('\n'),
      })
    }
  }
  return out
}

export function getNotes(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const kind = args.kind === 'settings' || args.kind === 'memos' || args.kind === 'ideas' ? args.kind : null
  if (!kind) return fail("kind は 'settings'・'memos'・'ideas' のどれかにしてください")
  const kindLabel = kind === 'settings' ? '設定項目' : kind === 'memos' ? 'メモ' : 'アイデア'
  const items = noteItems(ctx.view, t.title, kind)
  const budget = Math.min(60_000, Math.max(2_000, num(args.char_budget) ?? 20_000))
  let ids = strList(args.ids) ?? []
  let full = bool(args.full) ?? false
  let start = 0
  /** 続きから読む項目（start）の中の位置（長い1つの項目を何回かに分けて読む時） */
  let off0 = 0
  const cursorArg = str(args.cursor)
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    if (!c || c.k !== 'notes' || c.t !== t.title.id || c.kind !== kind || typeof c.s !== 'number')
      return fail('cursor が読めません（novel_get_notes の続きの cursor をそのまま渡してください）')
    start = c.s
    off0 = typeof c.o === 'number' && c.o > 0 ? c.o : 0
    ids = Array.isArray(c.ids) ? (c.ids as string[]) : []
    full = c.full === true
  }
  if (!ids.length && !full) {
    const lines = [`=== 『${t.title.name}』の${kindLabel}（${items.length}件）[${shortId('title', t.title.id)}] ===`]
    if (!items.length) lines.push('（ありません）')
    for (const it of items) lines.push(it.line)
    if (items.length) lines.push('本文は ids に短い id を入れるか full=true で読めます。')
    return ok(lines.join('\n'))
  }
  let chosen = items
  if (ids.length) {
    const missing: string[] = []
    chosen = []
    for (const ref of ids) {
      const idKind = kind === 'settings' ? 'settingEntry' : kind === 'memos' ? 'memo' : 'idea'
      const hit =
        items.find((it) => matchesId(idKind, ref, it.id)) ?? items.find((it) => it.name.trim() === ref.trim())
      if (hit && !chosen.includes(hit)) chosen.push(hit)
      else if (!hit) missing.push(ref)
    }
    if (!chosen.length) return fail(`${kindLabel}が見つかりません: ${missing.join('、')}`, items.slice(0, 20).map((i) => i.line))
  }
  const out: string[] = []
  let used = 0
  let i = start
  for (; i < chosen.length; i++) {
    const text = chosen[i].full()
    // 前のページの続き（項目が変わって短くなっていれば、その終わりまで）
    const from = i === start ? Math.min(off0, text.length) : 0
    if (from > 0) out.push(`=== ${kindLabel}の続き [${chosen[i].ref}]（${formatCount(from)}字目から）===`)
    const rest = text.length - from
    if (used > 0 && used + rest > budget) break
    if (used === 0 && rest > budget) {
      // 1つの項目が長い: 段落の切れ目で分け、残りは同じ項目の続きの cursor で読む
      let end = cutPoint(text, from, from + budget)
      if (end <= from) end = Math.min(text.length, from + budget)
      out.push(text.slice(from, end))
      const next = encodeCursor({ k: 'notes', t: t.title.id, kind, s: i, o: end, ids, full })
      out.push(`続き: cursor="${next}"（この項目の残り ${formatCount(text.length - end)}字・残り${chosen.length - i}件）`)
      return ok(out.join('\n'))
    }
    out.push(from > 0 ? text.slice(from) : text)
    used += rest
  }
  if (i < chosen.length) {
    const next = encodeCursor({ k: 'notes', t: t.title.id, kind, s: i, ids, full })
    out.push(`続き: cursor="${next}"（残り${chosen.length - i}件）`)
  }
  return ok(out.join('\n'))
}

// ---------- R7 戦略 ----------

const today = (now: number) => jstDate(now)

/** 一覧に出す全体戦略の長さ（長ければ section="overall" で全文を読む） */
const OVERALL_HEAD = 20_000

function overallHead(text: string): string {
  if (text.length <= OVERALL_HEAD) return text
  let end = cutPoint(text, 0, OVERALL_HEAD)
  if (end <= 0) end = OVERALL_HEAD
  return `${text.slice(0, end)}\n[...]（長いため、ここまで。全文は section="overall" で読めます）`
}

function daysUntil(todayIso: string, deadline: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000)
}

function deadlineText(todayIso: string, deadline: string): string {
  if (!deadline) return '締切 未定'
  const d = daysUntil(todayIso, deadline)
  if (d === null) return `締切 ${deadline}`
  return `締切 ${deadline}（${d > 0 ? `あと${d}日` : d === 0 ? '今日' : `${-d}日前に過ぎました`}）`
}

function titlePages(view: AppData, titleId: ID): number {
  let pages = 0
  for (const item of readingOrder(view, titleId)) pages += adoptedMetrics(view, item.piece)?.manuscriptPages ?? 0
  return pages
}

function limitText(s: Submission, chars: number, pages: number): string {
  if (s.minChars === null && s.maxChars === null) return '規定 未設定'
  const pagesUnit = s.limitUnit === 'pages'
  const unit = pagesUnit ? '枚' : '字'
  const cur = pagesUnit ? pages : chars
  const range = `${s.minChars !== null ? formatCount(s.minChars) : ''}〜${s.maxChars !== null ? formatCount(s.maxChars) : ''}${unit}`
  let check = '規定内'
  if (s.minChars !== null && cur < s.minChars) check = `下限まで あと${formatCount(s.minChars - cur)}${unit}`
  else if (s.maxChars !== null && cur > s.maxChars) check = `上限を ${formatCount(cur - s.maxChars)}${unit}超えています`
  return `規定 ${range}（いま ${formatCount(cur)}${unit}・${check}）`
}

/**
 * 1つの応募計画を全文で読む時の、後から足した項目（規定の備考・提出する梗概／キャッチコピーと文字数・規定の判定・特記事項）。
 * 古いデータには無い。書いていない項目（梗概・キャッチコピーは規定も無いもの）は出さない
 */
function submissionExtrasFull(x: Submission): string[] {
  const out: string[] = []
  if ((x.limitNote ?? '').trim()) out.push(`--- 規定の備考 ---\n${x.limitNote}`)
  for (const field of SUBMISSION_TEXT_FIELDS) {
    const st = submissionTextStatus(x, field)
    if (!st.text.trim() && !st.check) continue
    const limit = st.check ? `・規定 ${textLimitRange(st.min, st.max)} → ${st.check.text}` : ''
    out.push(
      `--- 提出する${SUBMISSION_TEXT[field].name} ---`,
      `${formatCount(st.count)}字（空白・改行を除く）${limit}`,
      st.text.trim() ? st.text : '（まだ書いていません）',
    )
  }
  if ((x.specialNotes ?? '').trim()) out.push(`--- 特記事項 ---\n${x.specialNotes}`)
  return out
}

function findBy<T extends { id: ID }>(list: readonly T[], kind: Parameters<typeof shortId>[0], ref: string): T[] {
  return list.filter((x) => matchesId(kind, ref, x.id))
}

/** 1つの項目を全文で読む（長ければ char_budget 字ずつ。続きは cursor に項目の id と位置を入れる） */
function pagedItem(
  ctx: ReadContext,
  args: Args,
  k: 'strategy' | 'critique',
  titleId: ID,
  item: { which: string; id: ID; label: string; text: string },
  offset: number,
): ToolResult {
  const budget = itemBudget(args.char_budget, isClaudeCode(ctx.client))
  return ok(
    pageBody(item.text, {
      offset,
      budget,
      contHeader: (from) => `=== ${item.label}の続き（${formatCount(from)}字目から）===`,
      cursor: (o) => encodeCursor({ k, t: titleId, which: item.which, id: item.id, o }),
    }),
  )
}

/** 続きの cursor（1つの項目の続き）を読む。無ければ null、違う形なら 'bad' */
function itemCursor(args: Args, k: 'strategy' | 'critique', titleId: ID): { which: string; id: string; o: number } | null | 'bad' {
  const raw = str(args.cursor)
  if (!raw) return null
  const c = decodeCursor(raw)
  if (!c || c.k !== k || c.t !== titleId || typeof c.which !== 'string' || typeof c.id !== 'string' || typeof c.o !== 'number')
    return 'bad'
  return { which: c.which, id: c.id, o: c.o }
}

/** 戦略・作品批評の一覧に、中身の頭まで出す数（それより後は id と見出しだけ） */
const LIST_NOTES = 30
const LIST_IDEAS = 60
const LIST_RESULTS = 60

export function getStrategy(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const view = ctx.view
  const title = t.title
  const day = today(ctx.now)
  const s = titleSummary(view, title.id)
  const pages = titlePages(view, title.id)
  const notes = strategyNotesOf(view, title.id)
  const ideas = revisionIdeasOf(view, title.id)
  const subs = submissionsOf(view, title.id)
  const order = readingOrder(view, title.id)
  const pieceNames = (ids: ID[]) =>
    ids
      .map((id) => (view.pieces[id] ? locationOf(view, order, id) : null))
      .filter(Boolean)
      .join('・')

  type StrategyItem = 'submission' | 'strategyNote' | 'revisionIdea' | 'overall'
  /** 1つの項目の全文（見出し・本文） */
  const itemText = (kind: StrategyItem, id: ID): { label: string; text: string } | null => {
    if (kind === 'overall')
      return {
        label: '全体戦略',
        text: `=== 『${title.name}』の全体戦略（タイトルのメモ）[${shortId('title', title.id)}] ===\n${title.strategyNote.trim() ? title.strategyNote : '（まだありません）'}`,
      }
    if (kind === 'submission') {
      const x = subs.find((v) => v.id === id)
      if (!x) return null
      return {
        label: `応募計画「${x.contestName.trim() || '（名前なし）'}」`,
        text: [
          `=== 応募計画「${x.contestName.trim() || '（名前なし）'}」[${shortId('submission', x.id)}] ===`,
          `主催: ${x.organizer || '―'} / 状態: ${submissionStatusLabel(x.status)}${x.stage ? `（${x.stage}）` : ''} / ${deadlineText(day, x.deadline)}`,
          `URL: ${x.url || '―'} / 応募日: ${x.submittedOn || '―'} / 結果の日: ${x.resultOn || '―'}`,
          limitText(x, s.activeChars, pages),
          `--- 概要 ---\n${x.overview || '（なし）'}`,
          ...submissionExtrasFull(x),
          `--- 結果・講評 ---\n${x.result || '（なし）'}`,
          `--- 改稿方針 ---\n${x.revisionPlan || '（なし）'}`,
          `--- 再応募方針 ---\n${x.resubmissionPlan || '（なし）'}`,
          x.snapshot ? `応募時の原稿の記録: ${jstDate(x.snapshot.at)}・${formatCount(x.snapshot.charCount)}字` : '応募時の原稿の記録: なし',
        ].join('\n'),
      }
    }
    if (kind === 'strategyNote') {
      const n = notes.find((v) => v.id === id)
      if (!n) return null
      return {
        label: `戦略メモ「${n.heading}」`,
        text: [
          `=== 戦略メモ ${n.runDate}「${n.heading}」[${shortId('strategyNote', n.id)}]${n.appliedAt ? '（全体戦略に追記済み）' : ''}${isNewerRecord(n) ? `（${NEWER_RECORD_LABEL}）` : ''} ===`,
          n.body,
          ...(n.contests.length ? ['--- コンテストの候補 ---'] : []),
          ...n.contests.map(
            (c) =>
              `${c.id} ${c.name}${c.organizer ? `（${c.organizer}）` : ''} ${deadlineText(day, c.deadline)}${c.url ? ` ${c.url}` : ''}${c.submissionId ? ' → 応募計画にした' : ''}\n  相性: ${c.fit || '―'}\n  方針: ${c.plan || '―'}`,
          ),
        ].join('\n'),
      }
    }
    const idea = ideas.find((v) => v.id === id)
    if (!idea) return null
    return {
      label: `改稿案「${idea.heading}」`,
      text: [
        `=== 改稿案「${idea.heading}」[${shortId('revisionIdea', idea.id)}]${idea.checked ? '（チェック済み: 実装済み・ボツ）' : ''} ===`,
        idea.pieceIds.length ? `関係する話: ${pieceNames(idea.pieceIds)}` : '',
        idea.body,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  const page = (kind: StrategyItem, id: ID, offset: number): ToolResult => {
    const item = itemText(kind, id)
    if (!item) return fail('続きを読む項目が見つかりません（削除された可能性があります。cursor なしで読み直してください）')
    return pagedItem(ctx, args, 'strategy', title.id, { which: kind, id, ...item }, offset)
  }
  const cont = itemCursor(args, 'strategy', title.id)
  const kinds: readonly string[] = ['submission', 'strategyNote', 'revisionIdea', 'overall']
  if (cont === 'bad' || (cont && !kinds.includes(cont.which)))
    return fail('cursor が読めません（novel_get_strategy の続きの cursor をそのまま渡してください）')
  if (cont) return page(cont.which as StrategyItem, cont.id, cont.o)
  const one = (ref: unknown, kind: 'submission' | 'strategyNote' | 'revisionIdea'): ToolResult | null => {
    const r = str(ref)
    if (!r) return null
    if (kind === 'submission') {
      const hits = findBy(subs, 'submission', r)
      if (hits.length !== 1) return fail(`応募計画 '${r}' が見つかりません`, subs.map((x) => `${shortId('submission', x.id)}「${x.contestName}」`))
      return page(kind, hits[0].id, 0)
    }
    if (kind === 'strategyNote') {
      const hits = findBy(notes, 'strategyNote', r)
      if (hits.length !== 1) return fail(`戦略メモ '${r}' が見つかりません`, notes.map((x) => `${shortId('strategyNote', x.id)}「${x.heading}」`))
      return page(kind, hits[0].id, 0)
    }
    const hits = findBy(ideas, 'revisionIdea', r)
    if (hits.length !== 1) return fail(`改稿案 '${r}' が見つかりません`, ideas.map((x) => `${shortId('revisionIdea', x.id)}「${x.heading}」`))
    return page(kind, hits[0].id, 0)
  }
  const single = one(args.submission_id, 'submission') ?? one(args.note_id, 'strategyNote') ?? one(args.revision_idea_id, 'revisionIdea')
  if (single) return single
  if (args.section === 'overall') return page('overall', title.id, 0)

  const lines: string[] = [
    `=== 『${title.name}』の戦略（今日 ${day}・日本時間）[${shortId('title', title.id)}] ===`,
    `採用原稿 ${formatCount(s.activeChars)}字（原稿用紙${formatCount(pages)}枚）・第n話${s.episodes}・特殊${s.specials}`,
    '--- 全体戦略 ---',
    title.strategyNote.trim() ? overallHead(title.strategyNote) : '（まだありません）',
    `--- 戦略メモ（${notes.length}件。新しい順）---`,
  ]
  for (const n of notes.slice(0, LIST_NOTES))
    lines.push(
      `${shortId('strategyNote', n.id)} ${n.runDate}「${n.heading}」${n.appliedAt ? '（全体戦略に追記済み）' : ''}${n.contests.length ? ` コンテスト${n.contests.length}件: ${n.contests.map((c) => c.name).join('、')}` : ''}\n  ${head(n.body, 80)}`,
    )
  // 入りきらない分も id は出す（note_id で読めるように。見出しだけ）
  if (notes.length > LIST_NOTES)
    lines.push(
      `（ほか${notes.length - LIST_NOTES}件・古いものは見出しだけ）: ${notes
        .slice(LIST_NOTES)
        .map((n) => `${shortId('strategyNote', n.id)} ${n.runDate}「${head(n.heading, 40)}」`)
        .join(' / ')}`,
    )
  const open = ideas.filter((i) => !i.checked)
  lines.push(`--- 改稿案（未チェック ${open.length}件・チェック済み ${ideas.length - open.length}件）---`)
  for (const i of ideas.slice(0, LIST_IDEAS))
    lines.push(
      `${shortId('revisionIdea', i.id)} ${i.checked ? '（チェック済み）' : ''}「${i.heading}」${i.pieceIds.length ? `（${pieceNames(i.pieceIds)}）` : ''}: ${head(i.body, 60)}`,
    )
  if (ideas.length > LIST_IDEAS)
    lines.push(
      `（ほか${ideas.length - LIST_IDEAS}件・見出しだけ。revision_idea_id で全文）: ${ideas
        .slice(LIST_IDEAS)
        .map((i) => `${shortId('revisionIdea', i.id)}${i.checked ? '（チェック済み）' : ''}「${head(i.heading, 40)}」`)
        .join(' / ')}`,
    )
  lines.push(`--- 応募計画（${subs.length}件）---`)
  for (const x of subs)
    lines.push(
      [
        `${shortId('submission', x.id)}「${x.contestName.trim() || '（名前なし）'}」${x.organizer ? `${x.organizer} / ` : ''}${submissionStatusLabel(x.status)} / ${deadlineText(day, x.deadline)} / ${limitText(x, s.activeChars, pages)}`,
        ...(x.overview.trim() ? [`概要: ${head(x.overview, 60)}`] : []),
        ...submissionExtraLines(x, head),
      ].join('\n  '),
    )
  lines.push('1つを全文で読むには submission_id・note_id・revision_idea_id（全体戦略は section="overall"）を指定してください。')
  return ok(lines.join('\n'))
}

// ---------- R8 作品批評 ----------

export function getCritique(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const view = ctx.view
  const title = t.title
  const prompts = critiquePromptsOf(view, title.id)
  const allPrompts = [...prompts.title, ...prompts.shared]
  const results = critiqueResultsOf(view, title.id)
  const current = manuscriptOf(view, title.id, ctx.now)
  const itemText = (which: 'prompt' | 'result', id: ID): { label: string; text: string } | null => {
    if (which === 'prompt') {
      const p = allPrompts.find((x) => x.id === id)
      if (!p) return null
      return {
        label: `批評プロンプト「${p.name}」`,
        text: `=== 批評プロンプト「${p.name}」[${shortId('critiquePrompt', p.id)}]（${p.titleId === null ? '共通' : 'このタイトル'}）===\n${p.body}`,
      }
    }
    const r = results.find((x) => x.id === id)
    if (!r) return null
    return {
      label: `批評の結果 ${r.runDate}「${r.promptName || '（プロンプトなし）'}」`,
      text: [
        `=== 批評の結果 ${r.runDate}「${r.promptName || '（プロンプトなし）'}」[${shortId('critiqueResult', r.id)}]${isNewerRecord(r) ? `（${NEWER_RECORD_LABEL}）` : ''} ===`,
        `範囲: ${r.scope.kind === 'range' ? r.scope.label : 'タイトル全体'} / 原稿: ${r.manuscript ? manuscriptLabel(r.manuscript, current) : '控えなし'}${r.model ? ` / モデル: ${r.model}` : ''}`,
        r.artifactUrl ? `アーティファクト: ${r.artifactUrl}` : '',
        r.note.trim() ? `メモ: ${r.note}` : '',
        '--- 使ったプロンプト ---',
        r.promptText || '（控えなし）',
        '--- 結果 ---',
        r.resultMarkdown || '（Markdown なし。アーティファクトの URL を見てください）',
      ]
        .filter((x) => x !== '')
        .join('\n'),
    }
  }
  const page = (which: 'prompt' | 'result', id: ID, offset: number): ToolResult => {
    const item = itemText(which, id)
    if (!item) return fail('続きを読む項目が見つかりません（削除された可能性があります。cursor なしで読み直してください）')
    return pagedItem(ctx, args, 'critique', title.id, { which, id, ...item }, offset)
  }
  const cont = itemCursor(args, 'critique', title.id)
  if (cont === 'bad' || (cont && cont.which !== 'prompt' && cont.which !== 'result'))
    return fail('cursor が読めません（novel_get_critique の続きの cursor をそのまま渡してください）')
  if (cont) return page(cont.which as 'prompt' | 'result', cont.id, cont.o)
  const pr = str(args.prompt_id)
  if (pr) {
    const hits = allPrompts.filter((p) => matchesId('critiquePrompt', pr, p.id) || p.name.trim() === pr.trim())
    if (hits.length !== 1)
      return fail(`批評プロンプト '${pr}' が見つかりません`, allPrompts.map((p) => `${shortId('critiquePrompt', p.id)}「${p.name}」`))
    return page('prompt', hits[0].id, 0)
  }
  const rr = str(args.result_id)
  if (rr) {
    const hits = results.filter((r) => matchesId('critiqueResult', rr, r.id))
    if (hits.length !== 1)
      return fail(`批評の結果 '${rr}' が見つかりません`, results.map((r) => `${shortId('critiqueResult', r.id)} ${r.runDate}「${r.promptName}」`))
    return page('result', hits[0].id, 0)
  }
  const lines: string[] = [
    `=== 『${title.name}』の作品批評 [${shortId('title', title.id)}] ===`,
    `--- 批評プロンプト（このタイトル ${prompts.title.length}件・共通 ${prompts.shared.length}件）---`,
  ]
  for (const p of allPrompts)
    lines.push(
      `${shortId('critiquePrompt', p.id)}「${p.name}」（${p.titleId === null ? '共通' : 'このタイトル'}・${formatCount(length(p.body))}字）: ${head(p.body, 60)}`,
    )
  if (!allPrompts.length) lines.push('（ありません）')
  lines.push(`--- 批評の結果（${results.length}件。新しい日付から）---`)
  for (const r of results.slice(0, LIST_RESULTS))
    lines.push(
      `${shortId('critiqueResult', r.id)} ${r.runDate}「${r.promptName || '（プロンプトなし）'}」${r.scope.kind === 'range' ? r.scope.label : 'タイトル全体'}・${r.manuscript ? manuscriptLabel(r.manuscript, current) : '原稿の控えなし'}${r.resultMarkdown ? `・Markdown ${formatCount(length(r.resultMarkdown))}字` : ''}${r.artifactUrl ? '・URL あり' : ''}${r.resultMarkdown ? `\n  ${head(r.resultMarkdown, 80)}` : ''}`,
    )
  if (results.length > LIST_RESULTS)
    lines.push(
      `（ほか${results.length - LIST_RESULTS}件・古いものは見出しだけ。result_id で全文）: ${results
        .slice(LIST_RESULTS)
        .map((r) => `${shortId('critiqueResult', r.id)} ${r.runDate}「${head(r.promptName || '（プロンプトなし）', 40)}」`)
        .join(' / ')}`,
    )
  if (!results.length) lines.push('（ありません）')
  lines.push('1つを全文で読むには prompt_id・result_id を指定してください。')
  return ok(lines.join('\n'))
}

// ---------- R9 推敲案 ----------

const PROOF_PAGE = { concise: 100, detailed: 40 }

export function listProofreading(ctx: ReadContext, args: Args): ToolResult {
  const t = titleArg(ctx.view, args.title_id)
  if ('error' in t) return t.error
  const view = ctx.view
  const title = t.title
  const order = readingOrder(view, title.id)
  const status = args.status === 'done' || args.status === 'all' ? args.status : 'open'
  const category = str(args.category)
  if (category && !isProofCategory(category)) return fail(`category '${category}' は使えません`)
  const detailed = args.response_format === 'detailed'
  const all = proofSuggestionsOf(view, title.id)
  // 範囲（読む順の番号。幕は属する話の番号）
  const indexOf = (s: ProofSuggestion): number | null => {
    const p = view.pieces[s.pieceId]
    const top = p?.kind === 'act' && p.parentId ? p.parentId : (p?.id ?? s.parentId)
    return order.find((x) => x.piece.id === top)?.index ?? null
  }
  const rangeIndex = (ref: string | undefined, fallback: number): number | ToolResult => {
    if (!ref) return fallback
    const r = resolvePiece(view, title.id, ref, order)
    if (!r.ok) return fail(r.message, r.candidates)
    const top = r.value.kind === 'act' && r.value.parentId ? r.value.parentId : r.value.id
    return order.find((x) => x.piece.id === top)?.index ?? fallback
  }
  const from = rangeIndex(str(args.from), 1)
  if (typeof from !== 'number') return from
  const to = rangeIndex(str(args.to), Number.MAX_SAFE_INTEGER)
  if (typeof to !== 'number') return to
  const runs = proofRunsOf(view, title.id)
  const runRef = str(args.run_id)
  let runId: ID | undefined
  if (runRef) {
    const hits = runs.filter((r) => r.runId === runRef.trim() || (runRef.trim().length >= 6 && r.runId.startsWith(runRef.trim())))
    if (hits.length !== 1) return fail(`実行 '${runRef}' が見つかりません`, runs.map((r) => `${r.runId} ${r.runDate} ${r.runLabel || '（名前なし）'}`))
    runId = hits[0].runId
  }
  const filtered = all.filter((s) => {
    if (status === 'open' && s.done) return false
    if (status === 'done' && !s.done) return false
    if (category && s.category !== category) return false
    if (runId && s.runId !== runId) return false
    if (args.from !== undefined || args.to !== undefined) {
      const i = indexOf(s)
      if (i === null || i < Math.min(from, to) || i > Math.max(from, to)) return false
    }
    return true
  })
  let start = 0
  const cursorArg = str(args.cursor)
  const key = JSON.stringify([status, category ?? '', runId ?? '', args.from ?? '', args.to ?? '', detailed])
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    if (!c || c.k !== 'proof' || c.t !== title.id || typeof c.s !== 'number')
      return fail('cursor が読めません（novel_list_proofreading の続きの cursor をそのまま渡してください）')
    if (c.f !== key) return fail('cursor が別の条件のものです（同じ status・category・範囲で渡してください）')
    start = c.s
  }
  const open = all.filter((s) => !s.done).length
  const lines: string[] = []
  if (start === 0) {
    lines.push(
      `=== 『${title.name}』の推敲案（${status === 'open' ? 'チェックしていない案' : status === 'done' ? 'チェックした案' : 'すべて'} ${filtered.length}件／全${all.length}件・未チェック ${open}件）[${shortId('title', title.id)}] ===`,
    )
    const cov = proofCoverage(view, title.id)
    lines.push(`確認の範囲: ${cov.text || 'まだ記録がありません'}`)
    if (runs.length)
      lines.push(
        `実行（新しい順）: ${runs
          .slice(0, 10)
          .map((r) => `${shortDate(r.runDate, today(ctx.now))} ${r.runLabel || '（名前なし）'} ${r.count}件 [${r.runId}]`)
          .join(' / ')}`,
      )
  }
  const pageSize = detailed ? PROOF_PAGE.detailed : PROOF_PAGE.concise
  const slice = filtered.slice(start, start + pageSize)
  for (const s of slice) {
    const where = reanchor(view, s)
    const loc =
      where.status === 'lost'
        ? `${locationOf(view, order, s.pieceId, s.pieceLabel)}（本文が変わりました・直した可能性）`
        : `${locationOf(view, order, where.pieceId, s.pieceLabel)} ¶${where.paragraph}${where.status === 'moved' ? '（本文が変わった後の位置）' : ''}`
    const cat = proofCategoryLabel(s.category, s.categoryLabel)
    const flag = s.flagged ? '⚑ ' : ''
    const done = s.done ? '（チェック済み）' : ''
    const fix = s.suggestion ? `→「${s.suggestion}」` : ''
    if (detailed) {
      lines.push(`${shortId('proofSuggestion', s.id)} ${flag}${done}${loc} [${cat}]「${s.excerpt}」${fix}`)
      lines.push(
        `  理由: ${s.reason}${s.runId ? ` / 実行: ${runs.find((r) => r.runId === s.runId)?.runLabel || s.runId}` : ''} / 追加 ${jstDate(s.createdAt)}${s.source === 'claude' ? '（Claude）' : s.source === 'paste' ? '（貼り付け）' : '（手で追加）'}${isNewerRecord(s) ? `（${NEWER_RECORD_LABEL}）` : ''}`,
      )
    } else lines.push(`${shortId('proofSuggestion', s.id)} ${flag}${done}${loc} [${cat}]「${s.excerpt}」${fix} ― ${head(s.reason, 50)}`)
  }
  if (!filtered.length) lines.push('（この条件の推敲案はありません）')
  const nextStart = start + slice.length
  if (nextStart < filtered.length) {
    const next = encodeCursor({ k: 'proof', t: title.id, s: nextStart, f: key })
    lines.push(`続き: cursor="${next}"（残り${filtered.length - nextStart}件）`)
  }
  return ok(lines.join('\n'))
}
