// 各話テキスト書き出し: 選んだタイトルの採用原稿を、1話1ファイルのテキストにする。
// ファイル名は「yyyymmddタイトル名_第n話.txt」（特殊ブロックは見出し名）。採用原稿のない話は飛ばす。
// 話数を章ごとに振っている時は、章の中の話に章の並び順と章名を付ける（「yyyymmddタイトル名_2二章_第1話.txt」）。
// 第n話が章ごとに重なっても、名前の順が読む順になり、どの章の話か分かるように。見出しにも章名を入れる。
// 同じ名前になる時（同じ見出しの特殊ブロックなど）は (2)(3)… を付ける。
// 本文はルビ・傍点の記法（カクヨム式）のまま書き出す（そのまま投稿できるように）。
// 幕に分けた話も1話1ファイルで、各幕の本文の前に幕の見出し（第1幕…）を入れる。採用稿のない幕は飛ばす。
import {
  actLabel,
  actParts,
  adoptedText,
  chaptersOf,
  effectiveNumbering,
  episodeNumbers,
  flatten,
  isSplit,
  pieceLabel,
} from './structure'
import type { AppData, ID } from './types'

export interface EpisodeFile {
  pieceId: ID
  name: string
  text: string
}

export interface EpisodeExportOptions {
  /** 本文の先頭に見出し（第n話・題）を入れる */
  withHeading: boolean
  /** ファイル名の日付 */
  date: Date
}

/** 書き出す1話分（本文はまだテキストファイルの形にしていない） */
export interface EpisodeEntry {
  pieceId: ID
  /** ファイル名（.txt まで） */
  name: string
  /** 「第1話　旅立ち」のような見出し */
  heading: string
  /** 採用原稿の本文（記法のまま。幕に分けた話は各幕の採用稿をつないだもの） */
  body: string
  /** 幕に分けた話: 書き出す幕（採用稿のある幕だけ。読む順）。分けていなければ無い */
  acts?: { label: string; body: string }[]
}

/** ファイル名に使えない文字を置き換える（Windows・iPhone・Android のどれでも使える名前にする） */
export function fileSafe(name: string, fallback = '無題'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  // 文字（コードポイント）単位で切る（サロゲートペアの途中で切らない）。切った末尾の点・空白も除く
  const cut = Array.from(cleaned || fallback)
    .slice(0, 80)
    .join('')
    .replace(/[. ]+$/, '')
  return cut || fallback
}

export function yyyymmdd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 改行は CRLF（Windows のメモ帳でもそのまま読める） */
const toCrlf = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n')

/**
 * 書き出す話（読む順）とファイル名。本文の変換はしないので、ファイル名の一覧を出すだけなら長編でも軽い。
 * テキストにするのは episodeFileText（書き出す時に1話ずつ）。
 */
export function episodeEntries(data: AppData, titleId: ID, date: Date): EpisodeEntry[] {
  const title = data.titles[titleId]
  if (!title) return []
  const numbers = episodeNumbers(data, titleId)
  const prefix = `${yyyymmdd(date)}${fileSafe(title.name, '無題のタイトル')}_`
  const perChapter = effectiveNumbering(title) === 'perChapter'
  // 章ごとの話数では 第n話 が章ごとに重なるので、章の並び順と章名を付ける（名前の順＝読む順になるように桁をそろえる）
  const chapterNo = new Map(chaptersOf(data, titleId).map((c, i) => [c.id, i + 1]))
  const width = String(chapterNo.size).length
  // 大文字・小文字や Unicode の正規化だけが違う名前も、Windows・Mac では同じファイルになる
  const nameKey = (s: string) => s.normalize('NFC').toLowerCase()
  const used = new Set<string>()
  const entries: EpisodeEntry[] = []
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    const v = adoptedText(data, piece)
    if (!v) continue
    const label = pieceLabel(data, piece, numbers)
    const ch = perChapter && item.chapterId ? data.chapters[item.chapterId] : undefined
    const chName = ch ? ch.name.trim() || '無題の章' : ''
    const scope = ch ? `${String(chapterNo.get(ch.id) ?? 0).padStart(width, '0')}${fileSafe(chName)}_` : ''
    const base = `${prefix}${scope}${fileSafe(label)}`
    // 同じ名前になる時は (2)(3)… を付ける（付けた名前とも重ならないように、空くまで数を進める）
    let name = base
    for (let n = 2; used.has(nameKey(name)); n++) name = `${base}(${n})`
    used.add(nameKey(name))
    const head = ch ? `${chName}　${label}` : label
    const heading = piece.subtitle.trim() ? `${head}　${piece.subtitle.trim()}` : head
    const entry: EpisodeEntry = { pieceId: piece.id, name: `${name}.txt`, heading, body: v.body }
    if (isSplit(piece)) {
      entry.acts = actParts(data, piece).flatMap((x) => (x.version ? [{ label: actLabel(x.number), body: x.version.body }] : []))
    }
    entries.push(entry)
  }
  return entries
}

/** 末尾の改行（幕の見出しの前に空行を1つだけ入れるため） */
const trailingBreaks = /(?:\r\n|\r|\n)+$/

/** 本文の部分。幕に分けた話は、各幕の見出し・空行・幕の本文を空行でつなぐ */
function entryBody(entry: Pick<EpisodeEntry, 'body' | 'acts'>): string {
  if (!entry.acts) return entry.body
  return entry.acts
    .map((a, i) => `${a.label}\n\n${i < entry.acts!.length - 1 ? a.body.replace(trailingBreaks, '') : a.body}`)
    .join('\n\n')
}

/** 1話分のテキストファイルの中身（見出しを入れるなら先頭に見出しと空行） */
export function episodeFileText(entry: Pick<EpisodeEntry, 'heading' | 'body' | 'acts'>, withHeading: boolean): string {
  const body = entryBody(entry)
  return toCrlf(withHeading ? `${entry.heading}\n\n${body}` : body)
}

export function episodeFiles(data: AppData, titleId: ID, opts: EpisodeExportOptions): EpisodeFile[] {
  return episodeEntries(data, titleId, opts.date).map((e) => ({
    pieceId: e.pieceId,
    name: e.name,
    text: episodeFileText(e, opts.withHeading),
  }))
}
