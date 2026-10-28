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

/** 書き出す1話分（本文はまだテキストファイルの形にしていない） */
export interface EpisodeEntry {
  pieceId: ID
  /** ファイル名（.txt まで） */
  name: string
  /** 「第1話　旅立ち」のような見出し */
  heading: string
  /** 採用原稿の本文（記法のまま） */
  body: string
}

/** ファイル名に使えない文字を置き換える（Windows・iPhone・Android のどれでも使える名前にする） */
export function fileSafe(name: string, fallback = '無題'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return (cleaned || fallback).slice(0, 80)
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
  const used = new Map<string, number>()
  const entries: EpisodeEntry[] = []
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    const v = activeVersion(data, piece)
    if (!v) continue
    const label = pieceLabel(data, piece, numbers)
    let base = `${prefix}${fileSafe(label)}`
    // 同じ見出しの特殊ブロックが複数ある時は (2)(3)… を付ける
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    if (seen > 0) base = `${base}(${seen + 1})`
    const heading = piece.subtitle.trim() ? `${label}　${piece.subtitle.trim()}` : label
    entries.push({ pieceId: piece.id, name: `${base}.txt`, heading, body: v.body })
  }
  return entries
}

/** 1話分のテキストファイルの中身（見出しを入れるなら先頭に見出しと空行） */
export function episodeFileText(entry: Pick<EpisodeEntry, 'heading' | 'body'>, withHeading: boolean): string {
  return toCrlf(withHeading ? `${entry.heading}\n\n${entry.body}` : entry.body)
}

export function episodeFiles(data: AppData, titleId: ID, opts: EpisodeExportOptions): EpisodeFile[] {
  return episodeEntries(data, titleId, opts.date).map((e) => ({
    pieceId: e.pieceId,
    name: e.name,
    text: episodeFileText(e, opts.withHeading),
  }))
}
