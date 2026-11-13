// 読むツール（R1〜R13）の結果の文字の形。目次・採用原稿・検索はアプリの手動連携と同じ src/claude/view.ts を使う。
// ここで見るデータは、いつも見せる内容（claudeView: 見せないタイトル・ゴミ箱・応募時の原稿の控えなどを除いたもの）。
import {
  analysisText,
  benchWorkLine,
  benchWorkRef,
  benchWorkTagList,
  filterByViewpoints,
  resolveBenchWork,
  viewpointNames,
  workAnalysesBlocks,
} from '../../../../src/claude/bench'
import { proofCategoryLabel, isProofCategory } from '../../../../src/claude/categories'
import { jstDate, shortDate } from '../../../../src/claude/dates'
import { reanchor } from '../../../../src/claude/anchor'
import { benchAnalysesOf } from '../../../../src/claude/benchOrder'
import {
  filterBySections,
  materialBiblio,
  materialLine,
  materialNotesBlocks,
  materialRef,
  materialTagsLine,
  noteText,
  resolveMaterial,
  sectionNames,
} from '../../../../src/claude/material'
import { materialNotesOf } from '../../../../src/claude/materialOrder'
import {
  compareProofSortKeys,
  critiquePromptsOf,
  critiqueResultsOf,
  proofCoverage,
  proofRunsOf,
  proofSortKey,
  proofStoryRank,
  proofSuggestionsOf,
  revisionIdeasOf,
  strategyNotesOf,
  type ProofSortKey,
} from '../../../../src/claude/order'
import { matchesId, pieceRefLabel, readingOrder, refKey, resolvePiece, shortId, type ReadingItem } from '../../../../src/claude/refs'
import { blockAt, prefixPrint, relocate, type Keyed, type Relocation, type TextBlock } from '../../../../src/claude/resume'
import { manuscriptLabel, manuscriptOf } from '../../../../src/claude/snapshot'
import {
  cutPoint,
  decodeCursor,
  encodeCursor,
  outlineView,
  readTextView,
  searchTextView,
  titleHeadline,
  type ServedPart,
} from '../../../../src/claude/view'
import { ideaReadMark, ideaSectionWritable, isClaudeIdea } from '../../../../src/claude/ideaAppend'
import { CLAUDE_PATH_SEP, folderCandidateLines, ideaPathLabel, isClaudeFolder } from '../../../../src/claude/ideaFolders'
import { cardShortId, KIND_OF } from '../../../../src/claude/trashRequest'
import { liveTrashRequests } from '../../../../src/claude/trashTargets'
import { claudeAccessLabel, claudeAccessOf, isNewerRecord, NEWER_RECORD_LABEL } from '../../../../src/claude/visibility'
import {
  categoriesOf,
  entriesOf,
  isIdeaChecked,
  memosOf,
  sortIdeas,
  sortedTitles,
  submissionStatusLabel,
  submissionsOf,
  titleLastEdited,
  titleSummary,
} from '../../../../src/domain/entityOps'
import { BENCH_LIMITS, benchWorkName, benchWorksOfTitle, sortedBenchWorks } from '../../../../src/domain/benchOps'
import { MATERIAL_LIMITS, materialName, sortedMaterials } from '../../../../src/domain/materialOps'
import { byOrder } from '../../../../src/domain/util'
import {
  buildIdeaTree,
  effectiveFolderId,
  folderPathLabel,
  folderSubtree,
  ideaFolderName,
  sectionOf,
  type IdeaFolderNode,
  type IdeaTree,
} from '../../../../src/domain/ideaFolders'
import { actParts, adoptedMetrics, isSplit, pieceFullLabel, pieceLabel } from '../../../../src/domain/structure'
import {
  SUBMISSION_TEXT,
  SUBMISSION_TEXT_FIELDS,
  submissionExtraLines,
  submissionTextStatus,
  textLimitRange,
} from '../../../../src/domain/submissionTexts'
import { bodyMetrics, formatCount, textHash } from '../../../../src/domain/text'
import { TRASH_RETENTION_DAYS } from '../../../../src/domain/trash'
import type {
  AppData,
  BenchWork,
  ID,
  Idea,
  IdeaFolder,
  Material,
  Piece,
  ProofSuggestion,
  Submission,
  Title,
  TrashRequest,
  TrashRequestTable,
} from '../../../../src/domain/types'
import {
  bool,
  fail,
  head,
  itemBudget,
  length,
  num,
  ok,
  pageBody,
  RESULT_LIMIT,
  str,
  strList,
  titleArg,
  type ToolResult,
} from './common'

export type { ToolResult }

export interface ReadContext {
  /** 見せる内容（claudeView） */
  view: AppData
  now: number
  /** 呼び出したクライアント（Claude Code なら本文の既定の文字数を減らす） */
  client?: string
  /** 1回に調べる本文の文字数の上限（検索） */
  workBudget: number
  /**
   * novel_read_text が採用原稿を出した時に呼ぶ（出した話・幕。コネクタがこの接続の読んだ本文の控えにする。readMemo.ts）。
   * 検索（novel_search_text）は呼ばない（一致の前後しか出さないので、話を読んだことにはしない）
   */
  onServed?: (parts: readonly ServedPart[]) => void
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
  if (!r.ok) return fail(r.error, r.candidates)
  if (r.served?.length) ctx.onServed?.(r.served)
  return ok(r.text)
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
  /** Claude が作ったアイデア（2.8） */
  claude?: boolean
}

/** 依頼を当てた（アプリの同期待ちの）追記の数（見せる内容の ideaAppends は、当てた依頼だけ） */
function pendingAppendCount(view: AppData, ideaId: ID): number {
  let n = 0
  for (const r of Object.values(view.ideaAppends ?? {})) if (r.ideaId === ideaId) n += 1
  return n
}

/**
 * アイデアの一覧の1行と本文の形。アプリと同じ並び（済みでないもの → 済み）で渡す。済み（実装した・没にした）には【済】を付ける。
 * 見出しは古い版で付けたものだけ（今の版は内容だけ。1行目が見出しの代わり）。作者が書いたアイデアの形は 2.7 のまま。
 * Claude が作ったアイデア（2.8）には【Claude】を付け、本文の見出しに場所と、追記できる時は読んだ印（novel_append_to_idea の read_mark）
 * を出す（印は本文の見出しだけ。一覧の行には出さない）。
 * 2.9: フォルダに入っているアイデアは、本文の見出しにフォルダも出す（Claude が作ったものは場所に「＞」でつなぎ、作者が書いたものは
 * 見出しの後ろに「フォルダ: …」。フォルダの外のアイデアは 2.8 と1字も変えない）
 */
function ideaItems(view: AppData, ideas: readonly Idea[]): NoteItem[] {
  return sortIdeas(ideas).map((i) => {
    const ref = shortId('idea', i.id)
    const heading = i.heading.trim()
    const done = isIdeaChecked(i) ? '【済】' : ''
    const chars = `（${formatCount(length(i.body))}字）`
    const name = heading || (i.body.split(/\r\n?|\n/).find((l) => l.trim()) ?? '').trim()
    if (!isClaudeIdea(i))
      return {
        id: i.id,
        ref,
        name,
        line: heading
          ? `${ref} ${done}${heading}${chars}${i.body.trim() ? `: ${head(i.body)}` : ''}`
          : `${ref} ${done}${head(i.body) || '（空のアイデア）'}${chars}`,
        full: () => {
          const fid = effectiveFolderId(view, i)
          const folder = fid ? ` フォルダ: ${folderPathLabel(view, fid, CLAUDE_PATH_SEP)}` : ''
          return `=== アイデア${done}${heading ? `: ${heading}` : ''} [${ref}]${folder} ===\n${i.body}`
        },
      }
    const k = pendingAppendCount(view, i.id)
    const place = ideaPathLabel(view, i)
    const where = ideaSectionWritable(view.titles, i)
      ? `（${place}${k ? `・アプリの同期待ちの追記 ${k}件を含む` : ''}）[${ref}] 印: ${ideaReadMark(i.body)}`
      : `（${place}・「読むだけ」のタイトルなので追記できません）[${ref}]`
    return {
      id: i.id,
      ref,
      name,
      line: `${ref} 【Claude】${done}${head(i.body) || '（空のアイデア）'}${chars}${k ? `（追記の依頼 ${k}件はアプリの同期待ち）` : ''}`,
      full: () => `=== アイデア${done}【Claude】${where} ===\n${i.body}`,
      claude: true,
    }
  })
}

