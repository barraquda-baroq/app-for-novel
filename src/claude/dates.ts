// 日付（日本時間）。推敲案の実行日・戦略メモ・作品批評の日付は日本時間の YYYY-MM-DD で持つ
// （コネクタは UTC で動くので、端末とコネクタで日付がずれないように同じ関数を使う）。
// このフォルダ（src/claude）はアプリとコネクタ（Cloudflare Worker）の両方が使う純粋な部品。React・Dexie・Firebase・Zustand を読み込まない。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の日付・時刻を4桁の年で書ける時刻の上限（ms。日本時間の 9999-12-31 23:59:59.999） */
export const MAX_JST_TS = Date.UTC(9999, 11, 31, 23, 59, 59, 999) - JST_OFFSET_MS

/**
 * 記録の時刻として使えるか（0 以上・MAX_JST_TS 以下の整数の ms）。コネクタが書いた時刻（2.8: アイデアへの追記の依頼の createdAt）を
 * 確かめる（Date の範囲の外の値で、日付の行を作る時に投げないように）
 */
export function isJstTimestamp(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0 && ts <= MAX_JST_TS
}

/** 日付にできない時刻（数でない・Date の範囲の外・4桁の年でない）の代わり（日本時間の 1970-01-01 00:00） */
const FALLBACK_ISO = '1970-01-01T00:00:00.000Z'

/** 日本時間の時刻の ISO の形（日付にできない時刻は FALLBACK_ISO。投げない） */
function jstIso(ts: number): string {
  if (typeof ts !== 'number') return FALLBACK_ISO
  const d = new Date(ts + JST_OFFSET_MS)
  if (Number.isNaN(d.getTime())) return FALLBACK_ISO
  const s = d.toISOString()
  return /^\d{4}-/.test(s) ? s : FALLBACK_ISO
}

/** 日本時間の日付（YYYY-MM-DD。日付にできない時刻は 1970-01-01） */
export function jstDate(ts: number): string {
  return jstIso(ts).slice(0, 10)
}

/** 日本時間の日付と時刻（「2026/11/12 14:32」。2.8: Claude が作るアイデアの1行目。日付にできない時刻は 1970/01/01 00:00） */
export function jstMinute(ts: number): string {
  const s = jstIso(ts)
  return `${s.slice(0, 4)}/${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`
}

/** 日本時間の日付（「2026/11/12」。2.8: アイデアへの追記の行「2026/11/12のセッションで以下の内容へ変更」。投げない） */
export function jstSlashDate(ts: number): string {
  return jstDate(ts).replace(/-/g, '/')
}

/** YYYY-MM-DD の形の、実在する日付か */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** 「10/28」（同じ年なら月日だけ、違う年なら「2025/10/28」） */
export function shortDate(iso: string, today?: string): string {
  if (!isIsoDate(iso)) return iso
  const [y, m, d] = iso.split('-')
  const md = `${Number(m)}/${Number(d)}`
  return today && today.slice(0, 4) !== y ? `${y}/${md}` : md
}
