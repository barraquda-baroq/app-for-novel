// 回数の上限（Vault の SQLite に数える）。OAuth の KV（1日1,000回の書き込み）を、いたずらの接続要求で使い切らないように、
// /authorize の受け付け（beginConsent の前）と、DCR（ENABLE_DCR の時だけ）の登録を数える。
// /authorize は送ってきたネットワークごと（IPv4 は1つのアドレス、IPv6 は /48。生の IP は残さない）と、コネクタ全体の1日の上限の
// 両方で数える: 1か所から送り続けても、持ち主がほかのネットワークから接続できる分が残る。
// ネットワークごとの数は、その日の分だけを1つの記録に持つ（日が替われば捨てる。全体の上限までしか増えない）。
import type { MirrorStore } from './store'

export type RateKind = 'authorize' | 'register'

interface Limit {
  perHour?: number
  perDay: number
}

export const RATE_LIMITS: Record<RateKind, { source?: Limit; global: Limit }> = {
  // 全体の 300 回 ≒ KV の 300 回の書き込み（残りの約700回はトークンの更新と連携に）
  authorize: { source: { perHour: 10, perDay: 20 }, global: { perDay: 300 } },
  register: { global: { perHour: 10, perDay: 10 } },
}

export type RateResult = { ok: true } | { ok: false; scope: 'source' | 'global'; window: 'hour' | 'day' }

interface Counter {
  hour: string
  hourCount: number
  day: string
  dayCount: number
}

interface SourceCounters {
  day: string
  buckets: Record<string, Counter>
}

function fresh(cur: Counter | null | undefined, hour: string, day: string): Counter {
  return {
    hour,
    hourCount: cur && cur.hour === hour ? cur.hourCount : 0,
    day,
    dayCount: cur && cur.day === day ? cur.dayCount : 0,
  }
}

function over(c: Counter, limit: Limit): 'hour' | 'day' | null {
  if (c.dayCount >= limit.perDay) return 'day'
  if (limit.perHour !== undefined && c.hourCount >= limit.perHour) return 'hour'
  return null
}

const bump = (c: Counter): Counter => ({ ...c, hourCount: c.hourCount + 1, dayCount: c.dayCount + 1 })

/**
 * 1回分を数える（ネットワークごとの上限がある種類は bucket ごとにも。bucket が無ければ 'unknown'）。どちらかが上限なら、
 * どちらも数えずに、どの上限かを返す
 */
export function takeRate(store: MirrorStore, kind: RateKind, now: number, bucket?: string): RateResult {
  const iso = new Date(now).toISOString()
  const hour = iso.slice(0, 13)
  const day = iso.slice(0, 10)
  const limits = RATE_LIMITS[kind]
  const key = `rate:${kind}`
  const srcKey = `rate:${kind}:sources`
  let sources: SourceCounters | null = null
  let src: Counter | null = null
  const name = bucket || 'unknown'
  if (limits.source) {
    const saved = store.getMeta<SourceCounters>(srcKey)
    sources = saved && saved.day === day && saved.buckets && typeof saved.buckets === 'object' ? saved : { day, buckets: {} }
    src = fresh(sources.buckets[name], hour, day)
    const hit = over(src, limits.source)
    if (hit) return { ok: false, scope: 'source', window: hit }
  }
  const global = fresh(store.getMeta<Counter>(key), hour, day)
  const hit = over(global, limits.global)
  if (hit) return { ok: false, scope: 'global', window: hit }
  store.transaction(() => {
    store.setMeta(key, bump(global) satisfies Counter)
    if (sources && src) store.setMeta(srcKey, { day, buckets: { ...sources.buckets, [name]: bump(src) } } satisfies SourceCounters)
  })
  return { ok: true }
}

/** 数える単位のネットワーク（IPv4 はそのアドレス、IPv6 は先頭の 48 ビット。IPv4 を埋め込んだ IPv6 は IPv4。読めなければ 'unknown'） */
export function sourceNetwork(ip: string | null | undefined): string {
  const v = (ip ?? '').trim().toLowerCase()
  if (!v) return 'unknown'
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v)
  if (v4) return v4[1]
  if (!/^[0-9a-f:]+$/.test(v) || !v.includes(':')) return 'unknown'
  const parts = v.split('::')
  if (parts.length > 2) return 'unknown'
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const groups = parts.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'unknown'
  return `${groups
    .slice(0, 3)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/48`
}

/** ネットワークを数える時の名前（sha256 の先頭16文字。salt にコネクタの秘密を混ぜ、記録から IP を戻せないように） */
export async function sourceBucket(ip: string | null | undefined, salt = ''): Promise<string> {
  const net = sourceNetwork(ip)
  if (net === 'unknown') return net
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rate|${salt}|${net}`)))
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}