/** 仕切りのアイデア（タイトルの id。null = どのタイトルにも属さないホームのアイデアのうち、見せる内容にある Claude が作ったもの） */
const ideasIn = (view: AppData, section: ID | null) => Object.values(view.ideas).filter((i) => i.titleId === section)

/** 木の中のアイデアの見せる順（1段目ごとに、中のフォルダのアイデア → そのフォルダのアイデア。最後にフォルダの外） */
function treeIdeas(tree: IdeaTree): Idea[] {
  return [...tree.folders.flatMap((top) => [...top.folders.flatMap((sub) => sub.ideas), ...top.ideas]), ...tree.loose]
}

/** 木のフォルダの数（どちらの段も） */
const treeFolderCount = (tree: IdeaTree) => tree.folders.reduce((n, top) => n + 1 + top.folders.length, 0)

/**
 * アイデアの一覧の木の行（2.9。フォルダがある時だけ）。フォルダは【フォルダ】f:… 名前（Claude が作ったものは【Claude】）、中の
 * フォルダとアイデアは2字ずつ字下げする。どの入れ物でもフォルダ → 済みでないアイデア → 済みのアイデアの順。タイトルのフォルダには
 * 中のアイデアの数（中のフォルダの分も）を出し、ホームのフォルダには出さない（作者が書いたアイデアの数が分かるため）
 */
function ideaTreeLines(tree: IdeaTree, items: ReadonlyMap<ID, NoteItem>, counts: boolean): string[] {
  const lines: string[] = []
  const pad = (depth: number) => '  '.repeat(depth)
  const cards = (ideas: readonly Idea[], depth: number) => {
    for (const i of ideas) {
      const it = items.get(i.id)
      if (it) lines.push(`${pad(depth)}${it.line}`)
    }
  }
  const folder = (n: IdeaFolderNode, depth: number) => {
    const badge = isClaudeFolder(n.folder) ? '【Claude】' : ''
    const count = counts ? `（${formatCount(n.count)}件）` : ''
    lines.push(`${pad(depth)}【フォルダ】${shortId('ideaFolder', n.folder.id)} ${badge}${ideaFolderName(n.folder)}${count}`)
    for (const sub of n.folders) folder(sub, depth + 1)
    cards(n.ideas, depth + 1)
  }
  for (const n of tree.folders) folder(n, 0)
  if (tree.folders.length && tree.loose.length) lines.push('（フォルダの外）')
  cards(tree.loose, 0)
  return lines
}

/** f:… の形（アイデアのフォルダの短い id） */
const FOLDER_REF = /^f:[0-9a-z]{4,}$/i

/** フォルダの表記（「f:1a2b3c4d「新作の相談＞2026/11/12　港町」」） */
const folderRefLabel = (view: AppData, f: IdeaFolder) =>
  `${shortId('ideaFolder', f.id)}「${folderPathLabel(view, f.id, CLAUDE_PATH_SEP)}」`

/**
 * ids の f:… を、そのフォルダ（中のフォルダも）の見えるアイデア（見せる順）にする。title があればその仕切りのフォルダから、
 * 無ければホームと見せているタイトルのフォルダから探す。見つからない・何個にも当たる時は断る
 */
function folderRefIdeas(view: AppData, title: Title | null, ref: string): { folder: IdeaFolder; ideas: Idea[] } | { error: ToolResult } {
  const all = Object.values(view.ideaFolders ?? {}).filter((f) => f && typeof f === 'object' && matchesId('ideaFolder', ref, f.id))
  const hits = title ? all.filter((f) => sectionOf(view.titles, f.titleId) === title.id) : all
  if (hits.length > 1)
    return {
      error: fail(
        `${ref} がいくつかのフォルダに当たります（id を長く指定してください）`,
        hits.slice(0, 10).map((f) => folderRefLabel(view, f)),
      ),
    }
  if (!hits.length) {
    const other = all[0]
    if (title && other) {
      const t = sectionOf(view.titles, other.titleId)
      return {
        error: fail(
          t
            ? `${shortId('ideaFolder', other.id)} はタイトル『${view.titles[t].name}』のフォルダです（title_id に ${shortId('title', t)} を渡すか、title_id を省いてください）`
            : `${shortId('ideaFolder', other.id)} はホームのアイデアのフォルダです（title_id を省いてください）`,
        ),
      }
    }
    return { error: fail(`フォルダが見つかりません: ${ref}`, folderCandidateLines(view, title?.id ?? null)) }
  }
  return { folder: hits[0], ideas: folderSubtree(view, hits[0].id).ideas }
}

