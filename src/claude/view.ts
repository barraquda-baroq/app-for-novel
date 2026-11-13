// Claude に渡す本文・目次・検索結果の文字の形。コネクタの読むツール（目次・採用原稿・検索）と、
// 手動連携のコピー（プロンプト＋本文）で同じ形にする。
// - 見出しは ASCII の === / --- で囲む（小説の本文には ◆・＊＊＊・「……」 が出てくるため）
// - id は [p:3f2a9c1b] の形（短い id。src/claude/refs.ts）。読む順は #12、幕は #12.2
// - 数は 4,812字、日付は YYYY-MM-DD、切った所は [...]、一致した所は【】
// - 本文は段落（改行）の切れ目でだけ分ける（ルビの記法は改行をまたがないので途中で切れない。サロゲートペアも切らない）
// 続きは cursor（文字列）で読む。cursor には読む範囲・位置・その本文の指紋を入れ、本文が変わっていても続きから読んで知らせる。
// 採用原稿の続きは、区切り（話・幕・稿）を id で探し直す（2.9。話の並び・数が変わっても黙って同じ話を出したり飛ばしたりしない。resume.ts）。
import { strippedBody } from '../domain/ruby'
import { activeVersion, actParts, adoptedMetrics, chaptersOf, isSplit, pieceFullLabel } from '../domain/structure'
import { actProgress, titleProgress, type PieceProgress } from '../domain/progress'
import { bodyMetrics, formatCount, textHash } from '../domain/text'
import type { AppData, ID, Piece, Title, Version } from '../domain/types'
import { missingActiveLabel, titleSummary } from '../domain/entityOps'
import { paragraphAt, safeSlice, strippedMapOf } from './anchor'
import { jstDate } from './dates'
import { matchesId, readingOrder, resolvePiece, shortId, type ReadingItem } from './refs'
import { findNear, prefixPrint, relocate } from './resume'

export type ViewResult =
  | {
      ok: true
      text: string
      /** 続きがあれば次の呼び出しに渡す cursor（無ければ null） */
      nextCursor: string | null
      /** 採用原稿（readTextView）: このページに出した採用原稿の区切り（コネクタが読んだ本文の控えに使う。readMemo.ts） */
      served?: ServedPart[]
    }
  | { ok: false; error: string; candidates?: string[] }

/** ページに出した採用原稿の1区切り */
export interface ServedPart {
  /** その採用原稿の話・幕（幕に分けた話は幕。幕に分けていない話・特殊ブロックはその話） */
  pieceId: ID
  /** 区切りの始めから出した（false = 前のページの続きから） */
  start: boolean
}

const fail = (error: string, candidates?: string[]): ViewResult => ({ ok: false, error, ...(candidates ? { candidates } : {}) })

// ---------- cursor ----------

