// 通し読みの縦書きのページ表示: 本文を、タイトルの字数×行数（Title.pageSetup）のページに組む。一太郎で組んだ時の見積もり
// （ぴったり同じにはならない）。純粋な計算だけで、画面は持たない（React・DOM を使わない）。
//
// ■ 組み方
// - 話（第n話・特殊ブロック）ごとに新しいページから始める。話の頭に見出しの行「第n話　題」（通し読みと同じ表記）と空行1行。
// - 幕に分けた話は、幕の境目でページを変えない。幕の見出し（「第1幕」。通し読みと同じ）を1行に置き、続けて幕の本文。
//   採用稿のない話・幕は「採用原稿がありません。」の1行。章の見出しはページに入れない（画面がページの外に出す）。
// - 段落（本文の改行）ごとに新しい行。空行も1行。字下げは書いたとおり（自動で下げない）。話の末尾の空行は数えない
//   （白紙のページを作らないため）。
// - 1行の字数: 全角は1マス、半角の英数字・記号・空白と半角カナは 0.5 マス（縦中横はしない）。「――」「……」は書いたとおり
//   1字1マス。ルビ・傍点の記法は親文字だけをマスに数える（記法は行の text に残すので、画面はルビを小さく出せる）。
//   異体字セレクタ・結合文字などは幅 0（前の字に付ける）。
// - 禁則:
//   - ぶら下げ: 行頭に来る「、」「。」「，」「．」（半角の「､」「｡」も）は、前の行の最後のマスの外に出す（hang）。
//   - 追い込み: 行頭に来る閉じ括弧（」』）】〉》］｝〕〗〙〟’” など）・「？」「！」（全角・半角、‼⁉ も）・「ー」は、前の行の
//     末尾に入れる（その行は字数を超える。cells で分かる）。字数を超える分は3マスまで（それより多いと、残りは次の行の頭に置く）。
//   - ルビは途中で行を分けない（入らなければ次の行へ。親文字が1行より長い時だけ、1行ずつに分けて読みも割り振る）。
//     傍点は1字ずつ分けられ、行ごとに《《…》》で閉じ直す。
//
// ■ 使い方（画面から）
//   const cache = useMemo(() => createPageCache(), [])            // 画面を開いている間の覚え（話ごと）
//   const setup = pageSetupOf(title)                              // src/domain/pageSetup.ts
//   const layout = useMemo(
//     () => (vertical ? layoutVerticalPages(blocks, setup, cache) : null),
//     [vertical, blocks, setup.chars, setup.lines, cache],
//   )
//   layout.totalPages                       … 全体のページ数
//   layout.episodes[i].startPage / pageCount … 話の最初のページの番号（1から）とページ数（目次のページ番号に）
//   layout.episodes[i].pages[j][k]           … j ページ目の k 行目（PageLine）
//   layout.episodes[i].acts                  … 幕の見出しの行の場所（ページの番号・ページの中の行）
//   layout.byPiece.get(pieceId)              … 話の id から
//   locatePage(layout, page)                 … 通しのページ番号から、その話と話の中のページ
// 覚え（cache）があると、本文・見出し・字数が変わらない話は組み直さず、pages は前と同じ配列のまま
// （話ごとの React.memo の部品に pages と startPage を渡せば、変わった話だけを描き直せる）。
// 行数だけを変えた時は、行の分け方はそのままでページに分け直すだけ。80万字でも、すべて組むのに数十ミリ秒
// （すべての段落にルビ・傍点があっても百ミリ秒ほど）、行数だけの組み直しは1ミリ秒ほど（verticalPages.test.ts）。
// 1話だけを組む時は paginateEpisode(episodeSourceOf(block), setup)、本文だけを行に分ける時は layoutBody(text, chars)。
import { NO_ACTIVE_MESSAGE, type ReadBlock } from '../../domain/readthrough'
import { parseRuby, stripRubyMap } from '../../domain/ruby'
import type { ID, PageSetup } from '../../domain/types'
import { TCY_MAX_DIGITS, type PieceBlock } from './readLogic'