function noteItems(view: AppData, title: Title, kind: 'settings' | 'memos'): NoteItem[] {
  if (kind === 'memos')
    return memosOf(view, title.id).map((m) => ({
      id: m.id,
      ref: shortId('memo', m.id),
      name: m.name,
      line: `${shortId('memo', m.id)} ${m.name.trim() || '（無題のメモ）'}（${formatCount(length(m.body))}字）${m.body.trim() ? `: ${head(m.body)}` : ''}`,
      full: () => `=== メモ: ${m.name.trim() || '（無題のメモ）'} [${shortId('memo', m.id)}] ===\n${m.body}`,
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
  const kind = args.kind === 'settings' || args.kind === 'memos' || args.kind === 'ideas' ? args.kind : null
  if (!kind) return fail("kind は 'settings'・'memos'・'ideas' のどれかにしてください")
  // kind=ideas は title_id を省ける（どのタイトルにも属さないホームのアイデアのうち、Claude が作ったもの。2.8）
  let title: Title | null = null
  if (args.title_id === undefined) {
    if (kind !== 'ideas')
      return fail('title_id がありません（設定項目・メモはタイトルを指してください。kind=ideas の時だけ省けます）')
  } else {
    const t = titleArg(ctx.view, args.title_id)
    if ('error' in t) return t.error
    title = t.title
  }
  const kindLabel = kind === 'settings' ? '設定項目' : kind === 'memos' ? 'メモ' : 'アイデア'
  const budget = Math.min(60_000, Math.max(2_000, num(args.char_budget) ?? 20_000))
  let ids = strList(args.ids) ?? []
  let full = bool(args.full) ?? false
  let start = 0
  /** 続きから読む項目（start）の中の位置（長い1つの項目を何回かに分けて読む時） */
  let off0 = 0
  const cursorArg = str(args.cursor)
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    if (!c || c.k !== 'notes' || c.t !== (title?.id ?? '') || c.kind !== kind || typeof c.s !== 'number')
      return fail('cursor が読めません（novel_get_notes の続きの cursor をそのまま渡してください）')
    start = c.s
    off0 = typeof c.o === 'number' && c.o > 0 ? c.o : 0
    ids = Array.isArray(c.ids) ? (c.ids as string[]) : []
    full = c.full === true
  }
  // ホームのアイデアを ids で指す時は、見せているタイトルのアイデアからも探す
  const oneSection = title !== null || !ids.length
  let items =
    kind !== 'ideas'
      ? noteItems(ctx.view, title!, kind)
      : ideaItems(ctx.view, oneSection ? ideasIn(ctx.view, title?.id ?? null) : Object.values(ctx.view.ideas))
  // 2.9: 1つの仕切りのアイデアは、フォルダがあれば木の順（フォルダが無ければ 2.8 のまま）
  const tree = kind === 'ideas' && oneSection ? buildIdeaTree(ctx.view, title?.id ?? null) : null
  const folders = tree ? treeFolderCount(tree) : 0
  if (tree && folders) {
    const byId = new Map(items.map((it) => [it.id, it]))
    items = treeIdeas(tree).flatMap((i) => byId.get(i.id) ?? [])
  }
  if (!ids.length && !full) {
    const done = kind === 'ideas' ? items.filter((it) => isIdeaChecked(ctx.view.ideas[it.id] ?? {})).length : 0
    const counted = `${items.length}件${done ? `・うち済み ${done}件` : ''}${folders ? `・フォルダ ${folders}つ` : ''}`
    const lines = [
      title
        ? `=== 『${title.name}』の${kindLabel}（${counted}）[${shortId('title', title.id)}] ===`
        : `=== ホームのアイデア（どのタイトルにも属さない・Claude が作ったものだけ。${counted}）===`,
    ]
    if (done) lines.push('【済】は作者が済み（実装した・没にした）にしたアイデア。済みでないものの後ろに、新しく済みにしたものから並ぶ。')
    if (items.some((it) => it.claude))
      lines.push('【Claude】は Claude がこのコネクタで作ったアイデア（追記・ゴミ箱へ移すのは、そのチャットで作ったものだけ）。')
    if (tree && folders) {
      lines.push(
        `【フォルダ】はアイデアのフォルダ（2段まで。中のフォルダとアイデアは字下げして続く。名前の前の【Claude】は Claude が作ったフォルダ。f:… は novel_add_ideas の folder・subfolder に渡せる。名前の変更・削除・移動はアプリで作者がする）。${
          title
            ? 'フォルダの（n件）は中のアイデアの数（中のフォルダの分も）。'
            : 'ホームのフォルダは名前だけ（作者が作ったものも出す。中は Claude が作ったアイデアだけ）。'
        }`,
      )
      lines.push(...ideaTreeLines(tree, new Map(items.map((it) => [it.id, it])), title !== null))
    } else {
      if (!items.length) lines.push('（ありません）')
      for (const it of items) lines.push(it.line)
    }
    if (items.length)
      lines.push(
        folders
          ? '本文は ids に短い id を入れるか full=true で読めます（ids に f:… を渡すと、そのフォルダの中のアイデア）。'
          : '本文は ids に短い id を入れるか full=true で読めます。',
      )
    if (!title) lines.push(folders ? '作者が書いたホームのアイデアは見えません（フォルダの名前は見えます）。' : '作者が書いたホームのアイデアは見えません。')
    return ok(lines.join('\n'))
  }
  let chosen = items
  if (ids.length) {
    const missing: string[] = []
    /** f:… で指したのに、見えるアイデアが無かったフォルダ */
    const empty: string[] = []
    chosen = []
    for (const ref of ids) {
      // 2.9: f:… は、そのフォルダ（中のフォルダも）のアイデア
      if (kind === 'ideas' && FOLDER_REF.test(ref.trim())) {
        const r = folderRefIdeas(ctx.view, title, ref.trim())
        if ('error' in r) return r.error
        const before = chosen.length
        for (const i of r.ideas) {
          const hit = items.find((it) => it.id === i.id)
          if (hit && !chosen.includes(hit)) chosen.push(hit)
        }
        if (chosen.length === before && !r.ideas.length) empty.push(folderRefLabel(ctx.view, r.folder))
        continue
      }
      const idKind = kind === 'settings' ? 'settingEntry' : kind === 'memos' ? 'memo' : 'idea'
      const hit =
        items.find((it) => matchesId(idKind, ref, it.id)) ?? items.find((it) => it.name.trim() === ref.trim())
      if (hit && !chosen.includes(hit)) chosen.push(hit)
      else if (!hit) missing.push(ref)
    }
    if (!chosen.length) {
      if (!missing.length && empty.length)
        return ok(`フォルダ ${empty.join('・')}の中に、見えるアイデアはありません。`)
      if (kind === 'ideas') {
        const elsewhere = ideaElsewhere(ctx.view, title, missing)
        if (elsewhere) return fail(elsewhere)
      }
      return fail(`${kindLabel}が見つかりません: ${missing.join('、')}`, items.slice(0, 20).map((i) => i.line))
    }
  }
  const out: string[] = []
  let used = 0
  let i = start
  const tid = title?.id ?? ''
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
      const next = encodeCursor({ k: 'notes', t: tid, kind, s: i, o: end, ids, full })
      out.push(`続き: cursor="${next}"（この項目の残り ${formatCount(text.length - end)}字・残り${chosen.length - i}件）`)
      return ok(out.join('\n'))
    }
    out.push(from > 0 ? text.slice(from) : text)
    used += rest
  }
  if (i < chosen.length) {
    const next = encodeCursor({ k: 'notes', t: tid, kind, s: i, ids, full })
    out.push(`続き: cursor="${next}"（残り${chosen.length - i}件）`)
  }
  return ok(out.join('\n'))
}

/**
 * ids で指したアイデアが選んだ場所に無い時の理由: ゴミ箱へ移す依頼中（2.7 と同じ文）か、見せているほかの場所にある
 * （タイトルのアイデアか、Claude が作ったホームのアイデア）。どちらでもなければ null（作者が書いたホームのアイデア・見せない
 * タイトルのアイデアは、ある・無いを答えない）
 */