/** cursor（JSON を UTF-8 にして base64url にしたもの） */
export function encodeCursor(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const b64 = cursor.trim().replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---------- 小さな道具 ----------

/** 「2–4%」（全体が0字なら空） */
export function progressRange(p: PieceProgress | undefined): string {
  if (!p || p.start === null || p.end === null) return ''
  return `${Math.round(p.start * 100)}–${Math.round(p.end * 100)}%`
}

const join = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join('・')

/** タイトルの見出し行（『星の庭』採用原稿 286,400字（原稿用紙812枚）第n話120・特殊2・採用原稿なし 1話 [t:…]） */
export function titleHeadline(data: AppData, title: Title): string {
  const s = titleSummary(data, title.id)
  let pages = 0
  for (const item of readingOrder(data, title.id)) pages += adoptedMetrics(data, item.piece)?.manuscriptPages ?? 0
  const missing = missingActiveLabel(s.missingEpisodes, s.missingSpecials, s.missingActs)
  return `『${title.name}』採用原稿 ${formatCount(s.activeChars)}字（原稿用紙${formatCount(pages)}枚）第n話${s.episodes}・特殊${s.specials}${missing ? `・${missing}` : ''} [${shortId('title', title.id)}]`
}

/** 読む範囲（読む順の番号 from〜to。どちらも1から・両端を含む） */
interface Range {
  from: number
  to: number
}

/** from・to（話の指し方）を読む順の番号の範囲にする。幕を指したら、その幕の話 */
function rangeOf(data: AppData, titleId: ID, order: readonly ReadingItem[], from?: string, to?: string): Range | ViewResult {
  const indexOf = (ref: string): number | ViewResult => {
    const r = resolvePiece(data, titleId, ref, order)
    if (!r.ok) return fail(r.message, r.candidates)
    const top = r.value.kind === 'act' && r.value.parentId ? r.value.parentId : r.value.id
    const item = order.find((x) => x.piece.id === top)
    return item ? item.index : fail(`'${ref}' は本編に並んでいません`)
  }
  let f = 1
  let t = order.length
  if (from) {
    const v = indexOf(from)
    if (typeof v !== 'number') return v
    f = v
  }
  if (to) {
    const v = indexOf(to)
    if (typeof v !== 'number') return v
    t = v
  }
  if (f > t) [f, t] = [t, f]
  return { from: f, to: t }
}

const isRange = (v: Range | ViewResult): v is Range => typeof (v as Range).from === 'number'

/** 章の指し方（短い id・id・章の名前）を読む */
export function resolveChapter(
  data: AppData,
  titleId: ID,
  ref: string,
): { ok: true; id: ID } | { ok: false; error: string; candidates: string[] } {
  const chapters = chaptersOf(data, titleId)
  const r = ref.trim()
  const byId = chapters.filter((c) => matchesId('chapter', r, c.id))
  const hits = byId.length ? byId : chapters.filter((c) => c.name.trim() === r)
  if (hits.length === 1) return { ok: true, id: hits[0].id }
  return {
    ok: false,
    error: hits.length ? `章 '${r}' が複数あります` : `章 '${r}' が見つかりません`,
    candidates: (hits.length ? hits : chapters).slice(0, 20).map((c) => `${c.name} [${shortId('chapter', c.id)}]`),
  }
}

/** 「#3.2」（幕の読む順の表記） */
function actRef(item: ReadingItem, n: number): string {
  return `#${item.index}.${n}`
}

// ---------- 目次（コネクタの novel_get_outline） ----------

export interface OutlineOptions {
  /** 章（短い id・id・章の名前）だけ */
  chapter?: string
  from?: string
  to?: string
  /** 幕の行も出す（既定 true） */
  includeActs?: boolean
  /** detailed = 採用稿の更新日も出す */
  format?: 'concise' | 'detailed'
  cursor?: string
  /** 1回に出す行の数（既定 400） */
  maxRows?: number
}

/** 話の1行（「#1 第1話　出発 [p:3f2a9c1b] 4,812字 0–2% 第3稿/全3稿」） */
function outlineRow(
  data: AppData,
  piece: Piece,
  head: string,
  label: string,
  progress: PieceProgress | undefined,
  detailed: boolean,
): string {
  const id = `[${shortId('piece', piece.id)}]`
  if (isSplit(piece)) {
    const m = adoptedMetrics(data, piece)
    const acts = actParts(data, piece).length
    return `${head} ${label} ${id} ${formatCount(m?.chars ?? 0)}字 ${progressRange(progress)} 幕×${acts}`
      .replace(/ +/g, ' ')
      .trim()
  }
  const v = activeVersion(data, piece)
  const all = piece.versionIds.filter((x) => data.versions[x]).length
  if (!v) return `${head} ${label} ${id} 採用原稿なし（全${all}稿）`
  const m = bodyMetrics(v)
  const date = detailed ? ` 更新 ${jstDate(v.updatedAt)}` : ''
  return `${head} ${label} ${id} ${formatCount(m.chars)}字 ${progressRange(progress)} ${v.name.trim() || '（名前のない稿）'}/全${all}稿${date}`.replace(
    / +/g,
    ' ',
  )
}

/** 目次の続きの cursor に入れる選び方 */
interface OutlineSelection {
  from?: string
  to?: string
  chapter?: string
  includeActs?: boolean
}

/** タイトルの目次（話ごとの文字数・進捗・採用稿。幕に分けた話は幕の行も） */
export function outlineView(data: AppData, titleId: ID, opts: OutlineOptions = {}): ViewResult {
  const title = data.titles[titleId]
  if (!title) return fail('タイトルが見つかりません')
  const order = readingOrder(data, titleId)
  // 範囲・章・幕の行を出すかは cursor に入れる（続きの呼び出しで範囲を渡さなくても、同じ並びの続きから出す）
  let sel: OutlineSelection = {
    from: opts.from,
    to: opts.to,
    chapter: opts.chapter,
    includeActs: opts.includeActs !== false,
  }
  let start = 0
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor)
    if (!c || c.k !== 'outline' || c.t !== titleId || typeof c.s !== 'number' || !c.sel || typeof c.sel !== 'object')
      return fail('cursor が読めません（novel_get_outline の続きの cursor をそのまま渡してください）')
    sel = c.sel as OutlineSelection
    start = c.s
  }
  const range = rangeOf(data, titleId, order, sel.from, sel.to)
  if (!isRange(range)) return range
  let chapterId: ID | null | undefined
  if (sel.chapter) {
    const ch = resolveChapter(data, titleId, sel.chapter)
    if (!ch.ok) return fail(ch.error, ch.candidates)
    chapterId = ch.id
  }
  const maxRows = Math.max(10, opts.maxRows ?? 400)
  const includeActs = sel.includeActs !== false
  const detailed = opts.format === 'detailed'
  const progress = titleProgress(data, titleId)
  const items = order.filter(
    (x) => x.index >= range.from && x.index <= range.to && (chapterId === undefined || x.chapterId === chapterId),
  )
  const lines: string[] = []
  if (start === 0) {
    lines.push(titleHeadline(data, title))
    const synopsis = title.synopsis.trim()
    if (synopsis) {
      const head = Array.from(synopsis.replace(/\s+/g, ' ')).slice(0, 200).join('')
      lines.push(`あらすじ: ${head}${head.length < synopsis.replace(/\s+/g, ' ').length ? '[...]' : ''}`)
    }
  }
  let rows = 0
  let lastChapter: ID | null | undefined = start > 0 ? items[start - 1]?.chapterId : undefined
  let i = start
  for (; i < items.length; i++) {
    const item = items[i]
    const acts = isSplit(item.piece) && includeActs ? actParts(data, item.piece) : []
    if (rows > 0 && rows + 1 + acts.length > maxRows) break
    if (title.chaptersEnabled && item.chapterId !== lastChapter) {
      const ch = item.chapterId ? data.chapters[item.chapterId] : undefined
      lines.push(ch ? `■ ${ch.name.trim() || '（無題の章）'} [${shortId('chapter', ch.id)}]` : '■ （章に入っていない話）')
      lastChapter = item.chapterId
    }
    const p = progress.get(item.piece.id)
    lines.push(outlineRow(data, item.piece, `#${item.index}`, item.fullLabel, p, detailed))
    rows += 1
    if (acts.length) {
      const ap = actProgress(data, item.piece, p)
      for (const a of acts) {
        lines.push(`  ${outlineRow(data, a.act, actRef(item, a.number), `第${a.number}幕`, ap.get(a.act.id), detailed)}`)
        rows += 1
      }
    }
  }
  if (!items.length) lines.push('（この範囲に話はありません）')
  const next = i < items.length ? encodeCursor({ k: 'outline', t: titleId, sel, s: i }) : null
  if (next) lines.push(`続き: cursor="${next}" → #${items[i].index} ${items[i].fullLabel}から（残り${items.length - i}話）`)
  return { ok: true, text: lines.join('\n'), nextCursor: next }
}