export type PageLineKind =
  /** 話の見出し（第n話　題）。長ければ何行にもなる */
  | 'heading'
  /** 幕の見出し（第1幕） */
  | 'act'
  /** 本文 */
  | 'text'
  /** 空行（見出しの後の1行と、本文の空行） */
  | 'blank'
  /** 「採用原稿がありません。」 */
  | 'missing'

/** ページの1行（縦書きでは1列）。組んだ後は変えない */
export interface PageLine {
  kind: PageLineKind
  /**
   * 行の文字。本文（text）はルビ・傍点の記法のまま（RubyText でそのまま出せる。傍点は行ごとに《《…》》で閉じてある）。
   * 見出し・幕の見出し・採用原稿なしは記法として読まない文字そのまま（通し読みの見出しと同じ）。空行は ''
   */
  text: string
  /** 使ったマスの数（半角は 0.5）。ぶら下げ・追い込みの分を含むので、1行の字数を超えることがある */
  cells: number
  /** 行末に最後のマスの外へぶら下げた句読点のマス（無ければ 0。半角の句読点は 0.5） */
  hang: number
  /** 幕の見出しの行: 幕の id */
  actId?: ID
}

/** 1ページ（1行目から順に。最大で字数×行数の行数） */
export type Page = readonly PageLine[]

/** 幕の見出しの場所（話の中） */
export interface ActMark {
  /** 幕の id */
  pieceId: ID
  label: string
  /** 話の中の何ページ目か（0から） */
  pageIndex: number
  /** そのページの何行目か（0から） */
  line: number
}

/** 1話を組んだもの（話の最初のページからの数え方。通しのページ番号は持たない） */
export interface EpisodeLayout {
  /** ページ（最低1ページ）。本文・見出し・字数×行数が変わらない限り、覚え（PageCache）から同じ配列を返す */
  pages: readonly Page[]
  /** 行の数（最後のページの空きは数えない） */
  lineCount: number
  /** 幕に分けた話: 幕の見出しの場所（読む順）。分けていなければ空 */
  acts: readonly ActMark[]
}

/** 組む前の1話: 見出しと、本文（幕に分けた話は幕ごと） */
export interface EpisodeSource {
  /** 「第3話　旅立ち」（通し読みと同じ表記） */
  heading: string
  /**
   * 幕に分けていない話は1つ（label なし）、幕に分けた話は幕ごと（label = 「第1幕」、actId = 幕の id）。
   * body が null なら採用原稿なし
   */
  parts: readonly { body: string | null; label?: string; actId?: ID }[]
}

/** 通しのページ番号を付けた1話 */
export interface EpisodePages {
  pieceId: ID
  kind: 'episode' | 'special'
  chapterId: ID | null
  /** 見出し（第n話　題） */
  heading: string
  /** 最初のページの番号（渡したブロックの最初の話を1とする。章だけの通し読みでは章の中で1から） */
  startPage: number
  pageCount: number
  /** 話の中のページ（EpisodeLayout.pages と同じ配列） */
  pages: readonly Page[]
  lineCount: number
  /** 幕に分けた話: 幕の見出しの通しのページ番号とページの中の行（0から）。分けていなければ null */
  acts: readonly { pieceId: ID; label: string; page: number; line: number }[] | null
}

export interface VerticalPagesLayout {
  setup: PageSetup
  /** 話（ブロックの中の piece）を読む順に */
  episodes: readonly EpisodePages[]
  /** 全体のページ数（話が無ければ 0） */
  totalPages: number
  byPiece: ReadonlyMap<ID, EpisodePages>
}

// ---------- 字の幅と禁則 ----------

/** 幅は半マスを1とした数（全角 = 2） */
const HALF = 1
const FULL = 2
/** 追い込み・ぶら下げで1行の字数を超えてよい幅（半マス。3マス） */
const MAX_OVER = 6

const CLS_NORMAL = 0
/** ぶら下げる句読点 */
const CLS_HANG = 1
/** 行頭に置かない（追い込む） */
const CLS_NOSTART = 2