function ideaElsewhere(view: AppData, title: Title | null, refs: readonly string[]): string | null {
  for (const ref of refs) {
    const asked = pendingRequestFor(view, 'ideas', null, ref)
    if (asked) return pendingMessage(asked)
  }
  if (!title) return null
  for (const ref of refs) {
    const hit = Object.values(view.ideas).find((i) => i.titleId !== title.id && matchesId('idea', ref, i.id))
    if (!hit) continue
    const other = hit.titleId ? view.titles[hit.titleId] : undefined
    return other
      ? `${shortId('idea', hit.id)} はタイトル『${other.name}』のアイデアです（title_id に ${shortId('title', other.id)} を渡すか、title_id を省いてください）`
      : `${shortId('idea', hit.id)} はホームのアイデアです（title_id を省いてください）`
  }
  return null
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
/**
 * 1つの項目を char_budget 字ずつ返す。k と t（タイトル・相対比較の作品・資料の id）と extra（観点・項目の絞り込みなど）を cursor に入れ、
 * 続きの時に同じ項目を同じ形で作り直せるようにする
 */
function pagedItem(
  ctx: ReadContext,
  args: Args,
  k: 'strategy' | 'critique' | 'bench' | 'material',
  titleId: ID,
  item: { which: string; id: ID; label: string; text: string },
  offset: number,
  extra: Record<string, unknown> = {},
  more: { notes?: readonly string[]; mark?: (o: number) => Record<string, unknown> } = {},
): ToolResult {
  const budget = itemBudget(args.char_budget, isClaudeCode(ctx.client))
  return ok(
    pageBody(item.text, {
      offset,
      budget,
      contHeader: (from) => `=== ${item.label}の続き（${formatCount(from)}字目から）===`,
      cursor: (o) => encodeCursor({ k, t: titleId, which: item.which, id: item.id, o, ...extra, ...(more.mark?.(o) ?? {}) }),
      notice: more.notes?.length ? more.notes.join('\n') : undefined,
    }),
  )
}

/** 分析・記録を全部読む時の言葉 */
interface BlockWords {
  /** 分析・記録 */
  item: string
  /** 見つからない時の例 */
  gone: string
  /** 1つだけ読む引数 */
  one: string
  tool: string
  /** 区切りの表記（n:…「観点」。頭は作品・資料の見出し） */
  ref: (key: string) => string
}

/** 位置 o の続きの cursor に足すもの: その位置の区切りの id・区切りの中の位置・区切りの文の指紋・それより前の区切りの指紋 */
function blockMark(blocks: readonly TextBlock[], o: number): Record<string, unknown> {
  const i = blockAt(blocks, o)
  const b = blocks[i]
  return { a: b.key, ao: Math.max(0, o - b.start), ah: textHash(b.text), b: prefixPrint(blocks, i) }
}

/**
 * 2.9 の続きの cursor（blockMark つき）から、つないだ文のどこから読むかと、前回の答えの後に変わったことの知らせ。読んでいた区切りを
 * id で探し（resume.ts）、その区切りの文が同じなら区切りの中の同じ位置から、変わっていれば区切りの始めから。指紋が読めなければ null
 */
function resumeBlocks(
  blocks: readonly TextBlock[],
  c: Record<string, unknown>,
  words: BlockWords,
): { offset: number; notes: string[] } | null {
  const key = String(c.a)
  const ao = typeof c.ao === 'number' && c.ao > 0 ? c.ao : 0
  const found = blocks.findIndex((b) => b.key === key)
  const r: Relocation | null = relocate(blocks, found, c.b, ao === 0)
  if (!r) return null
  const { item } = words
  const ref = (i: number) => words.ref(blocks[i].key)
  if (r.kind === 'gone') {
    const next = r.index < blocks.length ? `次の ${ref(r.index)}から続けます` : 'ここで終わりです'
    return {
      offset: blocks[r.index]?.from ?? Number.POSITIVE_INFINITY,
      notes: [
        r.same
          ? `（前回の続きの${item}が見つからないため（${words.gone}）、${next}）`
          : `（前回の続きの${item}が見つからず、その前の${item}も増えた・減った・動いたため、${next}。読んでいない${item}・もう一度出る${item}があることがあります（cursor なしで読み直すとすべて出ます））`,
      ],
    }
  }
  const b = blocks[r.index]
  let offset = b.from
  let inside = false
  const notes: string[] = []
  let textNote: string | null = null
  if (ao > 0) {
    // 途中まで読んだ区切り（r.index は found）: 文が同じならその位置から、変わっていれば区切りの始めから
    if (textHash(b.text) === c.ah) {
      offset = b.start + Math.min(ao, b.text.length)
      inside = true
    } else textNote = `（前回の続きの${item}の本文が変わっていたため、その${item}の始めから読み直しています）`
  }
  const from = `前回の続きの ${ref(r.index)}${inside ? 'の途中' : ''}から続けます`
  if (r.kind === 'added')
    notes.push(`（${item}が増えました。前回の続きより前に ${ref(r.item)}が入りました（まだ読んでいません。${words.one} で読めます）。${from}）`)
  else if (r.kind === 'again')
    notes.push(`（${item}の並びが変わりました。前に読んだ ${ref(r.item)}が前回の続きより後ろへ動いたため、この後にもう一度出ます。${from}）`)
  else if (r.kind === 'changed')
    notes.push(
      `（${item}が増えた・減った・動いたため、並びが変わりました。${from}。この前に入った${item}はこの続きに出ず、前に読んだ${item}がもう一度出ることがあります（cursor なしで読み直すとすべて出ます））`,
    )
  if (textNote) notes.push(textNote)
  return { offset, notes }
}

/**
 * 作品の分析・資料の記録を全部つないだ文を、pagedItem と同じ形で返す。2.9 から続きの cursor には、つないだ文の中の位置のほかに、
 * その位置の分析・記録の id と中の位置・文の指紋・それより前の分析・記録の指紋を入れ、前回の答えの後にほかの接続やアプリが分析・記録を
 * 足した・ゴミ箱へ移した・書き換えた（頭のタグの行が増えた）時も、読んでいた分析・記録を id で探し直して続ける（重ねず、抜かず、
 * 変わったことは知らせる）。それより前の版の cursor（位置だけ）は、今までどおり位置から
 */
function pagedBlocks(
  ctx: ReadContext,
  args: Args,
  k: 'bench' | 'material',
  ownerId: ID,
  item: { which: string; id: ID; label: string },
  joined: { text: string; blocks: TextBlock[] },
  cont: { o: number; raw: Record<string, unknown> } | null,
  extra: Record<string, unknown>,
  words: BlockWords,
): ToolResult {
  let offset = cont ? cont.o : 0
  let notes: string[] = []
  if (cont && typeof cont.raw.a === 'string') {
    const r = resumeBlocks(joined.blocks, cont.raw, words)
    if (!r) return fail(`cursor が読めません（${words.tool} の続きの cursor をそのまま渡してください）`)
    if (r.offset >= joined.text.length) return ok([...r.notes, '（ここで終わりです）'].join('\n'))
    offset = r.offset
    notes = r.notes
  }
  return pagedItem(ctx, args, k, ownerId, { ...item, text: joined.text }, offset, extra, {
    notes,
    mark: (o) => blockMark(joined.blocks, o),
  })
}

/** 続きの cursor（1つの項目の続き）を読む。無ければ null、違う形なら 'bad' */
function itemCursor(
  args: Args,
  k: 'strategy' | 'critique' | 'bench' | 'material',
  titleId: ID | null,
): { which: string; id: string; o: number; t: string; raw: Record<string, unknown> } | null | 'bad' {
  const raw = str(args.cursor)
  if (!raw) return null
  const c = decodeCursor(raw)
  if (
    !c ||
    c.k !== k ||
    typeof c.t !== 'string' ||
    (titleId !== null && c.t !== titleId) ||
    typeof c.which !== 'string' ||
    typeof c.id !== 'string' ||
    typeof c.o !== 'number'
  )
    return 'bad'
  return { which: c.which, id: c.id, o: c.o, t: c.t, raw: c }
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
  /** 批評の結果で比べた相対比較の作品（2.5。CritiqueResult.benchWorkIds。相対比較から消えた作品は数だけ） */
  const compared = (ids: readonly ID[] | undefined): string => {
    if (!ids?.length) return ''
    const shown = ids.map((id) => view.benchWorks[id]).filter((w): w is BenchWork => Boolean(w))
    const gone = ids.length - shown.length
    return `比べた作品: ${shown.map((w) => benchWorkRef(w)).join('、')}${gone > 0 ? `（ほか${gone}作品は相対比較から削除されています）` : ''}`
  }
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
        compared(r.benchWorkIds),
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
      `${shortId('critiqueResult', r.id)} ${r.runDate}「${r.promptName || '（プロンプトなし）'}」${r.scope.kind === 'range' ? r.scope.label : 'タイトル全体'}・${r.manuscript ? manuscriptLabel(r.manuscript, current) : '原稿の控えなし'}${r.resultMarkdown ? `・Markdown ${formatCount(length(r.resultMarkdown))}字` : ''}${r.artifactUrl ? '・URL あり' : ''}${r.benchWorkIds?.length ? `・${compared(r.benchWorkIds)}` : ''}${r.resultMarkdown ? `\n  ${head(r.resultMarkdown, 80)}` : ''}`,
    )
  if (results.length > LIST_RESULTS)
    lines.push(
      `（ほか${results.length - LIST_RESULTS}件・古いものは見出しだけ。result_id で全文）: ${results
        .slice(LIST_RESULTS)
        .map((r) => `${shortId('critiqueResult', r.id)} ${r.runDate}「${head(r.promptName || '（プロンプトなし）', 40)}」`)
        .join(' / ')}`,
    )
  if (!results.length) lines.push('（ありません）')
  // 相対比較する作品（2.5）: 作品と観点を出し、分析は novel_get_bench_analysis で読んでもらう
  const bench = benchWorksOfTitle(view, title.id)
  if (bench.length) {
    lines.push(`--- 相対比較する作品（${bench.length}作品。作者が比べたい既存の作品）---`)
    for (const w of bench) {
      const analyses = benchAnalysesOf(view, w.id)
      lines.push(
        `${benchWorkRef(w)} 分析 ${analyses.length}件${analyses.length ? `: ${viewpointNames(analyses).join('・')}` : '（まだありません）'}`,
      )
    }
    lines.push(
      '批評の時は novel_get_bench_analysis でこれらの作品の分析を読んで比べ、novel_add_critique_result の bench_works に比べた作品を入れてください。',
    )
  }
  lines.push('1つを全文で読むには prompt_id・result_id を指定してください。')
  return ok(lines.join('\n'))
}

