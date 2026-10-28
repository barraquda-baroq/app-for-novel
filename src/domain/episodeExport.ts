// 各話テキスト書き出し: 選んだタイトルの採用原稿を、1話1ファイルのテキストにする。
// ファイル名は「yyyymmddタイトル名_第n話.txt」（特殊ブロックは見出し名）。採用原稿のない話は飛ばす。
// 本文はルビ・傍点の記法（カクヨム式）のまま書き出す（そのまま投稿できるように）。
import { activeVersion, episodeNumbers, flatten, pieceLabel } from './structure'
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

/** ファイル名に使えない文字を置き換える（Windows・iPhone・Android のどれでも使える名前にする） */
export function fileSafe(name: string, fallback = '無題'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  // 80文字で切る（サロゲートペアの途中で切らないよう、文字（コードポイント）単位で数える）
  return Array.from(cleaned || fallback)
    .slice(0, 80)
    .join('')
}

/**
 * 同じ名前（大文字小文字だけの違いも含む。Windows・Mac では同じファイルになる）が既にあれば (2)(3)… を付ける。
 * taken には付けた名前を入れていく
 */
export function uniqueFileStem(stem: string, taken: Set<string>): string {
  const key = (n: string) => n.normalize('NFC').toLowerCase()
  let name = stem
  for (let n = 2; taken.has(key(name)); n++) name = `${stem}(${n})`
  taken.add(key(name))
  return name
}

export function yyyymmdd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 改行は CRLF（Windows のメモ帳でもそのまま読める） */
const toCrlf = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n')

export function episodeFiles(data: AppData, titleId: ID, opts: EpisodeExportOptions): EpisodeFile[] {
  const title = data.titles[titleId]
  if (!title) return []
  const numbers = episodeNumbers(data, titleId)
  const prefix = `${yyyymmdd(opts.date)}${fileSafe(title.name, '無題のタイトル')}_`
  const taken = new Set<string>()
  const files: EpisodeFile[] = []
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    const v = activeVersion(data, piece)
    if (!v) continue
    const label = pieceLabel(data, piece, numbers)
    // 同じ見出しの特殊ブロックが複数ある時は (2)(3)… を付ける
    const base = uniqueFileStem(`${prefix}${fileSafe(label)}`, taken)
    const heading = piece.subtitle.trim() ? `${label}　${piece.subtitle.trim()}` : label
    const text = opts.withHeading ? `${heading}\n\n${v.body}` : v.body
    files.push({ pieceId: piece.id, name: `${base}.txt`, text: toCrlf(text) })
  }
  return files
}