const HANG_CHARS = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 0xff64, 0xff61])
const NOSTART_CHARS = new Set([
  // 閉じ括弧
  0x300d, 0x300f, 0xff09, 0x3011, 0x3009, 0x300b, 0xff3d, 0xff5d, 0x3015, 0x3017, 0x3019, 0x301b, 0x301e, 0x301f, 0x2019, 0x201d,
  0xff63, 0x29, 0x5d, 0x7d,
  // ？！（全角・半角）と ‼ ⁇ ⁈ ⁉
  0xff1f, 0xff01, 0x3f, 0x21, 0x203c, 0x2047, 0x2048, 0x2049,
  // 長音（全角・半角）
  0x30fc, 0xff70,
])

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2060 ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x3099 ||
    cp === 0x309a ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
}

/** 字の幅（半マスを1）。半角の英数字・記号・空白と半角カナは 1、幅の無い字は 0、ほかは 2 */
function widthOf(cp: number): number {
  if (cp <= 0x7e) return cp >= 0x20 ? HALF : cp === 0x09 ? FULL : 0
  if (cp === 0x7f) return 0
  // かな・漢字（結合用の濁点・半濁点だけは幅 0）
  if (cp >= 0x3040 && cp <= 0x9fff) return cp === 0x3099 || cp === 0x309a ? 0 : FULL
  if (cp >= 0xff61 && cp <= 0xff9f) return HALF
  return isZeroWidth(cp) ? 0 : FULL
}

function classOf(cp: number): number {
  // かな・漢字はどれでもない（よく出る字を先に返す）
  if ((cp >= 0x3040 && cp <= 0x30fb) || (cp >= 0x4e00 && cp <= 0x9fff)) return CLS_NORMAL
  if (HANG_CHARS.has(cp)) return CLS_HANG
  return NOSTART_CHARS.has(cp) ? CLS_NOSTART : CLS_NORMAL
}

/** s の i の位置の字（サロゲートペアは1字）。長さは cpLen に入れる */
let cpLen = 1
function codePointAt(s: string, i: number): number {
  const c = s.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1)
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      cpLen = 2
      return (c - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000
    }
  }
  cpLen = 1
  return c
}

// ---------- 段落を行に分ける ----------
// 段落を「分けられない単位」（字・ルビ・傍点の1字・｜《）に分け、幅と禁則の種類を並べてから行に分ける。
// 単位は使い回す型付き配列に置く（数十万字でも字ごとのオブジェクトを作らない）。

/** 単位の元の段落での範囲 [start, end)（傍点は中の1字の範囲） */
let uStart = new Int32Array(1024)
let uEnd = new Int32Array(1024)
let uWidth = new Uint16Array(1024)
let uClass = new Uint8Array(1024)
/** -1 = 段落の文字をそのまま、0 以上 = 傍点（同じ番号が1つの《《…》》）、-2 以下 = 分けたルビ（overrides[-g - 2] の文字） */
let uGroup = new Int32Array(1024)
const overrides: string[] = []

function ensureUnits(n: number): void {
  if (uStart.length >= n) return
  const size = Math.max(n, uStart.length * 2)
  const grow = <T extends Int32Array | Uint16Array | Uint8Array>(a: T, make: (n: number) => T): T => {
    const b = make(size)
    b.set(a)
    return b
  }
  uStart = grow(uStart, (k) => new Int32Array(k))
  uEnd = grow(uEnd, (k) => new Int32Array(k))
  uWidth = grow(uWidth, (k) => new Uint16Array(k))
  uClass = grow(uClass, (k) => new Uint8Array(k))
  uGroup = grow(uGroup, (k) => new Int32Array(k))
}

/** 字 [i, i + len) を単位に足す。幅の無い字は、続いている前の単位（同じ種類）に付ける。単位の数を返す */
function pushChar(n: number, cp: number, i: number, len: number, group: number): number {
  const w = widthOf(cp)
  if (w === 0 && n > 0 && uEnd[n - 1] === i && uGroup[n - 1] === group) {
    uEnd[n - 1] = i + len
    return n
  }
  uStart[n] = i
  uEnd[n] = i + len
  uWidth[n] = w
  uClass[n] = w === 0 ? CLS_NOSTART : classOf(cp)
  uGroup[n] = group
  return n + 1
}

