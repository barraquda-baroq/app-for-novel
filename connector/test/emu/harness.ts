// エミュレーターの結合テストの用意: アプリの端末（src/db/persistence・src/sync/engine。持ち主の Google のアカウント）と、
// コネクタの Vault の中身（node:sqlite・本物の fetch で Auth・Firestore のエミュレーターにつなぐ）。
// アクセスルールは本番の firestore.rules を読み込む（src/claude/rules.emu.test.ts と同じやり方）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, terminate, type Firestore } from 'firebase/firestore'
import { createPersistence, type ConflictNote, type Persistence } from '../../../src/db/persistence'
import { repairData } from '../../../src/domain/repair'
import type { AppData } from '../../../src/domain/types'
import { newId } from '../../../src/domain/util'
import { APP_VERSION, DATA_MODEL } from '../../../src/sync/appModel'
import { createConflictHooks } from '../../../src/sync/conflicts'
import { createSyncEngine, type SyncEngine, type SyncTarget } from '../../../src/sync/engine'
import { stableStringify } from '../../../src/sync/merge'
import type { VaultConfig } from '../../src/config'
import { VaultCore, type GrantProps } from '../../src/vault/core'
import { defaultConnectionName, newConnectionId, pairingHash, randomPairingKey } from '../../../src/claude/pairing'
import { approvePairing, prepareConnect } from '../../../src/features/claude/connectLogic'
import { addConnection, deleteConnector, readConnectorDoc, readOwnerUid } from '../../../src/features/claude/connectorDoc'
import { nodeSql } from '../support/nodeSql'

export const PROJECT = 'demo-novel-studio'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
export const prodRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8')
export const emuRules = fs.readFileSync(path.join(root, 'firestore.emu.rules'), 'utf8')

export async function emulatorRequest(method: string, p: string, body?: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:8080${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`)
}

export async function useRules(content: string): Promise<void> {
  await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
    rules: { files: [{ name: 'firestore.rules', content }] },
  })
}

export async function clearFirestore(): Promise<void> {
  await emulatorRequest('DELETE', `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`)
}

// ---------- 端末 ----------

export interface Device {
  name: string
  uid: string
  p: Persistence
  fs: Firestore
  engine: SyncEngine | null
  notes: ConflictNote[]
  warnings: string[]
  load(): Promise<AppData>
  edit(fn: (d: AppData) => AppData): Promise<void>
  restore(data: AppData): Promise<void>
  online(): Promise<void>
  offline(): void
}

const apps: { app: FirebaseApp; fs: Firestore }[] = []
const devices: Device[] = []
let seq = 0

export const account = () => `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 端末のコンソールの警告（「クラウドのレコードを読み取れませんでした」など）を集める */
const warnings: string[] = []
const origWarn = console.warn
console.warn = (...a: unknown[]) => {
  warnings.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '))
  origWarn(...a)
}

export async function makeDevice(name: string, who: string): Promise<Device> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' }, `${name}-${++seq}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub: who, email: `${who}@example.com`, email_verified: true }))
  const { user } = await signInWithCredential(auth, cred)
  const firestore = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080)
  apps.push({ app, fs: firestore })
  const p = createPersistence(`conn-emu-${name}-${seq}-${Math.random().toString(36).slice(2)}`)
  const notes: ConflictNote[] = []
  const target: SyncTarget = {
    readOutbox: (n) => p.readOutbox(n),
    completeUpload: (s) => p.completeUpload(s),
    markUnconfirmed: (keys) => p.markUnconfirmed(keys),
    applyRemote: async (changes, cursor, opts) => {
      const before = repairData(await p.load()).data
      const hooks = createConflictHooks({ device: name, data: () => before, newId, report: (n) => notes.push(n) })
      return p.applyRemote(changes, { cursor, ...hooks, ...opts })
    },
    outboxCount: () => p.outboxCount(),
    markAllDirty: () => p.markAllDirty(),
    localKeys: () => p.localKeys(),
    getMeta: (k) => p.getMeta(k),
    setMeta: (k, v) => p.setMeta(k, v),
  }
  const device: Device = {
    name,
    uid: user.uid,
    p,
    fs: firestore,
    engine: null,
    notes,
    warnings,
    load: () => p.load(),
    async edit(fn) {
      const prev = await device.load()
      await p.save(prev, fn(prev))
      device.engine?.requestUpload(true)
    },
    async restore(data) {
      await p.replaceAll(data)
      device.engine?.requestUpload(true)
    },
    async online() {
      if (device.engine) return
      device.engine = createSyncEngine({
        firestore,
        uid: user.uid,
        deviceId: name,
        target,
        uploadDelay: 10,
        uploadMaxWait: 50,
        ownerLock: true,
        appModel: { model: DATA_MODEL, appVersion: APP_VERSION },
      })
      await device.engine.start()
    },
    offline() {
      device.engine?.stop()
      device.engine = null
    },
  }
  devices.push(device)
  return device
}