// ---------- 採用原稿（コネクタの novel_read_text・手動連携のコピー） ----------

/** 読む1区切り（話・特殊ブロック・幕の採用稿、または指定の稿） */
interface Unit {
  /** 区切りの見出し（=== … === か --- … ---） */
  header: string
  /** 続きから読む時の見出し */
  contHeader: string
  /** 幕の時、属する話の見出し（ページが幕の途中から始まる時に出す） */
  groupHeader?: string
  /** 本文（ruby = strip ならルビの記法を除いたもの）。採用原稿が無ければ空 */
  body: string
  /** 本文の指紋（cursor に入れて、本文が変わったかを見る） */
  hash: string
  /** 区切りの id（話・特殊ブロックは話の id、幕は幕の id、指定の稿は稿の id。cursor に入れて、続きの時に探し直す） */
  key: string
  /** 幕の時、属する話の id（幕に分けた・つないだ時に、同じ話を探す） */
  group?: string
  /** この区切りが採用原稿の時、その話・幕の id（採用していない稿を指定して読む時は無い） */
  piece?: ID
  /** 読む順の番号（#12。指定の稿だけを読む時は 0） */
  index: number
  /** 残りの表示の「#15 第15話」 */
  name: string
}

export interface ReadSelection {
  /** 章（短い id・id・章の名前）だけ */
  chapter?: string
  from?: string
  to?: string
  /** 話の指し方の配列（50件まで。幕も指せる） */
  pieces?: string[]
  /** この稿だけを読む（採用していない稿も読める） */
  versionId?: string
  /** raw = 記法込みのまま（既定。推敲案の抜き出しと合う）、strip = ルビ・傍点の記法と読みを除く */
  ruby?: 'raw' | 'strip'
}

export interface ReadTextOptions extends ReadSelection {
  cursor?: string
  /** 1回に返す文字数の目安（2,000〜60,000。既定 20,000） */
  charBudget?: number
}

const bodyOf = (v: Version, ruby: 'raw' | 'strip') => (ruby === 'strip' ? strippedBody(v) : v.body)

function versionPart(v: Version, ruby: 'raw' | 'strip'): string {
  return `${v.name.trim() || '（名前のない稿）'}・${formatCount(bodyMetrics(v).chars)}字${ruby === 'strip' ? '・ルビを除く' : ''}`
}

