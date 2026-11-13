// テスト用: 小さな Firebase（fakeFirebase.ts）につないだ Vault の中身と、持ち主のデータの用意。
import type { AppData, TableName } from '../../../src/domain/types'
import type { Rec } from '../../../src/sync/merge'
import type { VaultConfig } from '../../src/config'
import { CONNECTOR_MODEL } from '../../src/version'
import { VaultCore, type GrantProps } from '../../src/vault/core'
import { pairingHash } from '../../src/vault/crypto'
import { FakeFirebase } from './fakeFirebase'
import { nodeSql } from './nodeSql'

export const OWNER = 'owner-uid-1'
export const SECRET = 'test-secret-0123456789abcdef0123456789'

export function config(fake: FakeFirebase, over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    projectId: fake.project,
    apiKey: 'test-api-key',
    identityUrl: fake.identityUrl,
    tokenUrl: fake.tokenUrl,
    firestoreUrl: fake.firestoreUrl,
    workBudgetChars: 300_000,
    dailyReadBudget: 15_000,
    dailyWriteBudget: 5_000,
    ...over,
  }
}

export interface Clock {
  now: number
}

export function makeCore(
  fake: FakeFirebase,
  opts: {
    clock?: Clock
    config?: Partial<VaultConfig>
    secret?: string
    sql?: ReturnType<typeof nodeSql>
    /** fake.fetch の代わり（答えを遅らせるテスト用） */
    fetch?: typeof fetch
  } = {},
) {
  const clock = opts.clock ?? { now: Date.UTC(2026, 9, 29, 3, 0, 0) }
  const sql = opts.sql ?? nodeSql()
  const scheduled: (number | null)[] = []
  const core = new VaultCore({
    sql,
    fetch: opts.fetch ?? (fake.fetch as typeof fetch),
    config: config(fake, opts.config),
    secret: opts.secret ?? SECRET,
    now: () => clock.now,
    sleep: async () => undefined,
    schedule: (at) => scheduled.push(at),
  })
  return { core, sql, clock, scheduled }
}

/** 持ち主のデータを、端末が書いたのと同じ形でクラウドに置く（表ごとに1回の書き込み） */
export function seed(fake: FakeFirebase, data: AppData, owner = OWNER): void {
  for (const table of Object.keys(data) as TableName[]) {
    const rows = Object.values(data[table] as Record<string, Rec>)
    for (let i = 0; i < rows.length; i += 40)
      fake.putMany(
        owner,
        rows.slice(i, i + 40).map((rec) => ({ table, rec })),
      )
  }
}

/**
 * 連携した Vault（取り込みも済ませる）。cid を渡すと 2.9 のアプリの許可（接続の一覧の形 v2。名前は name・既定は「接続1」）、
 * 渡さなければ 2.8 までの記録（v1。接続は c0）。grant はその許可の props
 */
export async function pairedCore(
  fake: FakeFirebase,
  data: AppData | null,
  opts: Parameters<typeof makeCore>[1] & {
    writes?: boolean
    model?: number | null
    warm?: boolean
    cid?: string
    name?: string
  } = {},
) {
  const made = makeCore(fake, opts)
  const { uid } = await made.core.connectIdentity()
  fake.setOwner(OWNER)
  if (opts.model !== null) fake.setAppModel(OWNER, opts.model ?? CONNECTOR_MODEL)
  if (data) seed(fake, data)
  const hash = await pairingHash('state-1', 'k'.repeat(43))
  if (opts.cid)
    fake.addConnection({
      uid,
      cid: opts.cid,
      name: opts.name ?? '接続1',
      pairing: hash,
      writes: opts.writes ?? true,
      pairedAt: made.clock.now,
    })
  else fake.setConnector({ uid, pairing: hash, writes: opts.writes ?? true, pairedAt: made.clock.now })
  const r = await made.core.verifyPairing(hash)
  if (!r.ok) throw new Error(`連携できません: ${r.reason}`)
  if (opts.warm !== false) {
    for (let i = 0; i < 200; i++) {
      const next = await made.core.alarm()
      if (next === null) break
    }
  }
  const grant: GrantProps = { ownerUid: r.ownerUid, gen: r.gen, ...(opts.cid ? { cid: r.cid } : {}) }
  return { ...made, uid, grant }
}

/**
 * アプリでもう1つ接続を許可して（addConnection と同じ）、コネクタで確かめる（/pair/callback と同じ）。その許可の props を返す
 */
export async function addConnection(
  fake: FakeFirebase,
  core: VaultCore,
  uid: string,
  c: { cid: string; name?: string; pairedAt: number; replaceCid?: string; state?: string },
): Promise<GrantProps> {
  const hash = await pairingHash(c.state ?? `state-${c.cid}`, 'k'.repeat(43))
  fake.addConnection({ uid, cid: c.cid, name: c.name ?? c.cid, pairing: hash, pairedAt: c.pairedAt, replaceCid: c.replaceCid })
  const r = await core.verifyPairing(hash)
  if (!r.ok) throw new Error(`連携できません: ${r.reason}`)
  return { ownerUid: r.ownerUid, gen: r.gen, cid: r.cid }
}

/** ツールを呼んでテキストを返す（失敗なら例外） */
export async function call(core: VaultCore, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await core.callTool(name, args)
  if (r.isError) throw new Error(`${name}: ${r.text}`)
  return r.text
}