/** 記法として読まない段落（見出しなど・記法の無い本文）を単位に分ける */
function unitsPlain(p: string): number {
  ensureUnits(p.length + 1)
  let n = 0
  for (let i = 0; i < p.length; ) {
    const cp = codePointAt(p, i)
    const len = cpLen
    n = pushChar(n, cp, i, len, -1)
    i += len
  }
  return n
}

/**
 * 見出し（話・幕）を単位に分ける。画面は見出しの2桁までの半角数字を縦中横（1マス）で出す（Tcy.tsx。readLogic.ts の splitTcy）ので、
 * その数字は分けられない全角1字に数える（「第1話」は3マス）。3桁以上の数字は半角のまま数え、行では分けない
 * （分けると、行ごとに縦中横にする画面と数え方がずれる）
 */
function unitsHeading(p: string): number {
  ensureUnits(p.length + 1)
  let n = 0
  for (let i = 0; i < p.length; ) {
    const c = p.charCodeAt(i)
    if (c >= 0x30 && c <= 0x39) {
      let j = i + 1
      while (j < p.length && p.charCodeAt(j) >= 0x30 && p.charCodeAt(j) <= 0x39) j++
      uStart[n] = i
      uEnd[n] = j
      uWidth[n] = j - i <= TCY_MAX_DIGITS ? FULL : (j - i) * HALF
      uClass[n] = CLS_NORMAL
      uGroup[n] = -1
      n++
      i = j
      continue
    }
    const cp = codePointAt(p, i)
    const len = cpLen
    n = pushChar(n, cp, i, len, -1)
    i += len
  }
  return n
}

/** ルビ・傍点の記法のある段落を単位に分ける（記法の読み方は src/domain/ruby.ts と同じ: stripRubyMap） */
function unitsMarkup(p: string, cap: number): number {
  overrides.length = 0
  const m = stripRubyMap(p)
  const t = m.text
  ensureUnits(t.length + 1)
  let n = 0
  let bouten = 0
  let k = 0
  while (k < t.length) {
    const s = m.start[k]
    const e = m.end[k]
    if (e - s === 1) {
      // ふつうの字（サロゲートペアは続く1つと合わせて1字）
      const cp = codePointAt(t, k)
      const len = cpLen
      n = pushChar(n, cp, s, len === 2 && m.start[k + 1] === e ? 2 : 1, -1)
      k += len
      continue
    }
    // 記法1つ分（同じ範囲を指す字が続く）
    let k2 = k + 1
    while (k2 < t.length && m.start[k2] === s && m.end[k2] === e) k2++
    if (p.charCodeAt(s) === 0x300a && p.charCodeAt(s + 1) === 0x300a) {
      // 傍点《《…》》: 中の字を1字ずつ（同じ番号で、行ごとに閉じ直す）
      const g = bouten++
      for (let j = s + 2; j < e - 2; ) {
        const cp = codePointAt(p, j)
        const len = cpLen
        n = pushChar(n, cp, j, len, g)
        j += len
      }
    } else if (k2 - k === 1 && e - s === 2 && t.charCodeAt(k) === 0x300a) {
      // ｜《 は《そのもの（記法のまま残す）
      uStart[n] = s
      uEnd[n] = e
      uWidth[n] = FULL
      uClass[n] = CLS_NORMAL
      uGroup[n] = -1
      n++
    } else {
      // ルビ: 親文字の幅で1つの単位（行の途中で分けない）
      let w = 0
      for (let j = k; j < k2; ) {
        w += widthOf(codePointAt(t, j))
        j += cpLen
      }
      if (w <= cap) {
        uStart[n] = s
        uEnd[n] = e
        uWidth[n] = w
        uClass[n] = CLS_NORMAL
        uGroup[n] = -1
        n++
      } else n = splitRuby(n, p.slice(s, e), s, e, cap)
    }
    k = k2
  }
  return n
}

