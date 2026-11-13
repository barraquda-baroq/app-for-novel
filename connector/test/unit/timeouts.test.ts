// Firebase の待ちに上限（L5-5）: 答えの来ない要求（Firestore・トークンの更新）は、1回ごとの上限（テストでは 100ms）で
// 「つながらない」にし、試し直さない。書き込みの順番（すべての接続で1つ）を持ったまま止まらず、ほかの接続の書き込みが進む。
import { describe, expect, it } from 'vitest'
import type { AppData } from '../../../src/domain/types'
import { novel } from '../../../src/test/claudeFixture'
import { MESSAGES } from '../../src/vault/errors'
import { REQUEST_TIMEOUT_MS, RequestTimeout, withTimeout } from '../../src/vault/timeout'
import { FakeFirebase } from '../support/fakeFirebase'
import { commit, gatedFetch, syncPage, tokenRefresh, within } from '../support/gate'
import { OWNER, addConnection, pairedCore } from '../support/harness'

async function accounts(data: AppData | null) {
  const fake = new FakeFirebase()
  const gate = gatedFetch(fake)
  const made = await pairedCore(fake, data, { cid: 'caaa', fetch: gate.fetch, timeoutMs: 100 })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', pairedAt: made.clock.now })
  return { fake, gate, ...made, a: made.grant, b }
}

const docsOf = (fake: FakeFirebase, table: string) => fake.recordDocs(OWNER).filter((d) => d.name.includes(`/${table}:`))

const benchAdd = (work: string) => ({
  work,
  new_work: { name: work, author: '高橋' },
  items: [{ viewpoint: '文体', body_markdown: `## 文体\n${work}は短い文。`, run_date: '2026-10-30' }],
})

describe('Firebase の待ちに上限（L5-5）', () => {
  it('答えの来ない書き込み（commit）は上限で「つながらない」にし（試し直さない）、書き込みの順番を空ける。ほかの接続の書き込みは進む', async () => {
    const lines = ['窓から海が見れる。']
    const n = novel(lines)
    const { core, fake, gate, a, b } = await accounts(n.data)
    const hang = gate.hold(commit)
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    await hang.sent
    const pB = core.callTool(
      'novel_add_proofreading',
      { title_id: n.titleId, items: [{ piece: '#1', excerpt: '海が見れる', category: 'ra_nuki', suggestion: '海が見られる', reason: 'ら抜き' }] },
      { grant: b },
    )
    const [ra, rb] = await within(Promise.all([pA, pB]), 3_000, '答えの来ない書き込みの後ろの書き込み')
    expect(ra.isError).toBe(true)
    expect(ra.text).toBe(MESSAGES.unavailable)
    expect(rb.text).toContain('推敲案を追加: 追加 1件')
    // 待ち切った commit は試し直していない（A の1回と B の1回）
    expect(gate.count(commit)).toBe(2)
    // 待ち切った書き込みが、実はクラウドに届いていても、もう一度送れば重複になる（同じ id・「無い時だけ作る」）
    const again = await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    expect(again.text).toContain('重複 1件')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(1)
    hang.release()
  })

  it('答えの来ない読み取りは上限で止め、前に取り込んだ内容で答える。答えの来ないトークンの更新も上限で止め、試し直さない', async () => {
    const n = novel(['本文です。'])
    const { core, gate, clock, b } = await accounts(n.data)
    clock.now += 20_000
    const hangQuery = gate.hold(syncPage)
    const r = await within(core.callTool('novel_list_titles', {}, { grant: b }), 3_000, '答えの来ない読み取り')
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('（いまクラウドに接続できないため、前に取り込んだ内容です）')
    expect(r.text).toContain('『星の庭』')
    hangQuery.release()
    // ID トークン（1時間）が切れた後の更新が答えない: 1回目の要求は上限で止め（試し直さない）、次の要求で更新し直す
    clock.now += 2 * 3_600_000
    const tokens = gate.count(tokenRefresh)
    const hangToken = gate.hold(tokenRefresh)
    const r2 = await within(core.callTool('novel_list_titles', {}, { grant: b }), 3_000, '答えの来ないトークンの更新')
    expect(r2.isError).toBeUndefined()
    expect(gate.count(tokenRefresh) - tokens).toBe(2)
    hangToken.release()
  })

  it('Firestore がまったく答えない時も、1回の呼び出しが上限まで待つのは2回まで。ほかの接続の書き込みの後ろで待った書き込みにも答える', async () => {
    const n = novel(['本文。'])
    const { core, gate, clock, a, b } = await accounts(n.data)
    // 連携の記録を読み直す時刻（1分）を過ぎてから、Firestore がまったく答えなくなった
    clock.now += 61_000
    const firestore = (r: { url: string }) => r.url.includes('/v1/projects/')
    const before = gate.count(firestore)
    const hangs = Array.from({ length: 20 }, () => gate.hold(firestore))
    const started = Date.now()
    const [ra, rb] = await within(
      Promise.all([
        core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a }),
        core.callTool('novel_add_bench_analysis', benchAdd('作品B'), { grant: b }),
      ]),
      3_000,
      'Firestore が答えない時の書き込み',
    )
    const elapsed = Date.now() - started
    for (const r of [ra, rb]) {
      expect(r.isError).toBe(true)
      expect(r.text).toBe(MESSAGES.unavailable)
    }
    // A は連携の記録の読み直し（読めなくても続ける）と書き込みの前の読み直しの2回、B も2回（1回目は A と同じ時。2回目は A の書き込みの後）
    expect(gate.count(firestore) - before).toBe(4)
    expect(elapsed).toBeLessThan(1_000)
    for (const h of hangs) h.release()
  })

  it('withTimeout: 上限を過ぎると要求を取り消し（signal）、RequestTimeout で失敗にする。上限の既定は 15 秒', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000)
    let signal: AbortSignal | undefined
    const never = ((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }) as typeof fetch
    await expect(withTimeout(never, 30)('http://x/')).rejects.toBeInstanceOf(RequestTimeout)
    expect(signal?.aborted).toBe(true)
    // 上限より前に答えれば、そのまま
    const quick = (async () => new Response('ok')) as typeof fetch
    expect(await (await withTimeout(quick, 30)('http://x/')).text()).toBe('ok')
    // 上限より前の失敗（つながらない）は、そのままの失敗
    const broken = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    await expect(withTimeout(broken, 30)('http://x/')).rejects.toBeInstanceOf(TypeError)
  })
})