export async function cleanup(): Promise<void> {
  for (const d of devices.splice(0)) {
    d.offline()
    d.p.close()
  }
  for (const { app, fs: f } of apps.splice(0)) {
    await terminate(f)
    await deleteApp(app)
  }
  warnings.length = 0
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, label: string, timeout = 20_000): Promise<T> {
  const until = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}${last ? ` (${String(last)})` : ''}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 端末の送信待ちが空になり、内容が揃うまで待つ */
export async function settle(...ds: Device[]): Promise<void> {
  await waitFor(async () => {
    for (const d of ds) {
      await d.engine?.idle()
      if ((await d.p.outboxCount()) > 0) return false
    }
    const [first, ...rest] = await Promise.all(ds.map((d) => d.load()))
    return rest.every((r) => stableStringify(r) === stableStringify(first))
  }, '端末の内容が揃う')
}

// ---------- コネクタ ----------

export function emuConfig(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    projectId: PROJECT,
    apiKey: 'fake-api-key',
    identityUrl: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1',
    tokenUrl: 'http://127.0.0.1:9099/securetoken.googleapis.com/v1',
    firestoreUrl: 'http://127.0.0.1:8080/v1',
    workBudgetChars: 300_000,
    dailyReadBudget: 1_000_000,
    dailyWriteBudget: 100_000,
    ...over,
  }
}

export const SECRET = 'emulator-test-secret-0123456789abcdef'

export function makeConnector(opts: { sql?: ReturnType<typeof nodeSql>; config?: Partial<VaultConfig> } = {}) {
  const sql = opts.sql ?? nodeSql()
  const core = new VaultCore({
    sql,
    fetch: (input, init) => fetch(input, init),
    config: emuConfig(opts.config),
    secret: SECRET,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    freshMs: 0,
  })
  return { core, sql }
}

/**
 * アプリの連携の画面と同じ手順で連携する（src/features/claude/connectLogic.ts の prepareConnect・approvePairing と、
 * connectorDoc.ts の readOwnerUid・readConnectorDoc・addConnection・deleteConnector をそのまま使う。Firestore は持ち主の端末のもの）:
 * 持ち主か確かめ、コネクタの身元といまの接続の一覧を受け取り、config/connector の一覧に接続（指紋）を足して、アプリが移る
 * /pair/callback の URL の state と k で、コネクタの /pair/callback と同じ確かめをする（state は claude.ai から、k はアプリの中だけ）。
 * 2.9: 呼ぶたびに新しい接続（名前は既定の「接続n」。replaceCid で入れ替え）。返す grant は、その接続の OAuth の許可の props と同じ
 */