/** 1行より長い親文字のルビを、1行ずつの親文字に分ける（読みは親文字の字数で割り振る。割り振る読みが無い部分は親文字だけ） */
function splitRuby(n: number, markup: string, s: number, e: number, cap: number): number {
  const seg = parseRuby(markup).find((x) => x.type === 'ruby')
  const base = seg && seg.type === 'ruby' ? Array.from(seg.base) : Array.from(markup)
  const reading = seg && seg.type === 'ruby' ? Array.from(seg.reading) : []
  const chunks: { text: string; width: number; from: number; to: number }[] = []
  let cur = { text: '', width: 0, from: 0, to: 0 }
  base.forEach((ch, i) => {
    const w = widthOf(ch.codePointAt(0) ?? 0)
    if (cur.width + w > cap && cur.text) {
      chunks.push(cur)
      cur = { text: '', width: 0, from: i, to: i }
    }
    cur.text += ch
    cur.width += w
    cur.to = i + 1
  })
  if (cur.text) chunks.push(cur)
  for (const c of chunks) {
    const r = reading.slice(
      Math.round((c.from * reading.length) / base.length),
      Math.round((c.to * reading.length) / base.length),
    )
    overrides.push(r.length ? `｜${c.text}《${r.join('')}》` : c.text)
    uStart[n] = s
    uEnd[n] = e
    uWidth[n] = c.width
    uClass[n] = CLS_NORMAL
    uGroup[n] = -2 - (overrides.length - 1)
    n++
  }
  return n
}

/** 単位 [from, to) の行の文字（傍点は行の中で閉じる） */
function lineText(p: string, from: number, to: number): string {
  let out = ''
  let runS = -1
  let runE = -1
  let bg = -1
  let bS = 0
  let bE = 0
  for (let i = from; i < to; i++) {
    const g = uGroup[i]
    if (g >= 0) {
      if (runS >= 0) {
        out += p.slice(runS, runE)
        runS = -1
      }
      if (bg !== g) {
        if (bg >= 0) out += `《《${p.slice(bS, bE)}》》`
        bg = g
        bS = uStart[i]
      }
      bE = uEnd[i]
      continue
    }
    if (bg >= 0) {
      out += `《《${p.slice(bS, bE)}》》`
      bg = -1
    }
    if (g === -1) {
      if (runS >= 0 && runE === uStart[i]) runE = uEnd[i]
      else {
        if (runS >= 0) out += p.slice(runS, runE)
        runS = uStart[i]
        runE = uEnd[i]
      }
    } else {
      if (runS >= 0) {
        out += p.slice(runS, runE)
        runS = -1
      }
      out += overrides[-g - 2]
    }
  }
  if (runS >= 0) out += p.slice(runS, runE)
  if (bg >= 0) out += `《《${p.slice(bS, bE)}》》`
  return out
}

function makeLine(kind: PageLineKind, text: string, used: number, hang: number, actId?: ID): PageLine {
  const line: PageLine = { kind, text, cells: used / 2, hang: hang / 2 }
  if (actId !== undefined) line.actId = actId
  return line
}

/** 単位に分けた段落 p（n 単位）を1行 cap（半マス）の行に分けて out に足す */
function breakUnits(out: PageLine[], p: string, n: number, cap: number, kind: PageLineKind, actId?: ID): void {
  let from = 0
  let used = 0
  let hang = 0
  for (let i = 0; i < n; i++) {
    const w = uWidth[i]
    if (w === 0 || used + w <= cap || i === from) {
      used += w
      continue
    }
    // 入らない: ぶら下げ・追い込みで前の行に入れるか、次の行へ
    const c = uClass[i]
    if (c === CLS_HANG && hang === 0 && used <= cap) {
      hang = w
      used += w
      continue
    }
    if (c !== CLS_NORMAL && used + w - cap <= MAX_OVER) {
      used += w
      continue
    }
    out.push(makeLine(kind, lineText(p, from, i), used, hang, actId))
    from = i
    used = w
    hang = 0
  }
  out.push(makeLine(kind, lineText(p, from, n), used, hang, actId))
}

const BLANK: PageLine = Object.freeze({ kind: 'blank', text: '', cells: 0, hang: 0 }) as PageLine