/** 読む区切りを作る（範囲・話の指定・稿の指定から） */
function unitsOf(data: AppData, titleId: ID, sel: ReadSelection): Unit[] | ViewResult {
  const ruby = sel.ruby === 'strip' ? 'strip' : 'raw'
  const order = readingOrder(data, titleId)
  const progress = titleProgress(data, titleId)
  const units: Unit[] = []
  if (sel.versionId) {
    const v = Object.values(data.versions).find((x) => x.titleId === titleId && matchesId('version', sel.versionId!, x.id))
    if (!v) return fail(`稿 '${sel.versionId}' が見つかりません（novel_list_versions で稿の id を確かめてください）`)
    const piece = data.pieces[v.pieceId]
    const label = piece ? pieceFullLabel(data, piece) : '（話が見つかりません）'
    const adopted = piece?.activeVersionId === v.id ? '採用中' : '採用していない稿'
    const ids = `[${piece ? `${shortId('piece', piece.id)} ` : ''}${shortId('version', v.id)}]`
    units.push({
      header: `=== ${label} の ${v.name.trim() || '（名前のない稿）'}（${adopted}・${formatCount(bodyMetrics(v).chars)}字・更新 ${jstDate(v.updatedAt)}）${ids} ===`,
      contHeader: `=== ${label} の ${v.name.trim() || '（名前のない稿）'}（続き）${ids} ===`,
      body: bodyOf(v, ruby),
      hash: textHash(v.body),
      key: v.id,
      // 採用中の稿（幕に分けた話の、分ける前の稿は除く）は、その話・幕の採用原稿を読んだことになる
      ...(piece && !isSplit(piece) && piece.activeVersionId === v.id ? { piece: piece.id } : {}),
      index: 0,
      name: label,
    })
    return units
  }
  const pushPiece = (item: ReadingItem) => {
    const piece = item.piece
    const p = progress.get(piece.id)
    const id = `[${shortId('piece', piece.id)}]`
    if (isSplit(piece)) {
      const m = adoptedMetrics(data, piece)
      const parts = actParts(data, piece)
      const group = `=== #${item.index} ${item.fullLabel}（幕に分けた話・${parts.length}幕・${formatCount(m?.chars ?? 0)}字${progressRange(p) ? `・${progressRange(p)}` : ''}）${id} ===`
      const groupCont = `=== #${item.index} ${item.fullLabel}（幕に分けた話・続き）${id} ===`
      const ap = actProgress(data, piece, p)
      parts.forEach((part, k) => {
        const aid = part.version
          ? `[${shortId('piece', part.act.id)} ${shortId('version', part.version.id)}]`
          : `[${shortId('piece', part.act.id)}]`
        const pr = progressRange(ap.get(part.act.id))
        const head = part.version
          ? `--- 第${part.number}幕（${join(versionPart(part.version, ruby), pr)}）${aid} ---`
          : `--- 第${part.number}幕（採用原稿なし）${aid} ---`
        units.push({
          header: k === 0 ? `${group}\n${head}` : head,
          contHeader: part.version
            ? `--- 第${part.number}幕（続き・${part.version.name.trim() || '（名前のない稿）'}）${aid} ---`
            : head,
          groupHeader: groupCont,
          body: part.version ? bodyOf(part.version, ruby) : '',
          hash: part.version ? textHash(part.version.body) : '',
          key: part.act.id,
          group: piece.id,
          piece: part.act.id,
          index: item.index,
          name: `#${item.index} ${item.label}`,
        })
      })
      if (!parts.length)
        units.push({
          header: group,
          contHeader: groupCont,
          body: '',
          hash: '',
          key: piece.id,
          piece: piece.id,
          index: item.index,
          name: `#${item.index} ${item.label}`,
        })
      return
    }
    const v = activeVersion(data, piece)
    const ids = v ? `[${shortId('piece', piece.id)} ${shortId('version', v.id)}]` : id
    units.push({
      header: v
        ? `=== #${item.index} ${item.fullLabel}（${join(versionPart(v, ruby), progressRange(p))}）${ids} ===`
        : `=== #${item.index} ${item.fullLabel}（採用原稿なし）${ids} ===`,
      contHeader: `=== #${item.index} ${item.fullLabel}（続き${v ? `・${v.name.trim() || '（名前のない稿）'}` : ''}）${ids} ===`,
      body: v ? bodyOf(v, ruby) : '',
      hash: v ? textHash(v.body) : '',
      key: piece.id,
      piece: piece.id,
      index: item.index,
      name: `#${item.index} ${item.label}`,
    })
  }
  if (sel.pieces && sel.pieces.length) {
    if (sel.pieces.length > 50) return fail('pieces は50件までにしてください')
    for (const ref of sel.pieces) {
      const r = resolvePiece(data, titleId, ref, order)
      if (!r.ok) return fail(r.message, r.candidates)
      const piece = r.value
      if (piece.kind === 'act') {
        const item = order.find((x) => x.piece.id === piece.parentId)
        const n = item ? actParts(data, item.piece).findIndex((x) => x.act.id === piece.id) + 1 : 0
        const v = activeVersion(data, piece)
        const ids = v ? `[${shortId('piece', piece.id)} ${shortId('version', v.id)}]` : `[${shortId('piece', piece.id)}]`
        const head = item ? `#${item.index}.${n} ${pieceFullLabel(data, piece)}` : pieceFullLabel(data, piece)
        units.push({
          header: v ? `=== ${head}（${versionPart(v, ruby)}）${ids} ===` : `=== ${head}（採用原稿なし）${ids} ===`,
          contHeader: `=== ${head}（続き）${ids} ===`,
          body: v ? bodyOf(v, ruby) : '',
          hash: v ? textHash(v.body) : '',
          key: piece.id,
          ...(piece.parentId ? { group: piece.parentId } : {}),
          piece: piece.id,
          index: item?.index ?? 0,
          name: head,
        })
      } else {
        const item = order.find((x) => x.piece.id === piece.id)
        if (item) pushPiece(item)
      }
    }
    return units
  }
  const range = rangeOf(data, titleId, order, sel.from, sel.to)
  if (!isRange(range)) return range
  let chapterId: ID | undefined
  if (sel.chapter) {
    const ch = resolveChapter(data, titleId, sel.chapter)
    if (!ch.ok) return fail(ch.error, ch.candidates)
    chapterId = ch.id
  }
  for (const item of order)
    if (item.index >= range.from && item.index <= range.to && (chapterId === undefined || item.chapterId === chapterId))
      pushPiece(item)
  return units
}

/** 次に読む位置（区切りの番号と、その本文の中の位置） */
interface Pos {
  u: number
  o: number
}

