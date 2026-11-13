// テスト用: 小さな Firebase（fakeFirebase.ts）の答えを、送った時に作ってから、届けるのを止めておける fetch。
// Durable Object は Firestore の答えを待つ間にほかの呼び出しも進めるので、遅れて届く答え（送った時の記録を読んだ答え）・
// 答えの来ない要求をまねる。止める要求は、送った順に、決まり（match）に合う次の要求。
import type { FakeFirebase } from './fakeFirebase'

/** 送った要求（Firestore の操作の名前 runQuery・batchGet・commit・runAggregationQuery・token など） */
export interface SentRequest {
  op: string
  url: string
  body: string
}

export interface Hold {
  /** 止めた要求を送った時（答えはもう作ってある） */
  sent: Promise<void>
  /** 答えを届ける（まだ合う要求が来ていなければ、止めるのをやめる） */
  release: () => void
  /** 止めたか */
  readonly matched: boolean
}

interface Rule {
  match: (r: SentRequest) => boolean
  skip: number
  reached: () => void
  gate: Promise<void>
  matched: boolean
  cancelled: boolean
  /** 答えの代わり（送った時に作る） */
  respond?: () => Response
  /** 止めずに答える（respond だけを使う） */
  pass?: boolean
}

/** 差分の読み取りのページ（updated の順の問い合わせ） */
export const syncPage = (r: SentRequest) => r.op === 'runQuery' && r.body.includes('"orderBy"')
export const commit = (r: SentRequest) => r.op === 'commit'
export const tokenRefresh = (r: SentRequest) => r.op === 'token'

export function gatedFetch(fake: FakeFirebase) {
  const rules: Rule[] = []
  const sent: SentRequest[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    const req: SentRequest = { op: path.split(/[:/]/).pop() ?? '', url, body: typeof init?.body === 'string' ? init.body : '' }
    sent.push(req)
    let rule: Rule | undefined
    for (const r of rules) {
      if (r.matched || r.cancelled || !r.match(req)) continue
      if (r.skip > 0) {
        r.skip -= 1
        continue
      }
      rule = r
      break
    }
    // 答えは送った時に作る（止めている間に変わった記録は入らない）
    const res = rule?.respond ? rule.respond() : await fake.fetch(input, init)
    if (rule) {
      rule.matched = true
      rule.reached()
      if (!rule.pass) await rule.gate
    }
    return res
  }) as typeof globalThis.fetch

  /** match に合う要求のうち skip 件を飛ばした次の1件を止める。respond を渡すと、その答えを返す */
  const hold = (match: (r: SentRequest) => boolean, opts: { skip?: number; respond?: () => Response } = {}): Hold => {
    let reached!: () => void
    let open!: () => void
    const rule: Rule = {
      match,
      skip: opts.skip ?? 0,
      reached: () => reached(),
      gate: new Promise<void>((r) => (open = r)),
      matched: false,
      cancelled: false,
      respond: opts.respond,
    }
    const sentP = new Promise<void>((r) => (reached = r))
    rules.push(rule)
    return {
      sent: sentP,
      release: () => {
        if (!rule.matched) rule.cancelled = true
        open()
      },
      get matched() {
        return rule.matched
      },
    }
  }

  /** match に合う要求のうち skip 件を飛ばした次の n 件に、止めずに答え（respond）を返す */
  const failNext = (match: (r: SentRequest) => boolean, n: number, respond: () => Response, opts: { skip?: number } = {}) => {
    for (let i = 0; i < n; i++)
      rules.push({
        match,
        skip: opts.skip ?? 0,
        reached: () => undefined,
        gate: Promise.resolve(),
        matched: false,
        cancelled: false,
        respond,
        pass: true,
      })
  }

  /** 送った要求の数（match に合うもの） */
  const count = (match: (r: SentRequest) => boolean) => sent.filter(match).length

  return { fetch, hold, failNext, count, sent }
}

/** Firestore の失敗の答え */
export function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code: status, status: code, message: 'test' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** ほかの呼び出しを進める（マクロタスクを何回か回す） */
export async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** ms 以内に終わらなければ失敗にする（止まったまま＝待ち合わせで動かなくなった、を見つける） */
export async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} が ${ms}ms で終わりませんでした`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