const PARA_SPLIT = /\r\n?|\n/

/** 記法として読まない1行の文字（見出しなど）を行に分けて足す */
function pushPlain(out: PageLine[], text: string, cap: number, kind: PageLineKind, actId?: ID): void {
  if (text === '') {
    out.push(kind === 'blank' ? BLANK : makeLine(kind, '', 0, 0, actId))
    return
  }
  breakUnits(out, text, kind === 'heading' || kind === 'act' ? unitsHeading(text) : unitsPlain(text), cap, kind, actId)
}

/** 本文を段落ごとに行に分けて足す（末尾の改行の後ろは段落にしない） */
function pushBody(out: PageLine[], body: string, cap: number): void {
  if (body === '') return
  const paras = body.split(PARA_SPLIT)
  if (paras[paras.length - 1] === '') paras.pop()
  for (const p of paras) {
    if (p === '') {
      out.push(BLANK)
      continue
    }
    const n = p.indexOf('《') >= 0 ? unitsMarkup(p, cap) : unitsPlain(p)
    breakUnits(out, p, n, cap, 'text')
  }
}

/**
 * 本文を1行 chars 字の行に分ける（見出しを付けない・ページに分けない）。本文の空行は空行の行、
 * 末尾の改行の後ろは行にしない。chars は 1 以上の整数
 */
export function layoutBody(body: string, chars: number): PageLine[] {
  const out: PageLine[] = []
  pushBody(out, body, Math.max(1, Math.floor(chars)) * 2)
  return out
}

// ---------- 話をページに組む ----------

/** 行に分けた1話（字数だけで決まる。行数は使わない） */
interface BrokenEpisode {
  lines: PageLine[]
  /** 幕の見出しの行の位置（話の中の何行目か） */
  acts: { pieceId: ID; label: string; index: number }[]
}

function breakEpisode(src: EpisodeSource, chars: number): BrokenEpisode {
  const cap = Math.max(1, Math.floor(chars)) * 2
  const lines: PageLine[] = []
  pushPlain(lines, src.heading, cap, 'heading')
  lines.push(BLANK)
  const bodyStart = lines.length
  const acts: BrokenEpisode['acts'] = []
  for (const part of src.parts) {
    if (part.label !== undefined) {
      acts.push({ pieceId: part.actId ?? '', label: part.label, index: lines.length })
      pushPlain(lines, part.label, cap, 'act', part.actId)
    }
    if (part.body === null) pushPlain(lines, NO_ACTIVE_MESSAGE, cap, 'missing')
    else pushBody(lines, part.body, cap)
  }
  // 話の末尾の空行は数えない（白紙のページを作らない）
  while (lines.length > bodyStart && lines[lines.length - 1].kind === 'blank') lines.pop()
  return { lines, acts }
}

function pageEpisode(broken: BrokenEpisode, linesPerPage: number): EpisodeLayout {
  const per = Math.max(1, Math.floor(linesPerPage))
  const { lines } = broken
  const pages: Page[] = []
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per))
  if (pages.length === 0) pages.push([])
  const acts = broken.acts.map(
    (a): ActMark => ({ pieceId: a.pieceId, label: a.label, pageIndex: Math.floor(a.index / per), line: a.index % per }),
  )
  return { pages, lineCount: lines.length, acts }
}

/** 1話をページに組む（覚えを使わない） */
export function paginateEpisode(src: EpisodeSource, setup: PageSetup): EpisodeLayout {
  return pageEpisode(breakEpisode(src, setup.chars), setup.lines)
}

/** 見出しの表記（通し読みと同じ「第n話　題」。題が無ければ「第n話」） */
export function episodeHeading(b: Pick<PieceBlock, 'label' | 'subtitle'>): string {
  const sub = b.subtitle.trim()
  return sub ? `${b.label}　${sub}` : b.label
}

/** 通し読みのブロック（話）から、組む前の1話を作る */
export function episodeSourceOf(b: PieceBlock): EpisodeSource {
  return {
    heading: episodeHeading(b),
    parts: b.acts ? b.acts.map((a) => ({ body: a.body, label: a.label, actId: a.pieceId })) : [{ body: b.body }],
  }
}