/**
 * 本文を min から読んだ時に、pos あたりで切る位置。pos より前の段落の切れ目（改行の直後）があればそこ、
 * 無ければ（改行の無い長い段落）ルビ・傍点の記法とサロゲートペアの途中でない位置（戻ると進まない時は記法の終わりまで進める）
 */
export function cutPoint(body: string, min: number, pos: number): number {
  if (pos >= body.length) return body.length
  const nl = body.lastIndexOf('\n', pos - 1)
  if (nl >= min && nl + 1 > min) return nl + 1
  // 改行が無い長い段落: 記法の途中・サロゲートペアの途中で切らない
  let p = pos
  const m = strippedMapOf({ body })
  // 位置 p を含む記法（start < p < end）があれば、その前へ
  let lo = 0
  let hi = m.end.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (m.end[mid] <= p) lo = mid + 1
    else hi = mid
  }
  // 記法の始まりが min なら、戻ると1文字も進まないので、記法の終わりまで入れる
  if (lo < m.start.length && m.start[lo] < p && m.end[lo] > p) p = m.start[lo] > min ? m.start[lo] : m.end[lo]
  const c = body.charCodeAt(p)
  if (c >= 0xdc00 && c <= 0xdfff) p = p - 1 > min ? p - 1 : p + 1
  return p
}

/**
 * 区切りを、budget 文字に収まるように1ページ分だけ並べる。収まらない区切りは次のページへ回す（ページの最初の区切りが
 * budget より長ければ、段落の切れ目で分ける）。返す next は次のページの位置（終わりなら null）
 */
function page(units: readonly Unit[], at: Pos, budget: number): { text: string; next: Pos | null } {
  const out: string[] = []
  let used = 0
  let { u, o } = at
  let first = true
  while (u < units.length) {
    const unit = units[u]
    const head =
      o > 0
        ? unit.groupHeader
          ? `${unit.groupHeader}\n${unit.contHeader}`
          : unit.contHeader
        : first && unit.groupHeader && !unit.header.startsWith('===')
          ? `${unit.groupHeader}\n${unit.header}`
          : unit.header
    const rest = unit.body.length - o
    const need = head.length + 1 + rest + 1
    if (used + need <= budget || (first && rest === 0)) {
      out.push(head)
      if (rest > 0) out.push(o > 0 ? unit.body.slice(o) : unit.body)
      used += need
      u += 1
      o = 0
      first = false
      continue
    }
    if (!first) break
    // 最初の区切りが長い: 入るだけ入れて、段落の切れ目で分ける
    const room = Math.max(200, budget - used - head.length - 1)
    const cut = cutPoint(unit.body, o, o + room)
    const end = cut > o ? cut : Math.min(unit.body.length, o + room)
    out.push(head)
    out.push(unit.body.slice(o, end))
    used += head.length + 1 + (end - o)
    o = end
    if (o >= unit.body.length) {
      u += 1
      o = 0
    }
    break
  }
  return { text: out.join('\n'), next: u < units.length ? { u, o } : null }
}

/** 残り（「残り186話・約220,000字」） */
function remaining(units: readonly Unit[], at: Pos): string {
  let chars = units[at.u] ? units[at.u].body.length - at.o : 0
  const pieces = new Set<number>()
  for (let i = at.u; i < units.length; i++) {
    pieces.add(units[i].index)
    if (i > at.u) chars += units[i].body.length
  }
  const n = [...pieces].filter((x) => x > 0).length
  return `${n ? `残り${n}話・` : '残り'}約${formatCount(chars)}字`
}

/** 前回の続きの話の本文が変わっていた時の知らせ */
const TEXT_CHANGED = '（前回の続きの話の本文が変わっていたため、その段落の始めから読み直しています）'

/** 本文が変わった区切りの、位置 o を含む段落の始め */
function paragraphStart(unit: Unit, o: number): number {
  const nl = o > unit.body.length ? -1 : unit.body.lastIndexOf('\n', o - 1)
  return nl >= 0 ? nl + 1 : 0
}

/**
 * 2.9 の cursor（続きの区切りの id と、前に読んだ区切りの指紋つき）の、続きの位置と知らせる文。区切りを id で探し（幕に分けた・
 * つないだ時は同じ話の最初の区切り）、前に読んだ区切りの集まりが変わっていれば知らせる（resume.ts）。指紋が読めなければ null
 */