export async function pair(
  core: VaultCore,
  owner: Device,
  opts: { writes?: boolean; name?: string; replaceCid?: string } = {},
): Promise<{ uid: string; cid: string; grant: GrantProps }> {
  const origin = 'https://connector.emu.test'
  const state = `state-${Math.random().toString(36).slice(2)}`
  const prep = await prepareConnect(
    {
      origin,
      readOwnerUid: () => readOwnerUid(owner.fs),
      waitSynced: async () => true,
      fetchIdentity: async () => {
        const id = await core.connectIdentity()
        return { ok: true, identity: { uid: id.uid, version: id.version, model: id.model } }
      },
      readConnector: () => readConnectorDoc(owner.fs),
      dataModel: DATA_MODEL,
      cancelled: () => false,
    },
    owner.uid,
  )
  if (prep.step !== 'ready') throw new Error(`連携の画面が先へ進みません: ${prep.step}`)
  // 連携の画面と同じ既定（コネクタが用意し直された時は、前の接続は数えない）
  const current = prep.existing && prep.existing.uid === prep.identity.uid ? prep.existing : null
  const cid = newConnectionId()
  let url = ''
  const approved = await approvePairing(
    {
      origin,
      addConnection: (a) => addConnection(a, owner.fs),
      deleteConnector: () => deleteConnector(owner.fs),
      setAccess: () => undefined,
      flush: async () => true,
      navigate: (u) => (url = u),
      randomKey: () => randomPairingKey(),
      deviceLabel: () => 'テストの Mac',
    },
    {
      state,
      identity: prep.identity,
      ownerUid: prep.ownerUid,
      writes: opts.writes ?? current?.writes ?? true,
      access: [],
      cid,
      name: opts.name ?? defaultConnectionName((current?.connections ?? []).map((c) => c.name)),
      replaceCid: opts.replaceCid ?? null,
    },
  )
  if (!approved.ok) throw new Error(`連携を記録できません: ${approved.error}`)
  const back = new URL(url)
  const r = await core.verifyPairing(await pairingHash(back.searchParams.get('state') ?? '', back.searchParams.get('k') ?? ''))
  if (!r.ok) throw new Error(`連携できません: ${r.reason} ${r.message}`)
  if (r.cid !== cid) throw new Error(`許可した接続が違います: ${r.cid} ${cid}`)
  // 初回の取り込み（alarm と同じ）
  for (let i = 0; i < 500; i++) if ((await core.alarm()) === null) break
  return { uid: prep.identity.uid, cid, grant: { ownerUid: r.ownerUid, gen: r.gen, cid } }
}

/**
 * ツールを呼ぶ（freshMs: 0 なので、毎回クラウドの変更を読み直す）。grant を渡すと /mcp と同じく、その許可（接続）で呼ぶ
 */
export async function tool(core: VaultCore, name: string, args: Record<string, unknown> = {}, grant?: GrantProps) {
  return core.callTool(name, args, grant ? { grant } : {})
}

/** エミュレーターの管理者として config/connector を読む（作られた時刻 = コネクタの連携の代。無ければ null） */
export async function adminConnectorDoc(): Promise<{ createTime: string; fields: Record<string, unknown> } | null> {
  const res = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/config/connector`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET config/connector: ${res.status} ${await res.text()}`)
  const j = (await res.json()) as { createTime: string; fields: Record<string, unknown> }
  return { createTime: j.createTime, fields: j.fields }
}

/** 2.8 のアプリが書いた形（v1）の連携の記録を、エミュレーターの管理者として置く（2.9 のアクセスルールでは作れない） */
export async function adminPutConnectorV1(uid: string, hash: string, writes = true): Promise<void> {
  const res = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/config/connector`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        uid: { stringValue: uid },
        pairing: { stringValue: hash },
        pairedAt: { timestampValue: new Date().toISOString() },
        approvedOn: { stringValue: '2.8 の Mac' },
        writes: { booleanValue: writes },
        v: { integerValue: '1' },
      },
    }),
  })
  if (!res.ok) throw new Error(`PATCH config/connector: ${res.status} ${await res.text()}`)
}
