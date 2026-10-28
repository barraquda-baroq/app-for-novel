// Firestore の文書の形。1レコード = 1文書（users/{uid}/records/{表名}:{id}）。
// レコードはキーを並べ替えた JSON 文字列として保存する（端末内の内容とそのまま比べられ、
// Firestore が扱えない値（undefined など）にも困らない）。1MiB の文書の上限を超えそうな大きなレコードは
// 分割文書（{表名}:{id}#{n}）に分けて同じトランザクションで書く。
import type { TableName } from '../domain/types'
import { stableStringify, type Rec } from './merge'

export const RECORDS = 'records'

/** 1つの文書に入れる JSON の最大の長さ（UTF-16 の文字数。UTF-8 で最大 3 バイト/文字なので 1MiB に収まる） */
export const CHUNK_CHARS = 250_000

export interface RecordDoc {
  table: TableName
  id: string
  /** レコードの JSON。削除した時と、分割した時は null */
  json: string | null
  /** 分割した数（0 = 分割していない） */
  chunks: number
  deleted: boolean
  /** JSON の指紋（削除した時は ''）。送る前に、クラウド側が前回揃えた時から変わっていないかを確かめる */
  hash: string
  /** サーバー時刻（差分の取得に使う） */
  updated: unknown
  /** 書いた端末 */
  device: string
}

export interface ChunkDoc {
  table: '_chunk'
  parent: string
  index: number
  json: string
  hash: string
  updated: unknown
  device: string
}

export const docIdOf = (table: string, id: string) => `${table}:${id}`
export const chunkIdOf = (parent: string, index: number) => `${parent}#${index}`

/** 53 ビットの文字列ハッシュ（cyrb53） */
function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function hashJson(json: string | null): string {
  if (json === null) return ''
  return `${cyrb53(json, 1)}.${cyrb53(json, 2)}.${json.length.toString(36)}`
}

/** レコードの指紋（null = 無い） */
export function hashRecord(rec: Rec | null | undefined): string {
  return rec ? hashJson(stableStringify(rec)) : ''
}

export interface Encoded {
  /** 文書に直接入れる JSON（分割した時・削除の時は null） */
  json: string | null
  /** 分割した JSON（分割しない時は空） */
  parts: string[]
  hash: string
  /** 書く量の目安（文字数） */
  size: number
}

/** サロゲートペアの途中で切らないように分割する */
export function splitJson(json: string, size = CHUNK_CHARS): string[] {
  const parts: string[] = []
  let i = 0
  while (i < json.length) {
    let end = Math.min(json.length, i + size)
    const last = json.charCodeAt(end - 1)
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    parts.push(json.slice(i, end))
    i = end
  }
  return parts
}

export function encodeRecord(rec: Rec | null, chunkSize = CHUNK_CHARS): Encoded {
  if (!rec) return { json: null, parts: [], hash: '', size: 0 }
  const json = stableStringify(rec)
  const hash = hashJson(json)
  if (json.length <= chunkSize) return { json, parts: [], hash, size: json.length }
  return { json: null, parts: splitJson(json, chunkSize), hash, size: json.length }
}

/**
 * 文書からレコードを取り出す。分割した文書は getChunk で分割文書を探す。
 * 戻り値: レコード（削除なら null）。分割文書が揃わない・指紋が合わない時は undefined（読み直しが要る）。
 */
export function decodeRecord(doc: RecordDoc, getChunk: (index: number) => ChunkDoc | undefined): Rec | null | undefined {
  if (doc.deleted) return null
  let json = doc.json
  if (json === null) {
    if (!doc.chunks) return undefined
    const parts: string[] = []
    for (let i = 0; i < doc.chunks; i++) {
      const c = getChunk(i)
      if (!c || c.hash !== doc.hash) return undefined
      parts.push(c.json)
    }
    json = parts.join('')
  }
  if (hashJson(json) !== doc.hash) return undefined
  try {
    const rec = JSON.parse(json) as Rec
    return rec && typeof rec === 'object' && rec.id === doc.id ? rec : undefined
  } catch {
    return undefined
  }
}