function resumeRead(
  units: readonly Unit[],
  c: Record<string, unknown>,
  u: number,
  o: number,
): { at: Pos; notes: string[] } | null {
  const key = String(c.p)
  let found = findNear(units, key, u)
  // 話が幕に分かれた・幕をつないだ・幕の分け方が変わった: 同じ話の最初の区切りから
  let replaced = false
  if (found < 0) {
    const g = typeof c.g === 'string' ? c.g : null
    found = units.findIndex((x) => x.group === key || (g !== null && (x.key === g || x.group === g)))
    replaced = found >= 0
  }
  const r = relocate(units, found, c.b, o === 0 || replaced)
  if (!r) return null
  const name = (i: number) => units[i]?.name ?? ''
  if (r.kind === 'gone') {
    const next = r.index < units.length ? `${name(r.index)}から続けます` : 'ここで終わりです'
    return {
      at: { u: r.index, o: 0 },
      notes: [
        r.same
          ? `（話の並びが変わりました。前回の続きの話が見つからないため（削除した・範囲の外へ動かしたなど）、${next}）`
          : `（話の並びが変わりました。前回の続きの話が見つからず、その前の話も増えた・減った・動いたため、${next}。読んでいない話・もう一度出る話があることがあります。novel_get_outline で確かめてください）`,
      ],
    }
  }
  let at: Pos = { u: r.index, o: 0 }
  let textNote: string | null = null
  if (replaced) {
    if (o > 0)
      textNote = '（前回の続きの話の本文が変わっていたため（幕に分けた・幕をつないだなど）、その話の始めから読み直しています）'
  } else if (o > 0) {
    // 途中まで読んだ区切り（r.index は found）: 本文が同じならその位置から、変わっていれば段落の始めから
    const unit = units[found]
    if (unit.hash === c.h) at = { u: found, o }
    else {
      at = { u: found, o: paragraphStart(unit, o) }
      textNote = TEXT_CHANGED
    }
  }
  const from = `前回の続きの ${name(at.u)}${at.o > 0 ? 'の途中' : ''}から続けます`
  const notes: string[] = []
  if (r.kind === 'added')
    notes.push(`（話の並びが変わりました。前回の続きより前に ${name(r.item)} が入りました（まだ読んでいません）。${from}）`)
  else if (r.kind === 'again')
    notes.push(
      `（話の並びが変わりました。前に読んだ ${name(r.item)} が前回の続きより後ろへ動いたため、この後にもう一度出ます。${from}）`,
    )
  else if (r.kind === 'changed')
    notes.push(
      `（話の並びが変わりました（前回の続きより前の話が増えた・減った・動いた）。${from}。この前に入った話は読んでいないことがあり、前に読んだ話がこの後にもう一度出ることがあります。novel_get_outline で確かめてください）`,
    )
  if (textNote) notes.push(textNote)
  return { at, notes }
}

/** 範囲の採用原稿を、char_budget 字ずつ読む（続きは cursor） */
export function readTextView(data: AppData, titleId: ID, opts: ReadTextOptions = {}): ViewResult {
  if (!data.titles[titleId]) return fail('タイトルが見つかりません')
  const budget = Math.min(60_000, Math.max(2_000, opts.charBudget ?? 20_000))
  let sel: ReadSelection = {
    chapter: opts.chapter,
    from: opts.from,
    to: opts.to,
    pieces: opts.pieces,
    versionId: opts.versionId,
    ruby: opts.ruby === 'strip' ? 'strip' : 'raw',
  }
  if (opts.cursor) {
    const bad = fail('cursor が読めません（novel_read_text の続きの cursor をそのまま渡してください）')
    const c = decodeCursor(opts.cursor)
    if (!c || c.k !== 'read' || c.t !== titleId || typeof c.u !== 'number' || typeof c.o !== 'number' || !c.sel) return bad
    sel = c.sel as ReadSelection
    const units = unitsOf(data, titleId, sel)
    if (!Array.isArray(units)) return units
    if (typeof c.p === 'string') {
      const r = resumeRead(units, c, c.u, c.o)
      return r ? readFrom(units, r.at, budget, titleId, sel, r.notes) : bad
    }
    // 2.8 までの cursor（区切りの番号と位置だけ）: 番号で続ける
    let at: Pos = { u: c.u, o: c.o }
    const unit = units[at.u]
    if (unit && at.o > 0 && unit.hash !== c.h) {
      // 前回から本文が変わった: その位置を含む段落の始めから読み直す
      at = { u: at.u, o: paragraphStart(unit, at.o) }
      return readFrom(units, at, budget, titleId, sel, [TEXT_CHANGED])
    }
    return readFrom(units, at, budget, titleId, sel, [])
  }
  const units = unitsOf(data, titleId, sel)
  if (!Array.isArray(units)) return units
  if (!units.length) return { ok: true, text: '（この範囲に話はありません）', nextCursor: null }
  return readFrom(units, { u: 0, o: 0 }, budget, titleId, sel, [])
}

/**
 * at から1ページ分。notes（話の並び・本文が変わった知らせ）を先頭に出す。続きの cursor には、続きの区切りの id と、
 * それより前の区切り（読んだもの）の指紋も入れる（resume.ts）
 */
function readFrom(units: Unit[], at: Pos, budget: number, titleId: ID, sel: ReadSelection, notes: string[]): ViewResult {
  if (at.u >= units.length) return { ok: true, text: [...notes, '（ここで終わりです）'].join('\n'), nextCursor: null, served: [] }
  const p = page(units, at, budget)
  const lines = [...notes, p.text]
  // 出した区切り: at.u から、続きの区切り（途中まで出した時はそれも）の前まで
  const last = p.next ? (p.next.o > 0 ? p.next.u : p.next.u - 1) : units.length - 1
  const served: ServedPart[] = []
  for (let i = at.u; i <= last; i++) {
    const piece = units[i].piece
    if (piece) served.push({ pieceId: piece, start: i > at.u || at.o === 0 })
  }
  let next: string | null = null
  if (p.next) {
    const unit = units[p.next.u]
    next = encodeCursor({
      k: 'read',
      t: titleId,
      sel,
      u: p.next.u,
      o: p.next.o,
      h: unit.hash,
      p: unit.key,
      b: prefixPrint(units, p.next.u),
      ...(unit.group ? { g: unit.group } : {}),
    })
    lines.push(`続き: cursor="${next}" → ${unit.name}${p.next.o > 0 ? 'の途中' : ''}から（${remaining(units, p.next)}）`)
  }
  return { ok: true, text: lines.join('\n'), nextCursor: next, served }
}