// ---------- R10 相対比較の作品一覧 ----------

/** names・exclude_names・tags の数と1つの長さの上限（schemas.ts と同じ。長さは作品名・タグの上限と同じ） */
export const BENCH_LIST_FILTERS = { count: 10, length: 80, tagLength: BENCH_LIMITS.tag } as const

/** 一覧の1回目に出す「タグ（作品の数）」の行に並べるタグの種類の数（これより多ければ「ほか n種」） */
export const BENCH_TAG_SUMMARY_LIMIT = 200

interface NameFilters {
  /** 入力のまま（見出しと cursor に使う） */
  raw: string[]
  /** 照らす形（refKey） */
  keys: string[]
}

/** 名前の絞り込み（refKey が同じものは最初の1つ。相対比較の作品名・資料の資料名とタグ）。形が違えば 'bad' */
function nameFilters(v: unknown, limits: { count: number; length: number }): NameFilters | 'bad' {
  if (v === undefined || v === null) return { raw: [], keys: [] }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || Array.from(x).length > limits.length)) return 'bad'
  const out: NameFilters = { raw: [], keys: [] }
  for (const x of v as string[]) {
    const k = refKey(x)
    if (!k || out.keys.includes(k)) continue
    out.raw.push(x.trim())
    out.keys.push(k)
  }
  return out.keys.length > limits.count ? 'bad' : out
}

/** 作品名の絞り込み */
const benchNameFilters = (v: unknown) => nameFilters(v, BENCH_LIST_FILTERS)
/** 作品のタグの絞り込み */
const benchTagFilters = (v: unknown) =>
  nameFilters(v, { count: BENCH_LIST_FILTERS.count, length: BENCH_LIST_FILTERS.tagLength })

const sameKeys = (a: NameFilters, b: NameFilters) =>
  a.keys.length === b.keys.length && [...a.keys].sort().join('\n') === [...b.keys].sort().join('\n')

const quoted = (list: readonly string[]) => list.map((k) => `「${k}」`).join('')

/** 「「【原稿】星の庭（」を含む」「「【対照】」を含まない」（含む・含まないの絞り込みの文。無ければ空の配列） */
function includeExcludeParts(names: NameFilters, excludes: NameFilters): string[] {
  return [
    names.raw.length ? `${quoted(names.raw)}${names.raw.length > 1 ? 'のどれかを' : 'を'}含む` : '',
    excludes.raw.length ? `${quoted(excludes.raw)}${excludes.raw.length > 1 ? 'のどれも' : 'を'}含まない` : '',
  ].filter(Boolean)
}

/** 「作品名に「【原稿】星の庭（」を含む・「【対照】」を含まない・タグ「恋愛」を持つ」（絞り込みが無ければ空） */
function benchFilterLabel(names: NameFilters, excludes: NameFilters, tags: NameFilters): string {
  const parts = includeExcludeParts(names, excludes)
  return [
    parts.length ? `作品名に${parts.join('・')}` : '',
    tags.raw.length ? `タグ${quoted(tags.raw)}を${tags.raw.length > 1 ? 'すべて' : ''}持つ` : '',
  ]
    .filter(Boolean)
    .join('・')
}

/**
 * 棚で使っている作品のタグと作品の数の1行（「タグ（作品の数）: 恋愛 12・ミステリー 8・…」。絞り込む前の全作品で数える。
 * 多い順、同じなら名前の順。BENCH_TAG_SUMMARY_LIMIT 種より多ければ「ほか n種」。タグが無ければ空）
 */
function benchTagSummary(view: AppData, works: readonly BenchWork[]): string {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const w of works) {
    for (const tag of benchWorkTagList(view, w)) {
      const key = refKey(tag)
      const cur = counts.get(key)
      if (cur) cur.count += 1
      else counts.set(key, { tag, count: 1 })
    }
  }
  if (!counts.size) return ''
  const list = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja') || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  )
  const shown = list.slice(0, BENCH_TAG_SUMMARY_LIMIT).map((t) => `${t.tag} ${t.count}`)
  const more = list.length > BENCH_TAG_SUMMARY_LIMIT ? `・ほか ${list.length - BENCH_TAG_SUMMARY_LIMIT}種` : ''
  return `タグ（作品の数）: ${shown.join('・')}${more}`
}

/**
 * 続きの始まり: 前のページで最後に出した項目（after）の今の位置の次から（アプリで並べ替えて並び順の数が振り直されても抜けない）。
 * その項目が消えていれば並び順で次から。after が無ければ最初から
 */
function resumeIndex(items: readonly { id: ID; order: number }[], after: { order: number; id: string } | null): number {
  const at = after ? items.findIndex((x) => x.id === after.id) : -1
  const start = !after ? 0 : at >= 0 ? at + 1 : items.findIndex((x) => byOrder(x, after) > 0)
  return start < 0 ? items.length : start
}

/**
 * 棚の一覧の1回分（相対比較の作品・資料で同じ切り方）。全体が cap 字に収まればそのまま全部（closing まで）。収まらない時だけ
 * 項目（作品・資料）の切れ目で切り、最後の行を続きの行 more.footer(出した項目の数, 残りの数) にする（その分 more.room 字を空けておく）。
 * 1つの項目の行だけで長すぎる時は、行の切れ目（前の方にしか無ければ行の途中）で切って more.clipped の行を付ける
 */
function shelfPage(
  head: readonly string[],
  rest: readonly string[],
  closing: readonly string[],
  cap: number,
  more: { room: number; footer: (shown: number, left: number) => string; clipped: string },
): string {
  const whole = [...head, ...rest, ...closing].join('\n')
  if (whole.length <= cap) return whole
  const lines = [...head]
  const limit = Math.max(1_000, cap - more.room)
  let used = lines.join('\n').length + 1
  let i = 0
  for (; i < rest.length; i++) {
    let line = rest[i]
    if (i > 0 && used + line.length + 1 > limit) break
    // 1つの項目の行だけで長すぎる時（観点・項目がとても多い）は切る（続きの行を残すため）。行の切れ目が前の方にしか無ければ行の途中で切る
    if (line.length > limit) {
      const room = limit - 40
      let cut = line.lastIndexOf('\n', room)
      if (cut < room / 2) cut = room
      const c = line.charCodeAt(cut - 1)
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1
      line = `${line.slice(0, cut)}\n${more.clipped}`
    }
    lines.push(line)
    used += line.length + 1
  }
  if (i < rest.length) lines.push(more.footer(i, rest.length - i))
  else lines.push(...closing)
  return lines.join('\n')
}

/**
 * 相対比較の作品一覧（アプリの棚の順）。names・exclude_names で作品名を部分一致で絞り（refKey にして照らす）、tags で作品の
 * タグ（2.7。アプリがまだ付けていない「14 検索用タグ」の自動のタグも含める）をすべて持つ作品だけにする（名前そのもので照らす）。
 * 1回目の答え（cursor なし）には、見出しの次に棚で使っているタグと作品の数の1行を出す（絞り込む前の全作品で数える）。
 * 1回に返すのは char_budget 字（省略時は結果の上限 RESULT_LIMIT）まで。残りが収まれば今までどおり1回で全部（引数なしなら今までと同じ答え）。
 * 収まらない時だけ作品の切れ目で切り、最後の行を 続き: cursor="…"（結果が長いため、ここで切りました。…）にする。cursor には絞り込み
 * （入力のまま）・char_budget と、最後に出した作品の id と並び順を入れる。続きはその作品の今の位置の次から（消えていれば並び順で次から）
 */
