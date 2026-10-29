// 回数の上限（Vault の SQLite に数える）。OAuth の KV（1日1,000回の書き込み）を、いたずらの接続要求で使い切らないように、
// /authorize の受け付け（beginConsent の前）と、DCR（ENABLE_DCR の時だけ）の登録を数える。
import type { MirrorStore } from './store'

export type RateKind = 'authorize' | 'register'

export const RATE_LIMITS: Record<RateKind, { perHour: number; perDay: number }> = {
  authorize: { perHour: 20, perDay: 60 },
  register: { perHour: 10, perDay: 10 },
}

interface Counter {
  hour: string
  hourCount: number
  day: string
  dayCount: number
}

/** 1回分を数える。上限を超えていれば数えずに false */
export function takeRate(store: MirrorStore, kind: RateKind, now: number): boolean {
  const iso = new Date(now).toISOString()
  const hour = iso.slice(0, 13)
  const day = iso.slice(0, 10)
  const key = `rate:${kind}`
  const cur = store.getMeta<Counter>(key)
  const c: Counter = {
    hour,
    hourCount: cur && cur.hour === hour ? cur.hourCount : 0,
    day,
    dayCount: cur && cur.day === day ? cur.dayCount : 0,
  }
  const limit = RATE_LIMITS[kind]
  if (c.hourCount >= limit.perHour || c.dayCount >= limit.perDay) return false
  store.setMeta(key, { ...c, hourCount: c.hourCount + 1, dayCount: c.dayCount + 1 } satisfies Counter)
  return true
}