/**
 * 範囲の採用原稿をすべて、budget 字ずつのページに分ける（手動連携のコピー。1ページ目は firstBudget 字）。
 * ページの形は readTextView と同じ（続きの行は無い）
 */
export function readTextPages(
  data: AppData,
  titleId: ID,
  sel: ReadSelection,
  budget: number,
  firstBudget = budget,
): { ok: true; pages: string[] } | { ok: false; error: string; candidates?: string[] } {
  if (!data.titles[titleId]) return { ok: false, error: 'タイトルが見つかりません' }
  const units = unitsOf(data, titleId, sel)
  if (!Array.isArray(units)) return units as { ok: false; error: string }
  const pages: string[] = []
  let at: Pos | null = { u: 0, o: 0 }
  while (at) {
    const p = page(units, at, pages.length === 0 ? Math.max(1_000, firstBudget) : budget)
    pages.push(p.text)
    at = p.next
  }
  return { ok: true, pages }
}

// ---------- 検索（コネクタの novel_search_text） ----------

export interface SearchOptions {
  query: string
  /** literal = そのまま、regex = 正規表現（JavaScript。m・u フラグ付き。^ $ は段落ごと） */
  mode?: 'literal' | 'regex'
  /** adopted = 採用原稿（既定）、all_versions = すべての稿 */
  scope?: 'adopted' | 'all_versions'
  from?: string
  to?: string
  /** 前後に出す文字数（既定 25、80 まで） */
  contextChars?: number
  /** 1回に出す一致の数（既定 40、200 まで） */
  maxHits?: number
  /** 件数だけ */
  countOnly?: boolean
  cursor?: string
  /** 1回に調べる本文の文字数の上限（コネクタの CPU の目安。既定は上限なし） */
  workBudget?: number
}

/** 検索する1区切り（話・幕の採用稿、または稿） */
interface SearchUnit {
  /** 「#3 第3話」「#3.2 第3話 第2幕」「#3 第3話 第2稿」 */
  label: string
  ids: string
  version: Version
  /** 話の読む順の番号（件数の集計に使う） */
  index: number
}

function searchUnits(data: AppData, titleId: ID, range: Range, scope: 'adopted' | 'all_versions'): SearchUnit[] {
  const out: SearchUnit[] = []
  for (const item of readingOrder(data, titleId)) {
    if (item.index < range.from || item.index > range.to) continue
    const targets: { piece: Piece; label: string }[] = isSplit(item.piece)
      ? actParts(data, item.piece).map((a) => ({
          piece: a.act,
          label: `${actRef(item, a.number)} ${item.label} 第${a.number}幕`,
        }))
      : [{ piece: item.piece, label: `#${item.index} ${item.label}` }]
    for (const t of targets) {
      const versions =
        scope === 'adopted'
          ? [activeVersion(data, t.piece)].filter((v): v is Version => Boolean(v))
          : t.piece.versionIds.map((id) => data.versions[id]).filter((v): v is Version => Boolean(v))
      for (const v of versions) {
        out.push({
          label:
            scope === 'adopted'
              ? t.label
              : `${t.label} ${v.name.trim() || '（名前のない稿）'}${t.piece.activeVersionId === v.id ? '（採用中）' : ''}`,
          ids: `[${shortId('piece', t.piece.id)} ${shortId('version', v.id)}]`,
          version: v,
          index: item.index,
        })
      }
    }
  }
  return out
}

/** 検索の結果の文字数の目安（コネクタの上限 10 万字より小さく。見出しと続きの cursor の行の分を残す） */
const SEARCH_OUTPUT_BUDGET = 90_000
/** 一致そのものを出す長さ（長い一致は [...] で切る） */
const SEARCH_MATCH_SHOW = 200
/** 一致の行を1行にする（段落をまたぐ一致・前後の文字の改行は空白に） */
const oneLine = (s: string) => s.replace(/\r?\n/g, ' ')

/** 正規表現の特別な文字を、そのままの文字として扱う */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * タイトルの本文を検索する。ルビ・傍点の記法と読みを除いた本文で探し、位置（o:）は元の本文（記法込み）の位置で返す。
 * 一致の行: 「#3 第3話 ¶14 o:1234 [p:… v:…] [...]窓から【見れる】景色は[...]」
 */