// ---------- 覚え ----------

interface CacheEntry {
  src: EpisodeSource
  chars: number
  broken: BrokenEpisode
  lines: number
  layout: EpisodeLayout
}

/** 話ごとの組んだ結果の覚え（createPageCache で作り、画面を開いている間持つ。中は見ない） */
export interface PageCache {
  /** 覚えている話の数 */
  readonly size: number
}

class EpisodeCache implements PageCache {
  readonly map = new Map<ID, CacheEntry>()
  get size(): number {
    return this.map.size
  }
}

export function createPageCache(): PageCache {
  return new EpisodeCache()
}

function sameSource(a: EpisodeSource, b: EpisodeSource): boolean {
  if (a === b) return true
  if (a.heading !== b.heading || a.parts.length !== b.parts.length) return false
  for (let i = 0; i < a.parts.length; i++) {
    const x = a.parts[i]
    const y = b.parts[i]
    if (x.body !== y.body || x.label !== y.label || x.actId !== y.actId) return false
  }
  return true
}

function cachedLayout(cache: EpisodeCache, id: ID, src: EpisodeSource, setup: PageSetup): EpisodeLayout {
  const hit = cache.map.get(id)
  if (hit && sameSource(hit.src, src)) {
    if (hit.chars === setup.chars) {
      if (hit.lines === setup.lines) return hit.layout
      // 行数だけが変わった: 行の分け方はそのままで、ページに分け直す
      const layout = pageEpisode(hit.broken, setup.lines)
      cache.map.set(id, { ...hit, lines: setup.lines, layout })
      return layout
    }
  }
  const broken = breakEpisode(src, setup.chars)
  const layout = pageEpisode(broken, setup.lines)
  cache.map.set(id, { src, chars: setup.chars, broken, lines: setup.lines, layout })
  return layout
}

/**
 * 通し読みのブロック（buildReadThrough の結果。章だけでもよい）の話を、字数×行数のページに組む。
 * ページの番号はブロックの最初の話を1とする。章の見出し（chapter・chapterEnd）はページに入れない。
 * cache を渡すと、変わっていない話は組み直さない（pages は前と同じ配列）
 */
export function layoutVerticalPages(blocks: readonly ReadBlock[], setup: PageSetup, cache?: PageCache): VerticalPagesLayout {
  const episodes: EpisodePages[] = []
  const byPiece = new Map<ID, EpisodePages>()
  let page = 1
  const store = cache instanceof EpisodeCache ? cache : null
  for (const b of blocks) {
    if (b.type !== 'piece') continue
    const src = episodeSourceOf(b)
    const lay = store ? cachedLayout(store, b.pieceId, src, setup) : paginateEpisode(src, setup)
    const start = page
    const ep: EpisodePages = {
      pieceId: b.pieceId,
      kind: b.kind,
      chapterId: b.chapterId,
      heading: src.heading,
      startPage: start,
      pageCount: lay.pages.length,
      pages: lay.pages,
      lineCount: lay.lineCount,
      acts: b.acts
        ? lay.acts.map((a) => ({ pieceId: a.pieceId, label: a.label, page: start + a.pageIndex, line: a.line }))
        : null,
    }
    episodes.push(ep)
    byPiece.set(b.pieceId, ep)
    page += lay.pages.length
  }
  return { setup: { chars: setup.chars, lines: setup.lines }, episodes, totalPages: page - 1, byPiece }
}

/**
 * 通しのページ番号（1から）の話と、話の中の何ページ目か（0から）。範囲の外なら null
 */
export function locatePage(
  layout: Pick<VerticalPagesLayout, 'episodes' | 'totalPages'>,
  page: number,
): { episode: EpisodePages; pageIndex: number } | null {
  if (!Number.isInteger(page) || page < 1 || page > layout.totalPages) return null
  const eps = layout.episodes
  let lo = 0
  let hi = eps.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (eps[mid].startPage <= page) lo = mid
    else hi = mid - 1
  }
  const episode = eps[lo]
  return { episode, pageIndex: page - episode.startPage }
}