export function listBenchWorks(ctx: ReadContext, args: Args = {}): ToolResult {
  const all = sortedBenchWorks(ctx.view)
  const argNames = benchNameFilters(args.names)
  const argExcludes = benchNameFilters(args.exclude_names)
  const argTags = benchTagFilters(args.tags)
  if (argNames === 'bad' || argExcludes === 'bad' || argTags === 'bad')
    return fail(
      `names・exclude_names・tags は文字列の配列にしてください（それぞれ${BENCH_LIST_FILTERS.count}個まで・1つ${BENCH_LIST_FILTERS.length}字まで。tags は1つ${BENCH_LIST_FILTERS.tagLength}字まで）`,
    )
  let names = argNames
  let excludes = argExcludes
  let tags = argTags
  let budget = num(args.char_budget)
  /** 前のページで最後に出した作品（id と並び順） */
  let after: { order: number; id: string } | null = null
  const cursorArg = str(args.cursor)
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    const cn = c ? benchNameFilters(c.n) : 'bad'
    const cx = c ? benchNameFilters(c.x) : 'bad'
    // タグの絞り込み（2.7）を持たない前の版の cursor は、タグで絞らない
    const ct = c ? benchTagFilters(c.t) : 'bad'
    if (
      !c ||
      c.k !== 'benchList' ||
      typeof c.a !== 'string' ||
      typeof c.o !== 'number' ||
      cn === 'bad' ||
      cx === 'bad' ||
      ct === 'bad'
    )
      return fail('cursor が読めません（novel_list_bench_works の続きの cursor をそのまま渡してください）')
    if (
      (args.names !== undefined && !sameKeys(names, cn)) ||
      (args.exclude_names !== undefined && !sameKeys(excludes, cx)) ||
      (args.tags !== undefined && !sameKeys(tags, ct))
    )
      return fail('cursor が別の条件のものです（cursor だけを渡すか、同じ names・exclude_names・tags で渡してください）')
    names = cn
    excludes = cx
    tags = ct
    after = { order: c.o, id: c.a }
    budget ??= num(c.b)
  }
  const inc = names.keys
  const exc = excludes.keys
  const wantTags = tags.keys
  const filter = benchFilterLabel(names, excludes, tags)
  const works = all.filter((w) => {
    const k = refKey(benchWorkName(w))
    if ((inc.length && !inc.some((n) => k.includes(n))) || exc.some((n) => k.includes(n))) return false
    if (!wantTags.length) return true
    // タグは名前そのもので照らす（アプリがまだ付けていない「14 検索用タグ」の自動のタグも含める）
    const have = new Set(benchWorkTagList(ctx.view, w).map(refKey))
    return wantTags.every((t) => have.has(t))
  })
  // 続きは、最後に出した作品の今の位置の次から（アプリで並べ替えて並び順の数が振り直されても抜けない）。その作品が消えていれば並び順で次から
  const from = resumeIndex(works, after)
  const cap = Math.min(RESULT_LIMIT, Math.max(2_000, budget ?? RESULT_LIMIT))
  const lines: string[] = [
    after
      ? `=== 相対比較の続き（${filter ? `${filter}作品 ` : ''}${works.length}作品のうち${from + 1}作品目から／全${all.length}作品）===`
      : filter
        ? `=== 相対比較（${filter}作品 ${works.length}作品／全${all.length}作品。作者が比べるために読む既存の作品）===`
        : `=== 相対比較（${all.length}作品。作者が比べるために読む既存の作品）===`,
  ]
  // 1回目の答え（続きでない）には、棚で使っているタグと作品の数の1行（絞り込む前の全作品で数える）
  const summary = after ? '' : benchTagSummary(ctx.view, all)
  if (summary) lines.push(summary)
  if (!all.length && !filter)
    lines.push(
      '（まだありません。作品の PDF を読んで novel_add_bench_analysis の new_work を付けて分析を追加すると、作品も相対比較に追加されます）',
    )
  else if (!works.length) lines.push(`（${filter}作品はありません）`)
  else if (from >= works.length) lines.push('（この後の作品はありません）')
  const rest = works.slice(from).map((w) => benchWorkLine(ctx.view, w))
  const closing = works.length ? ['分析の本文は novel_get_bench_analysis（work に w:…）で読んでください。'] : []
  // 収まらない時は作品の切れ目で切る。続きの行の分を空けておく（絞り込みが長いと cursor も長い）
  const cursorOf = (w: Pick<BenchWork, 'id' | 'order'>) =>
    encodeCursor({
      k: 'benchList',
      n: names.raw,
      x: excludes.raw,
      t: tags.raw,
      a: w.id,
      o: w.order,
      ...(budget !== undefined ? { b: budget } : {}),
    })
  const footerOf = (next: string, left: number) =>
    `続き: cursor="${next}"（結果が長いため、ここで切りました。残り${left}作品は、この cursor で読めます）`
  return ok(
    shelfPage(lines, rest, closing, cap, {
      room: footerOf(cursorOf({ id: 'x'.repeat(40), order: -Number.MAX_VALUE }), 99_999).length + 2,
      footer: (shown, left) => footerOf(cursorOf(works[from + shown - 1]), left),
      clipped: '  （この作品の行は長いため、ここまで）',
    }),
  )
}

// ---------- R11 相対比較の分析 ----------

export function getBenchAnalysis(ctx: ReadContext, args: Args): ToolResult {
  const view = ctx.view
  const cont = itemCursor(args, 'bench', null)
  if (cont === 'bad' || (cont && cont.which !== 'work' && cont.which !== 'analysis'))
    return fail('cursor が読めません（novel_get_bench_analysis の続きの cursor をそのまま渡してください）')
  const ref = cont ? cont.t : str(args.work)
  if (!ref) return fail('work がありません（novel_list_bench_works で w:… を確かめてください）')
  const r = resolveBenchWork(view, ref)
  if (!r.ok) return fail(r.message, r.candidates)
  const work = r.value
  const viewpoints = cont ? strList(cont.raw.vp) : strList(args.viewpoints)
  const vp = viewpoints?.length ? { vp: viewpoints } : {}
  const page = (which: 'work' | 'analysis', id: ID, offset: number): ToolResult => {
    if (which === 'analysis') {
      const a = view.benchAnalyses[id]
      if (!a || a.workId !== work.id)
        return fail('続きを読む分析が見つかりません（削除された可能性があります。cursor なしで読み直してください）')
      const text = `=== 相対比較の作品 ${benchWorkRef(work)} の分析 ===\n${analysisText(a)}`
      return pagedItem(ctx, args, 'bench', work.id, { which, id, label: `『${work.name}』の「${a.viewpoint}」`, text }, offset)
    }
    return pagedBlocks(
      ctx,
      args,
      'bench',
      work.id,
      { which, id: work.id, label: `『${work.name}』の分析` },
      workAnalysesBlocks(view, work, viewpoints),
      cont,
      vp,
      {
        item: '分析',
        gone: 'ゴミ箱へ移した・観点を変えたなど',
        one: 'analysis_id',
        tool: 'novel_get_bench_analysis',
        ref: (key) => {
          const a = view.benchAnalyses[key]
          return a ? `${shortId('benchAnalysis', a.id)}「${a.viewpoint.trim() || '観点なし'}」` : '作品の見出し・書誌の行'
        },
      },
    )
  }
  if (cont) return page(cont.which as 'work' | 'analysis', cont.id, cont.o)
  const aid = str(args.analysis_id)
  if (aid) {
    const list = benchAnalysesOf(view, work.id)
    const hits = list.filter((a) => matchesId('benchAnalysis', aid, a.id))
    if (!hits.length) {
      const asked = pendingRequestFor(view, 'benchAnalyses', work.id, aid)
      if (asked) return fail(pendingMessage(asked))
    }
    if (hits.length !== 1)
      return fail(
        `分析 '${aid}' が『${work.name}』に見つかりません`,
        list.map((a) => `${shortId('benchAnalysis', a.id)}「${a.viewpoint}」${a.runDate}`),
      )
    return page('analysis', hits[0].id, 0)
  }
  if (viewpoints?.length && !filterByViewpoints(benchAnalysesOf(view, work.id), viewpoints).length) {
    const names = viewpointNames(benchAnalysesOf(view, work.id))
    return fail(
      `『${work.name}』には観点「${viewpoints.join('」「')}」の分析がありません`,
      names.length ? names.map((n) => `観点「${n}」`) : undefined,
    )
  }
  return page('work', work.id, 0)
}

