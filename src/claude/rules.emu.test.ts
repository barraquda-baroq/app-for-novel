// 本番のアクセスルール（firestore.rules）の、Claude 用のコネクタ（匿名のアカウント）についての決まりを確かめる。
// 実行: npm run test:sync（Firebase エミュレーターの Auth・Firestore）。コネクタは Firestore の REST API を使うので、ここでも REST で書く。
// 持ち主は今までどおり Firebase の SDK（Google のアカウント）。
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential } from 'firebase/auth'
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  initializeFirestore,
  memoryLocalCache,
  serverTimestamp,
  setDoc,
  terminate,
  updateDoc,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeRecord, encodeRecord, type RecordDoc } from '../sync/codec'
import type { Rec } from '../sync/merge'
import { appModelRef } from '../sync/appModel'
import type { TableName } from '../domain/types'

const PROJECT = 'demo-novel-studio'
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`
let seq = 0

async function emulatorRequest(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:8080${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
}

/** エミュレーターの管理者として1つの文書を消す（無くてもよい） */
async function adminDelete(path: string): Promise<void> {
  const res = await fetch(`${FS}/${path}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status} ${await res.text()}`)
}

// ---------- 持ち主（SDK・Google のアカウント） ----------

interface Owner {
  uid: string
  fs: Firestore
  app: FirebaseApp
}

const apps: { app: FirebaseApp; fs: Firestore }[] = []

async function googleUser(account: string): Promise<Owner> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' }, `rules-${account}-${++seq}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(
    JSON.stringify({ sub: account, email: `${account}@example.com`, email_verified: true }),
  )
  const { user } = await signInWithCredential(auth, cred)
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  apps.push({ app, fs })
  return { uid: user.uid, fs, app }
}

const account = (name: string) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function recordDoc(table: TableName, id: string, rec: Record<string, unknown>, device = 'owner-device') {
  const enc = encodeRecord({ id, ...rec } as Rec)
  return { table, id, json: enc.json, chunks: 0, deleted: false, hash: enc.hash, updated: serverTimestamp(), device }
}

// ---------- コネクタ（REST・匿名のアカウント） ----------

interface Anon {
  uid: string
  token: string
}

/** Auth エミュレーターの REST API で匿名のアカウントを作る（コネクタと同じ accounts:signUp） */
async function anonymousUser(): Promise<Anon> {
  const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  })
  const j = (await res.json()) as { idToken: string; localId: string }
  if (!res.ok || !j.idToken) throw new Error(`匿名のアカウントを作れません: ${res.status}`)
  return { uid: j.localId, token: j.idToken }
}

type Value = { stringValue: string } | { integerValue: string } | { booleanValue: boolean } | { nullValue: null }

const v = (x: string | number | boolean | null): Value =>
  x === null
    ? { nullValue: null }
    : typeof x === 'string'
      ? { stringValue: x }
      : typeof x === 'number'
        ? { integerValue: String(x) }
        : { booleanValue: x }

async function rest(token: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${FS}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const docName = (uid: string, docId: string) => `projects/${PROJECT}/databases/(default)/documents/users/${uid}/records/${docId}`

interface ConnectorWrite {
  table: string
  id: string
  json: string
  hash: string
  /** ルールの確かめのために項目を変える */
  extra?: Record<string, string | number | boolean | null>
  omit?: string[]
  docId?: string
  /** exists:false を付けない（更新として送る） */
  noPrecondition?: boolean
}

function connectorRecord(table: string, id: string, rec: Record<string, unknown> = {}): ConnectorWrite {
  const enc = encodeRecord({ id, v: 1, source: 'claude', titleId: 't1', createdAt: 1, updatedAt: 1, ...rec } as Rec)
  return { table, id, json: enc.json!, hash: enc.hash }
}

/** コネクタと同じ形の作成（exists:false・updated はサーバー時刻）。commit の結果の HTTP の状態を返す */
async function connectorCommit(anon: Anon, ownerUid: string, writes: ConnectorWrite[]): Promise<number> {
  const body = {
    writes: writes.map((w) => {
      const fields: Record<string, Value> = {
        table: v(w.table),
        id: v(w.id),
        json: v(w.json),
        chunks: v(0),
        deleted: v(false),
        hash: v(w.hash),
        device: v('claude-connector'),
      }
      for (const [k, x] of Object.entries(w.extra ?? {})) fields[k] = v(x)
      for (const k of w.omit ?? []) delete fields[k]
      return {
        update: { name: docName(ownerUid, w.docId ?? `${w.table}:${w.id}`), fields },
        updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }],
        ...(w.noPrecondition ? {} : { currentDocument: { exists: false } }),
      }
    }),
  }
  return (await rest(anon.token, ':commit', body)).status
}