export function searchTextView(data: AppData, titleId: ID, opts: SearchOptions): ViewResult {
  if (!data.titles[titleId]) return fail('タイトルが見つかりません')
  const query = opts.query ?? ''
  if (!query) return fail('query が空です')
  if (Array.from(query).length > 200) return fail('query は200字までにしてください')
  const mode = opts.mode === 'regex' ? 'regex' : 'literal'
  let re: RegExp
  try {
    // m: ^ と $ は段落（行）の頭と終わりに一致する（1話をまとめて探すので、無いと話の頭と終わりだけになる）
    re = new RegExp(mode === 'regex' ? query : escapeRegExp(query), 'gmu')
  } catch (e) {
    return fail(`正規表現として読めません: ${e instanceof Error ? e.message : String(e)}`)
  }
  const scope = opts.scope === 'all_versions' ? 'all_versions' : 'adopted'
  const contextChars = Math.min(80, Math.max(0, opts.contextChars ?? 25))
  const maxHits = Math.min(200, Math.max(1, opts.maxHits ?? 40))
  const order = readingOrder(data, titleId)
  const range = rangeOf(data, titleId, order, opts.from, opts.to)
  if (!isRange(range)) return range
  const units = searchUnits(data, titleId, range, scope)
  const qkey = textHash(`${mode}\u0000${scope}\u0000${query}\u0000${range.from}-${range.to}`)
  let at: Pos = { u: 0, o: 0 }
  let total = 0
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor)
    if (!c || c.k !== 'search' || c.t !== titleId || typeof c.u !== 'number' || typeof c.o !== 'number')
      return fail('cursor が読めません（novel_search_text の続きの cursor をそのまま渡してください）')
    if (c.q !== qkey) return fail('cursor が別の検索のものです（同じ query・mode・scope・範囲で渡してください）')
    at = { u: c.u, o: c.o }
    total = typeof c.n === 'number' ? c.n : 0
  }
  const work = opts.workBudget ?? Number.POSITIVE_INFINITY
  let scanned = 0
  const lines: string[] = []
  const counts = new Map<number, number>()
  let hits = 0
  let used = 0
  let next: Pos | null = null
  outer: for (let u = at.u; u < units.length; u++) {
    const unit = units[u]
    const m = strippedMapOf(unit.version)
    const text = m.text
    if (scanned > 0 && scanned + text.length > work) {
      next = { u, o: 0 }
      break
    }
    scanned += text.length
    re.lastIndex = u === at.u ? at.o : 0
    for (let r = re.exec(text); r; r = re.exec(text)) {
      if (r[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      const s = r.index
      const e = s + r[0].length
      if (opts.countOnly) {
        hits += 1
        counts.set(unit.index, (counts.get(unit.index) ?? 0) + 1)
        continue
      }
      if (hits >= maxHits) {
        next = { u, o: s }
        break outer
      }
      const rawStart = m.start[s]
      const before = oneLine(safeSlice(text, s - contextChars, s))
      const after = oneLine(safeSlice(text, e, e + contextChars))
      const shown = oneLine(r[0].length > SEARCH_MATCH_SHOW ? `${safeSlice(r[0], 0, SEARCH_MATCH_SHOW)}[...]` : r[0])
      const para = paragraphAt(unit.version.body, rawStart)
      const line = `${unit.label} ¶${para} o:${rawStart} ${unit.ids} ${s - contextChars > 0 ? '[...]' : ''}${before}【${shown}】${after}${e + contextChars < text.length ? '[...]' : ''}`
      // 入りきらない一致は次のページへ（1件目は必ず出す。見出しと続きの cursor の行の分を残す）
      if (lines.length > 0 && used + line.length + 1 > SEARCH_OUTPUT_BUDGET) {
        next = { u, o: s }
        break outer
      }
      hits += 1
      counts.set(unit.index, (counts.get(unit.index) ?? 0) + 1)
      lines.push(line)
      used += line.length + 1
    }
  }
  const what = `「${query}」${mode === 'regex' ? '（正規表現）' : ''}`
  const where = `${scope === 'adopted' ? '採用原稿' : 'すべての稿'}・#${range.from}〜#${range.to}・ルビを除いた本文`
  // 続きがあれば、このページで調べたのは範囲の途中まで（「見つかりません」「N件」を全体の答えのように言わない）
  let note = ''
  if (next) {
    const ref = (u: number) => units[u]?.label.split(' ')[0] ?? `#${range.from}`
    const first = opts.cursor ? ref(at.u) : `#${range.from}`
    // 最後に（途中まで・すべて）調べた区切り
    const lastU = next.o > 0 ? next.u : next.u - 1
    const last = ref(Math.max(lastU, at.u))
    const span = first === last ? first : `${first}〜${last}`
    note = `。${span} まで調べました${next.o > 0 ? `（${last} は途中まで）` : ''}。残りは 続き の cursor で（cursor が無くなるまで探し終わっていません）`
  }
  const head = opts.countOnly
    ? `${what} ${next ? 'ここまで ' : ''}${formatCount(total + hits)}件（${where}）${counts.size ? `: ${[...counts].map(([i, n]) => `#${i} ×${n}`).join('、')}` : ''}${note}`
    : `${what} の検索（${where}）: ${
        hits
          ? `${formatCount(total + 1)}〜${formatCount(total + hits)}件目`
          : next
            ? total
              ? 'ここまで新しい一致はありません'
              : 'ここまで見つかりません'
            : total
              ? '続きはありません'
              : '見つかりません'
      }${note}`
  const nextCursor = next ? encodeCursor({ k: 'search', t: titleId, q: qkey, u: next.u, o: next.o, n: total + hits }) : null
  const tail = nextCursor ? [`続き: cursor="${nextCursor}"（${units[next!.u].label}から）`] : []
  return { ok: true, text: [head, ...lines, ...tail].join('\n'), nextCursor }
}