/**
 * id で指したカードに、ゴミ箱へ移す依頼が出ているか（見せる内容からは外れているので、依頼の方を見る）。
 * 分析・記録は作品（資料）も同じもの。アイデアは仕切りを比べない（parentId は見ない）
 */
function pendingRequestFor(view: AppData, table: TrashRequestTable, parentId: ID | null, ref: string): TrashRequest | undefined {
  return liveTrashRequests(view).find(
    (r) => r.table === table && (table === 'ideas' || r.parentId === parentId) && matchesId(KIND_OF[table], ref, r.targetId),
  )
}

const pendingMessage = (r: TrashRequest) =>
  `${cardShortId(r.table, r.targetId)} ${r.label} はゴミ箱へ移す依頼中です（アプリが同期すると、アプリのゴミ箱へ移ります。${TRASH_RETENTION_DAYS}日は作者がアプリのゴミ箱から戻せます）`

// ---------- R12 資料の一覧 ----------

/**
 * names・exclude_names・tags の数と1つの長さの上限（schemas.ts と同じ。長さは資料名・タグの上限と同じ）
 */
export const MATERIAL_LIST_FILTERS = {
  count: 10,
  length: MATERIAL_LIMITS.materialName,
  tagLength: MATERIAL_LIMITS.tag,
} as const

const MATERIAL_NAME_FILTER = { count: MATERIAL_LIST_FILTERS.count, length: MATERIAL_LIST_FILTERS.length }
const MATERIAL_TAG_FILTER = { count: MATERIAL_LIST_FILTERS.count, length: MATERIAL_LIST_FILTERS.tagLength }

/** 「資料名に「江戸」を含む・「図録」を含まない・タグ「ミリタリ」「現代」をすべて持つ」（絞り込みが無ければ空） */
function materialFilterLabel(names: NameFilters, excludes: NameFilters, tags: NameFilters): string {
  const parts = includeExcludeParts(names, excludes)
  return [
    parts.length ? `資料名に${parts.join('・')}` : '',
    tags.raw.length ? `タグ${quoted(tags.raw)}を${tags.raw.length > 1 ? 'すべて' : ''}持つ` : '',
  ]
    .filter(Boolean)
    .join('・')
}

/** 資料のタグの照らす形（refKey。作者が付けたタグ） */
const materialTagKeys = (m: Material): Set<string> =>
  new Set((Array.isArray(m.tags) ? m.tags : []).filter((t): t is string => typeof t === 'string').map(refKey).filter(Boolean))

/**
 * 資料の一覧（アプリの棚の順）。相対比較の作品一覧（listBenchWorks）と同じ決まりで、names・exclude_names で資料名を
 * 部分一致で絞り、tags で作者が付けたタグをすべて持つ資料だけにする（どちらも refKey にして照らす。タグは名前そのもので照らす）。
 * 1回に返すのは char_budget 字（省略時は結果の上限 RESULT_LIMIT）まで。収まらない時だけ資料の切れ目で切り、最後の行を
 * 続き: cursor="…" にする。cursor には絞り込み（入力のまま）・char_budget と、最後に出した資料の id と並び順を入れる
 */
export function listMaterials(ctx: ReadContext, args: Args = {}): ToolResult {
  const all = sortedMaterials(ctx.view)
  const argNames = nameFilters(args.names, MATERIAL_NAME_FILTER)
  const argExcludes = nameFilters(args.exclude_names, MATERIAL_NAME_FILTER)
  const argTags = nameFilters(args.tags, MATERIAL_TAG_FILTER)
  if (argNames === 'bad' || argExcludes === 'bad' || argTags === 'bad')
    return fail(
      `names・exclude_names・tags は文字列の配列にしてください（それぞれ${MATERIAL_LIST_FILTERS.count}個まで・1つ${MATERIAL_LIST_FILTERS.length}字まで。tags は1つ${MATERIAL_LIST_FILTERS.tagLength}字まで）`,
    )
  let names = argNames
  let excludes = argExcludes
  let tags = argTags
  let budget = num(args.char_budget)
  /** 前のページで最後に出した資料（id と並び順） */
  let after: { order: number; id: string } | null = null
  const cursorArg = str(args.cursor)
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    const cn = c ? nameFilters(c.n, MATERIAL_NAME_FILTER) : 'bad'
    const cx = c ? nameFilters(c.x, MATERIAL_NAME_FILTER) : 'bad'
    const ct = c ? nameFilters(c.t, MATERIAL_TAG_FILTER) : 'bad'
    if (
      !c ||
      c.k !== 'materialList' ||
      typeof c.a !== 'string' ||
      typeof c.o !== 'number' ||
      cn === 'bad' ||
      cx === 'bad' ||
      ct === 'bad'
    )
      return fail('cursor が読めません（novel_list_materials の続きの cursor をそのまま渡してください）')
    if (
      (args.names !== undefined && !sameKeys(names, cn)) ||
      (args.exclude_names !== undefined && !sameKeys(excludes, cx)) ||
      (args.tags !== undefined && !sameKeys(tags, ct))
    )
      return fail('cursor が別の条件のものです（cursor だけを渡すか、同じ names・exclude_names・tags で渡してください）')
    names = cn
    excludes = cx
    tags = ct
    after = { order: c.o, id: c.a }
    budget ??= num(c.b)
  }
  const inc = names.keys
  const exc = excludes.keys
  const wantTags = tags.keys
  const filter = materialFilterLabel(names, excludes, tags)
  const materials = all.filter((m) => {
    const k = refKey(materialName(m))
    if ((inc.length && !inc.some((n) => k.includes(n))) || exc.some((n) => k.includes(n))) return false
    if (!wantTags.length) return true
    const have = materialTagKeys(m)
    return wantTags.every((t) => have.has(t))
  })
  const from = resumeIndex(materials, after)
  const cap = Math.min(RESULT_LIMIT, Math.max(2_000, budget ?? RESULT_LIMIT))
  const lines: string[] = [
    after
      ? `=== 資料の続き（${filter ? `${filter}資料 ` : ''}${materials.length}件のうち${from + 1}件目から／全${all.length}件）===`
      : filter
        ? `=== 資料（${filter}資料 ${materials.length}件／全${all.length}件。作者が創作のために読む資料）===`
        : `=== 資料（${all.length}件。作者が創作のために読む資料）===`,
  ]
  if (!all.length && !filter)
    lines.push(
      '（まだありません。資料の PDF を読んで novel_add_material_notes の new_material を付けて記録を追加すると、資料も資料の棚に追加されます）',
    )
  else if (!materials.length) lines.push(`（${filter}資料はありません）`)
  else if (from >= materials.length) lines.push('（この後の資料はありません）')
  const rest = materials.slice(from).map((m) => materialLine(ctx.view, m))
  const closing = materials.length ? ['記録の本文は novel_get_material（material に d:…）で読んでください。'] : []
  const cursorOf = (m: Pick<Material, 'id' | 'order'>) =>
    encodeCursor({
      k: 'materialList',
      n: names.raw,
      x: excludes.raw,
      t: tags.raw,
      a: m.id,
      o: m.order,
      ...(budget !== undefined ? { b: budget } : {}),
    })
  const footerOf = (next: string, left: number) =>
    `続き: cursor="${next}"（結果が長いため、ここで切りました。残り${left}件は、この cursor で読めます）`
  return ok(
    shelfPage(lines, rest, closing, cap, {
      room: footerOf(cursorOf({ id: 'x'.repeat(40), order: -Number.MAX_VALUE }), 99_999).length + 2,
      footer: (shown, left) => footerOf(cursorOf(materials[from + shown - 1]), left),
      clipped: '  （この資料の行は長いため、ここまで）',
    }),
  )
}

// ---------- R13 資料の記録 ----------

