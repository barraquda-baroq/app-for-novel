// Vault の Durable Object（SQLite）。中身は core.ts の VaultCore。Worker からは RPC で呼ぶ。
// 持ち主ごとに1つ（idFromName('owner')、locationHint 'apac'）。
import { DurableObject } from 'cloudflare:workers'
import { vaultConfig, type Env } from '../env'
import { logError } from '../log'
import { VaultCore, type CallOptions, type HealthState, type PairingCheck } from './core'
import { ConnectorError, MESSAGES } from './errors'
import type { RateKind } from './ratelimit'
import type { SqlRunner, SqlValue } from './store'
import type { ToolResult } from './tools/common'

function doSql(storage: DurableObjectStorage): SqlRunner {
  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(sql, ...params).toArray() as T[]
    },
    run(sql: string, ...params: SqlValue[]): void {
      storage.sql.exec(sql, ...params)
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn)
    },
  }
}

export class Vault extends DurableObject<Env> {
  readonly #core: VaultCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#core = new VaultCore({
      sql: doSql(ctx.storage),
      fetch: (input, init) => fetch(input, init),
      config: vaultConfig(env),
      secret: env.TOKEN_ENC_KEY,
      schedule: (at) => {
        if (at === null) void ctx.storage.deleteAlarm()
        else void ctx.storage.setAlarm(at)
      },
    })
  }

  /** RPC では例外を投げず、結果で返す（workerd が「受け取られない例外」として記録しないように） */
  async connectIdentity(): Promise<
    { ok: true; uid: string; version: string; model: number } | { ok: false; code: string; message: string }
  > {
    try {
      return { ok: true, ...(await this.#core.connectIdentity()) }
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false, code: e.code, message: e.message }
      logError('identity_failed', e)
      return { ok: false, code: 'unavailable', message: MESSAGES.unavailable }
    }
  }

  health(): HealthState {
    return this.#core.health()
  }

  verifyPairing(hash: string): Promise<PairingCheck> {
    return this.#core.verifyPairing(hash)
  }

  pairingState(): 'paired' | 'unpaired' {
    return this.#core.pairingState()
  }

  callTool(name: string, args: Record<string, unknown>, opts: CallOptions): Promise<ToolResult> {
    return this.#core.callTool(name, args, opts)
  }

  takeRate(kind: RateKind): boolean {
    return this.#core.takeRate(kind)
  }

  nightly(): Promise<'ok' | 'rescan' | 'skipped'> {
    return this.#core.nightly()
  }

  /** 持ち主の uid（連携を解除した時の OAuth の許可の取り消しに使う） */
  ownerUid(): string | null {
    return this.#core.pairing().ownerUid
  }

  async alarm(): Promise<void> {
    try {
      const next = await this.#core.alarm()
      if (next !== null) await this.ctx.storage.setAlarm(next)
    } catch (e) {
      logError('alarm_failed', e)
    }
  }
}

/** Worker から Vault を呼ぶ（持ち主ごとに1つ） */
export function vault(env: Env): DurableObjectStub<Vault> {
  const ns = env.VAULT as DurableObjectNamespace<Vault>
  return ns.get(ns.idFromName('owner'), { locationHint: 'apac' })
}
