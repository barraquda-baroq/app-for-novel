// 日付（日本時間）。推敲案の実行日・戦略メモ・作品批評の日付は日本時間の YYYY-MM-DD で持つ
// （コネクタは UTC で動くので、端末とコネクタで日付がずれないように同じ関数を使う）。
// このフォルダ（src/claude）はアプリとコネクタ（Cloudflare Worker）の両方が使う純粋な部品。React・Dexie・Firebase・Zustand を読み込まない。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の日付（YYYY-MM-DD） */
export function jstDate(ts: number): string {
  return new Date(ts + JST_OFFSET_MS).toISOString().slice(0, 10)
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