/** 1つの資料の記録を読む（相対比較の分析を読む getBenchAnalysis と同じ形。項目で絞る・1つだけ・続き） */
export function getMaterial(ctx: ReadContext, args: Args): ToolResult {
  const view = ctx.view
  const cont = itemCursor(args, 'material', null)
  if (cont === 'bad' || (cont && cont.which !== 'material' && cont.which !== 'note'))
    return fail('cursor が読めません（novel_get_material の続きの cursor をそのまま渡してください）')
  const ref = cont ? cont.t : str(args.material)
  if (!ref) return fail('material がありません（novel_list_materials で d:… を確かめてください）')
  const r = resolveMaterial(view, ref)
  if (!r.ok) return fail(r.message, r.candidates)
  const material = r.value
  const name = materialName(material)
  const sections = cont ? strList(cont.raw.sec) : strList(args.sections)
  const sec = sections?.length ? { sec: sections } : {}
  const page = (which: 'material' | 'note', id: ID, offset: number): ToolResult => {
    if (which === 'note') {
      const n = view.materialNotes[id]
      if (!n || n.materialId !== material.id)
        return fail('続きを読む記録が見つかりません（削除された可能性があります。cursor なしで読み直してください）')
      // 資料全体を読む時と同じく、書誌とタグも先頭に出す
      const head = [`=== 資料 ${materialRef(material)} の記録 ===`, materialBiblio(material), materialTagsLine(material)].filter(Boolean)
      const text = `${head.join('\n')}\n${noteText(n)}`
      return pagedItem(ctx, args, 'material', material.id, { which, id, label: `『${name}』の「${n.section}」`, text }, offset)
    }
    return pagedBlocks(
      ctx,
      args,
      'material',
      material.id,
      { which, id: material.id, label: `『${name}』の記録` },
      materialNotesBlocks(view, material, sections),
      cont,
      sec,
      {
        item: '記録',
        gone: 'ゴミ箱へ移した・項目を変えたなど',
        one: 'note_id',
        tool: 'novel_get_material',
        ref: (key) => {
          const n = view.materialNotes[key]
          return n ? `${shortId('materialNote', n.id)}「${n.section.trim() || '項目なし'}」` : '資料の見出し・書誌の行'
        },
      },
    )
  }
  if (cont) return page(cont.which as 'material' | 'note', cont.id, cont.o)
  const nid = str(args.note_id)
  if (nid) {
    const list = materialNotesOf(view, material.id)
    const hits = list.filter((n) => matchesId('materialNote', nid, n.id))
    if (!hits.length) {
      const asked = pendingRequestFor(view, 'materialNotes', material.id, nid)
      if (asked) return fail(pendingMessage(asked))
    }
    if (hits.length !== 1)
      return fail(
        `記録 '${nid}' が『${name}』に見つかりません`,
        list.map((n) => `${shortId('materialNote', n.id)}「${n.section}」${n.runDate}`),
      )
    return page('note', hits[0].id, 0)
  }
  if (sections?.length && !filterBySections(materialNotesOf(view, material.id), sections).length) {
    const names = sectionNames(materialNotesOf(view, material.id))
    return fail(
      `『${name}』には項目「${sections.join('」「')}」の記録がありません`,
      names.length ? names.map((n) => `項目「${n}」`) : undefined,
    )
  }
  return page('material', material.id, 0)
}

// ---------- R9 推敲案 ----------

const PROOF_PAGE = { concise: 100, detailed: 40 }

/** cursor の推敲案の並びの鍵（読めなければ null） */
function proofKeyArg(v: unknown): ProofSortKey | null {
  if (!Array.isArray(v) || v.length !== 6 || typeof v[5] !== 'string') return null
  return v.slice(0, 5).every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as ProofSortKey) : null
}

const idKeys = (list: readonly ProofSuggestion[]): Keyed[] => list.map((s) => ({ key: s.id }))

/** 印の数（「数.和」の数） */
const printCount = (b: unknown) => (typeof b === 'string' ? Number(b.split('.')[0]) : NaN)

/**
 * 前の答えの後に一覧が変わった時の知らせ（無ければ null）。続きは前の答えの最後の案の次から（並びの鍵で探す）なので、前の方の案が
 * 減っても重ならず抜けない。cursor の b（続きより前の案の指紋）・c（その時の最も新しい作った時刻）・d（最も新しい更新の時刻）・
 * o（話の並びの指紋）と、いまの続きより前の案 before を比べる
 */
function proofListNote(
  filtered: readonly ProofSuggestion[],
  start: number,
  c: Record<string, unknown>,
  orderPrint: string,
): string | null {
  const before = filtered.slice(0, start)
  if (prefixPrint(idKeys(before), before.length) === c.b) return null
  const created = typeof c.c === 'number' ? c.c : Number.POSITIVE_INFINITY
  const updated = typeof c.d === 'number' ? c.d : Number.POSITIVE_INFINITY
  const added = before.filter((s) => s.createdAt > created)
  const old = before.filter((s) => s.createdAt <= created)
  // 前の方に新しい案が入っただけ（新しい案は先頭の方に並ぶ）
  if (added.length && prefixPrint(idKeys(old), old.length) === c.b)
    return `（前の答えの後に推敲案が ${added.length}件増えました。新しい案は一覧の前の方に入るため、この続きには出ません（cursor なしで読み直すと出ます））`
  // 前の答えの後に変わった案が無く、話の並びも同じで、続きより前の案が減っただけ: 前の答えに出た案が一覧から外れた（チェックした・
  // ゴミ箱へ移した）だけなので、重なりも抜けも無い
  const changed = filtered.some((s) => s.createdAt <= created && s.updatedAt > updated)
  if (!added.length && !changed && c.o === orderPrint && before.length < printCount(c.b)) return null
  return '（前の答えの後に、推敲案の追加・チェック・フラグなどで一覧が変わりました。続きは前の答えの最後の案の次からです。前の方に入った案はこの続きに出ず、前の答えに出た案がもう一度出ることがあります（すべて確かめる時は cursor なしで読み直してください））'
}

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
  const rank = proofStoryRank(view, title.id)
  const orderPrint = textHash(order.map((x) => [x.piece.id, ...(x.piece.actIds ?? [])].join('+')).join(','))
  const lines: string[] = []
  if (cursorArg) {
    const c = decodeCursor(cursorArg)
    const last = c ? proofKeyArg(c.r) : null
    if (!c || c.k !== 'proof' || c.t !== title.id || (typeof c.s !== 'number' && !last))
      return fail('cursor が読めません（novel_list_proofreading の続きの cursor をそのまま渡してください）')
    if (c.f !== key) return fail('cursor が別の条件のものです（同じ status・category・範囲で渡してください）')
    if (last) {
      // 前の答えの最後の案の次から（その案がチェック・フラグで動いた・一覧から外れた時も、前の答えの時の並びの鍵の次から）
      const at = filtered.findIndex((s) => compareProofSortKeys(proofSortKey(s, rank), last) > 0)
      start = at < 0 ? filtered.length : at
      const note = proofListNote(filtered, start, c, orderPrint)
      if (note) lines.push(note)
    } else start = c.s as number // 2.8 までの cursor（一覧の何件目から）
  }
  const open = all.filter((s) => !s.done).length
  if (!cursorArg) {
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
    // 最後に出した案の並びの鍵（id を含む）と、続きより前の案の指紋・最も新しい作った時刻と更新の時刻・話の並びの指紋（proofListNote）
    const next = encodeCursor({
      k: 'proof',
      t: title.id,
      f: key,
      r: proofSortKey(filtered[nextStart - 1], rank),
      b: prefixPrint(idKeys(filtered), nextStart),
      c: all.reduce((m, s) => Math.max(m, s.createdAt), 0),
      d: all.reduce((m, s) => Math.max(m, s.updatedAt), 0),
      o: orderPrint,
    })
    lines.push(`続き: cursor="${next}"（残り${filtered.length - nextStart}件）`)
  }
  return ok(lines.join('\n'))
}
