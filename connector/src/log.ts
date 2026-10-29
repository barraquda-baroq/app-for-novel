// ログ（Workers Logs）。原稿・トークン・URL の問い合わせ部分は決して出さない。
// - 出せるのは短い印（event）と、数・真偽・短い記号だけ。文字列は 200 字を超えたら出さない（本文が紛れ込まないように）。
//   ASCII 以外の文字（日本語など）はすべて … に置き換える（原稿・題・名前がどの経路からも出ないように）
// - URL は host とパスだけ（?state=…&k=… を出さない）
export type LogValue = string | number | boolean | null | undefined

const MAX = 200

/** ASCII の表示できる文字だけにする */
const asciiOnly = (s: string) => s.replace(/[^\x20-\x7e]+/g, '…')

/** ログに出してよい値にする（長い文字列・オブジェクトは出さない） */
export function safeValue(v: unknown): LogValue {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v as LogValue
  if (typeof v === 'string') return v.length > MAX ? `[${v.length}字の文字列は出しません]` : asciiOnly(v)
  return `[${typeof v}]`
}

/** URL の host とパスだけ */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return '[URL]'
  }
}

/** 例外を短い印にする（メッセージは 200 字まで。トークンらしい長い英数字は伏せる） */
export function safeError(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const msg = e instanceof Error ? e.message : String(e)
  const masked = asciiOnly(msg).replace(/[A-Za-z0-9_\-.]{40,}/g, '[…]')
  return `${asciiOnly(name)}: ${masked}`.slice(0, MAX)
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  const out: Record<string, LogValue> = { event: safeValue(event) }
  for (const [k, v] of Object.entries(fields)) out[k] = safeValue(v)
  console.log(JSON.stringify(out))
}

export function logError(event: string, e: unknown, fields: Record<string, unknown> = {}): void {
  log(event, { ...fields, error: safeError(e) })
}