async function connectorDelete(anon: Anon, ownerUid: string, docId: string): Promise<number> {
  return (await rest(anon.token, ':commit', { writes: [{ delete: docName(ownerUid, docId) }] })).status
}

/** コネクタと同じ差分の読み取り（updated の順）。読めた文書の数か、拒まれたら HTTP の状態（負の数） */
async function connectorQuery(anon: Anon, ownerUid: string): Promise<number> {
  const r = await rest(anon.token, `/users/${ownerUid}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: 'records' }],
      orderBy: [{ field: { fieldPath: 'updated' }, direction: 'ASCENDING' }],
      limit: 500,
    },
  })
  if (r.status !== 200) return -r.status
  return (r.json as { document?: unknown }[]).filter((x) => x.document).length
}

/** 名前を指定して読む（batchGet）。読めたら true */
async function connectorGet(anon: Anon, path: string): Promise<boolean> {
  const r = await rest(anon.token, ':batchGet', { documents: [`projects/${PROJECT}/databases/(default)/documents/${path}`] })
  return r.status === 200
}

// ---------- 用意 ----------

let owner: Owner
let anon: Anon

beforeAll(async () => {
  await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
    rules: { files: [{ name: 'firestore.rules', content: prodRules }] },
  })
  // 全件を消す口（DELETE …/documents）は、ほかのテストファイル（sync.emu.test.ts）が最後に通信を切った後だと 500 になるので、
  // このテストが前提にする文書（持ち主・連携の記録）だけを管理者として消す（ほかのテストの文書は uid が違うので残っても構わない）
  for (const path of ['config/owner', 'config/connector']) await adminDelete(path)
  anon = await anonymousUser()
  // 持ち主がまだいない時に、匿名のアカウントは持ち主になれない
  const asOwner = await fetch(`${FS}/config?documentId=owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon.token}` },
    body: JSON.stringify({ fields: { uid: v(anon.uid) } }),
  })
  expect(asOwner.status).toBe(403)
  owner = await googleUser(account('owner'))
  await setDoc(doc(owner.fs, 'config', 'owner'), { uid: owner.uid, createdAt: serverTimestamp() })
  await setDoc(doc(owner.fs, 'users', owner.uid, 'records', 'titles:t1'), recordDoc('titles', 't1', { name: '星の庭' }))
  await setDoc(doc(owner.fs, 'users', owner.uid, 'records', 'versions:v1'), recordDoc('versions', 'v1', { body: '本文' }))
  await setDoc(appModelRef(owner.fs, owner.uid), { model: 3, appVersion: '2.3', updatedAt: serverTimestamp() })
}, 60_000)

afterAll(async () => {
  for (const { app, fs } of apps.splice(0)) {
    await terminate(fs)
    await deleteApp(app)
  }
  await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
    rules: { files: [{ name: 'firestore.rules', content: emuRules }] },
  })
})

const connectorRef = () => doc(owner.fs, 'config', 'connector')
const pairing = (writes = true, uid = anon.uid) => ({
  uid,
  pairing: 'a'.repeat(64),
  pairedAt: serverTimestamp(),
  approvedOn: 'テストの Mac',
  writes,
  v: 1,
})

// テストは順に進む（連携する前 → 連携 → 書き込みの停止 → 連携の解除）
describe('本番のアクセスルール: Claude 用のコネクタ（エミュレーター）', () => {
  it('連携する前は、匿名のアカウントは読むことも作ることもできない', async () => {
    expect(await connectorQuery(anon, owner.uid)).toBeLessThan(0)
    expect(await connectorGet(anon, `users/${owner.uid}/records/titles:t1`)).toBe(false)
    expect(await connectorGet(anon, 'config/connector')).toBe(false)
    expect(await connectorCommit(anon, owner.uid, [connectorRecord('proofSuggestions', 'cs-before')])).toBe(403)
    // 持ち主の記録は読める（コネクタが持ち主を確かめるため）
    expect(await connectorGet(anon, 'config/owner')).toBe(true)
  })

  it('連携の記録は持ち主だけが、決まった形で書ける', async () => {
    // 持ち主自身・時刻がサーバー時刻でない・知らない項目は拒む
    await expect(setDoc(connectorRef(), pairing(true, owner.uid))).rejects.toThrow()
    await expect(setDoc(connectorRef(), { ...pairing(), pairedAt: 12345 })).rejects.toThrow()
    await expect(setDoc(connectorRef(), { ...pairing(), extra: 1 })).rejects.toThrow()
    await expect(setDoc(connectorRef(), { ...pairing(), writes: 'yes' })).rejects.toThrow()
    // 持ち主でない Google のアカウント・匿名のアカウントは書けない
    const stranger = await googleUser(account('stranger'))
    await expect(setDoc(doc(stranger.fs, 'config', 'connector'), pairing(true, stranger.uid + 'x'))).rejects.toThrow()
    const self = await fetch(`${FS}/config?documentId=connector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon.token}` },
      body: JSON.stringify({ fields: { uid: v(anon.uid), writes: v(true) } }),
    })
    expect(self.status).toBe(403)
    await setDoc(connectorRef(), pairing())
    expect((await getDoc(connectorRef())).data()?.uid).toBe(anon.uid)
  })

  it('連携した後: 読める・Claude の表に決まった形で作れる', async () => {
    expect(await connectorQuery(anon, owner.uid)).toBe(2)
    expect(await connectorGet(anon, `users/${owner.uid}/records/titles:t1`)).toBe(true)
    expect(await connectorGet(anon, `users/${owner.uid}/meta/app`)).toBe(true)
    expect(await connectorGet(anon, 'config/connector')).toBe(true)
    const rec = connectorRecord('proofSuggestions', 'cs-1', { excerpt: '見れる' })
    expect(await connectorCommit(anon, owner.uid, [rec])).toBe(200)
    // 持ち主の端末では、ほかの端末の記録と同じように読める
    const snap = await getDoc(doc(owner.fs, 'users', owner.uid, 'records', 'proofSuggestions:cs-1'))
    const d = snap.data() as RecordDoc
    expect(d.device).toBe('claude-connector')
    expect(decodeRecord(d, () => undefined)).toMatchObject({ id: 'cs-1', excerpt: '見れる', source: 'claude' })
    // もうあれば作れない（exists:false）。書き換え・削除はできない
    expect(await connectorCommit(anon, owner.uid, [rec])).not.toBe(200)
    expect(await connectorCommit(anon, owner.uid, [{ ...rec, noPrecondition: true }])).toBe(403)
    expect(await connectorDelete(anon, owner.uid, 'proofSuggestions:cs-1')).toBe(403)
    // 持ち主は今までどおり書き換え・削除できる
    await updateDoc(doc(owner.fs, 'users', owner.uid, 'records', 'proofSuggestions:cs-1'), {
      ...recordDoc('proofSuggestions', 'cs-1', { excerpt: '見れる', done: true }),
    })
    await deleteDoc(doc(owner.fs, 'users', owner.uid, 'records', 'proofSuggestions:cs-1'))
  })

  it('決まった形でない作成は拒む', async () => {
    const ok = (id: string) => connectorRecord('revisionIdeas', id)
    const denied: [string, ConnectorWrite][] = [
      ['原稿の表（versions）', connectorRecord('versions', 'cv-x')],
      ['タイトル', connectorRecord('titles', 'ct-x')],
      ['ゴミ箱', connectorRecord('trashEntries', 'ce-x')],
      ['復元の印（reset）', { ...ok('ci-reset'), extra: { reset: true } }],
      ['分割（chunks）', { ...ok('ci-chunks'), extra: { chunks: 1 } }],
      ['分割文書の項目（parent）', { ...ok('ci-parent'), extra: { parent: 'x' } }],
      ['削除の印', { ...ok('ci-del'), extra: { deleted: true } }],
      ['端末の名前が違う', { ...ok('ci-dev'), extra: { device: 'owner-device' } }],
      ['文書の名前が id と違う', { ...ok('ci-name'), docId: 'revisionIdeas:other' }],
      ['表の名前が違う', { ...ok('ci-table'), docId: 'proofSuggestions:ci-table' }],
      ['指紋が無い', { ...ok('ci-hash'), omit: ['hash'] }],
      ['json が無い', { ...ok('ci-json'), omit: ['json'] }],
      ['json が長すぎる', { ...ok('ci-long'), json: 'x'.repeat(200_001) }],
      ['id が長すぎる', { ...connectorRecord('revisionIdeas', `ci-${'x'.repeat(64)}`) }],
      ['知らない項目', { ...ok('ci-extra'), extra: { note: 'x' } }],
    ]
    for (const [what, w] of denied) expect([what, await connectorCommit(anon, owner.uid, [w])]).toEqual([what, 403])
    // 6つの表はどれも作れる
    for (const table of [
      'proofSuggestions',
      'proofBatches',
      'revisionIdeas',
      'strategyNotes',
      'critiquePrompts',
      'critiqueResults',
    ])
      expect([table, await connectorCommit(anon, owner.uid, [connectorRecord(table, `c-${table}`)])]).toEqual([table, 200])
  })

  it('100件を1回の書き込みで作れる（ルールの読み取りは同じ文書なので数が増えない）', async () => {
    const writes = Array.from({ length: 100 }, (_, i) => connectorRecord('proofSuggestions', `cs-batch-${i}`))
    expect(await connectorCommit(anon, owner.uid, writes)).toBe(200)
    // 1件でも形が違えば、まとめて拒む
    const mixed = [connectorRecord('proofSuggestions', 'cs-mixed-ok'), connectorRecord('versions', 'cv-mixed')]
    expect(await connectorCommit(anon, owner.uid, mixed)).toBe(403)
    expect(await connectorGet(anon, `users/${owner.uid}/records/proofSuggestions:cs-mixed-ok`)).toBe(true)
    const got = await rest(anon.token, ':batchGet', { documents: [docName(owner.uid, 'proofSuggestions:cs-mixed-ok')] })
    expect((got.json as { missing?: string }[])[0].missing).toBeTruthy()
  })

  it('ほかの匿名のアカウント・連携に記録された Google のアカウントは、コネクタとして扱わない', async () => {
    const other = await anonymousUser()
    expect(await connectorQuery(other, owner.uid)).toBeLessThan(0)
    expect(await connectorGet(other, 'config/connector')).toBe(false)
    expect(await connectorCommit(other, owner.uid, [connectorRecord('proofSuggestions', 'cs-other')])).toBe(403)
    // コネクタは形の版・連携の記録を書き換えられない
    const model = await fetch(`${FS}/users/${owner.uid}/meta/app`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon.token}` },
      body: JSON.stringify({
        fields: { model: v(9), appVersion: v('9'), updatedAt: { timestampValue: new Date().toISOString() } },
      }),
    })
    expect(model.status).toBe(403)
    // 連携の uid に Google のアカウントを書いても、そのアカウントはコネクタにならない
    const google = await googleUser(account('google-connector'))
    await setDoc(connectorRef(), pairing(true, google.uid))
    await expect(getDoc(doc(google.fs, 'users', owner.uid, 'records', 'titles:t1'))).rejects.toThrow()
    await expect(
      setDoc(
        doc(google.fs, 'users', owner.uid, 'records', 'revisionIdeas:cg-1'),
        recordDoc('revisionIdeas', 'cg-1', {}, 'claude-connector'),
      ),
    ).rejects.toThrow()
    // 元に戻す
    await setDoc(connectorRef(), pairing())
    expect(await connectorQuery(anon, owner.uid)).toBeGreaterThan(0)
  })

  it('「書き込みを許可」を外すと作れない（読むのは続く）。連携の確かめの指紋・時刻は変えられない', async () => {
    await updateDoc(connectorRef(), { writes: false })
    expect(await connectorCommit(anon, owner.uid, [connectorRecord('proofSuggestions', 'cs-off')])).toBe(403)
    expect(await connectorQuery(anon, owner.uid)).toBeGreaterThan(0)
    await expect(updateDoc(connectorRef(), { pairing: 'b'.repeat(64) })).rejects.toThrow()
    await expect(updateDoc(connectorRef(), { pairedAt: 12345 })).rejects.toThrow()
    // 連携し直す（指紋と時刻を新しくする）のはよい
    await updateDoc(connectorRef(), { pairing: 'c'.repeat(64), pairedAt: serverTimestamp(), writes: true })
    expect(await connectorCommit(anon, owner.uid, [connectorRecord('proofSuggestions', 'cs-on')])).toBe(200)
  })

  it('連携を解除する（記録を消す）と、その場で読めなくなる', async () => {
    const stranger = await googleUser(account('stranger2'))
    await expect(deleteDoc(doc(stranger.fs, 'config', 'connector'))).rejects.toThrow()
    await deleteDoc(connectorRef())
    expect(await connectorQuery(anon, owner.uid)).toBeLessThan(0)
    expect(await connectorGet(anon, `users/${owner.uid}/meta/app`)).toBe(false)
    expect(await connectorGet(anon, 'config/connector')).toBe(false)
    expect(await connectorCommit(anon, owner.uid, [connectorRecord('proofSuggestions', 'cs-after')])).toBe(403)
    // 持ち主は今までどおり
    expect((await getDoc(doc(owner.fs, 'users', owner.uid, 'records', 'titles:t1'))).exists()).toBe(true)
  })
})
