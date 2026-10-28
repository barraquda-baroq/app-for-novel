// 同期の結合テスト。Firebase エミュレーター（Auth・Firestore）の中で、2台の端末を動かして確かめる。
// 実行: npm run test:sync
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  memoryLocalCache,
  serverTimestamp,
  setDoc,
  terminate,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterEach, describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from '../db/persistence'
import * as E from '../domain/entityOps'
import * as S from '../domain/storyOps'
import { emptyData, type AppData, type Version } from '../domain/types'
import { newId } from '../domain/util'
import { conflictTrash, conflictVersionCopy } from './conflicts'
import { createSyncEngine, type SyncEngine, type SyncTarget } from './engine'
import { stableStringify } from './merge'

const PROJECT = 'demo-novel-studio'
let seq = 0

interface Device {
  name: string
  uid: string
  p: Persistence
  fs: Firestore
  engine: SyncEngine | null
  load(): Promise<AppData>
  edit(fn: (d: AppData) => AppData): Promise<void>
  /** バックアップからの復元・すべて削除 */
  restore(data: AppData): Promise<void>
  online(): Promise<void>
  offline(): void
}

const apps: { app: FirebaseApp; fs: Firestore }[] = []
const devices: Device[] = []

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.offline()
    d.p.close()
  }
  for (const { app, fs } of apps.splice(0)) {
    await terminate(fs)
    await deleteApp(app)
  }
})

async function makeDevice(
  name: string,
  account: string,
  opts: { chunkSize?: number; ownerLock?: boolean } = {},
): Promise<Device> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-api-key', authDomain: 'localhost' }, `${name}-${++seq}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const cred = GoogleAuthProvider.credential(
    JSON.stringify({ sub: account, email: `${account}@example.com`, email_verified: true }),
  )
  const { user } = await signInWithCredential(auth, cred)
  const fs = initializeFirestore(app, { localCache: memoryLocalCache() })
  connectFirestoreEmulator(fs, '127.0.0.1', 8080)
  apps.push({ app, fs })
  const p = createPersistence(`emu-${name}-${seq}-${Math.random().toString(36).slice(2)}`)
  let context: AppData = emptyData()
  const target: SyncTarget = {
    readOutbox: (n) => p.readOutbox(n),
    completeUpload: (s) => p.completeUpload(s),
    applyRemote: (changes, cursor) =>
      p.applyRemote(changes, {
        cursor,
        device: name,
        versionCopy: (mine) => conflictVersionCopy(mine as unknown as Version, name, newId(), Date.now()) as never,
        trashCopy: (table, record) => {
          const r = conflictTrash(context, table as never, record, { now: Date.now(), newId })
          if (!r) return []
          return [
            { table: 'trashEntries', id: r.entry.id, record: r.entry as never },
            ...r.records.map((tr) => ({ table: 'trashRecords' as const, id: tr.id, record: tr as never })),
          ]
        },
      }),
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
    fs,
    engine: null,
    async load() {
      context = await p.load()
      return context
    },
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
        firestore: fs,
        uid: user.uid,
        deviceId: name,
        target,
        uploadDelay: 10,
        uploadMaxWait: 50,
        chunkSize: opts.chunkSize,
        ownerLock: opts.ownerLock ?? false,
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

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, label: string, timeout = 15_000): Promise<T> {
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

/** 両方の端末の送信待ちが空になり、内容が揃うまで待つ */
async function settle(...ds: Device[]): Promise<void> {
  let why = ''
  await waitFor(async () => {
    for (const d of ds) {
      await d.engine?.idle()
      const n = await d.p.outboxCount()
      if (n > 0) {
        why = `${d.name} の送信待ち ${n} 件: ${JSON.stringify(await d.p.readOutbox(3)).slice(0, 600)} / ${JSON.stringify(d.engine?.status)}`
        return false
      }
    }
    const [first, ...rest] = await Promise.all(ds.map((d) => d.load()))
    const ok = rest.every((r) => stableStringify(r) === stableStringify(first))
    if (!ok) why = `内容が違う: ${stableStringify(first).slice(0, 800)} <> ${stableStringify(rest[0]).slice(0, 800)}`
    return ok
  }, '端末の内容が揃う').catch((e) => {
    throw new Error(`${(e as Error).message}\n${why}`)
  })
}

const account = () => `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function withTitle(d: AppData, name: string) {
  const t = E.createTitle(d, name)
  const ep = S.addEpisode(t.data, t.result)
  return { data: ep.data, titleId: t.result, pieceId: ep.result }
}

describe('同期（エミュレーター）', () => {
  it('初めてのログインで、両方の端末の内容がクラウドで1つにまとまる', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    let titleId = ''
    await a.edit((d) => {
      const r = withTitle(d, 'Aの作品')
      titleId = r.titleId
      const vid = r.data.pieces[r.pieceId].versionIds[0]
      return S.updateVersion(r.data, vid, { body: 'Aで書いた本文' })
    })
    await b.edit((d) => E.addIdea(d, null, 'Bのアイデア', '本文').data)
    await a.online()
    await b.online()
    await settle(a, b)
    const db = await b.load()
    expect(db.titles[titleId].name).toBe('Aの作品')
    expect(Object.values(db.versions).map((v) => v.body)).toContain('Aで書いた本文')
    expect(Object.values(db.ideas).map((i) => i.heading)).toContain('Bのアイデア')
  })

  it('編集がもう一方の端末にリアルタイムで届く（削除も）', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    let memoId = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      const m = E.addMemo(t.data, t.result, 'メモ')
      memoId = m.result
      return m.data
    })
    await waitFor(async () => (await b.load()).memos[memoId], 'メモが届く')
    await b.edit((d) => E.updateMemo(d, memoId, { body: 'Bで追記' }))
    await waitFor(async () => (await a.load()).memos[memoId]?.body === 'Bで追記', '追記が届く')
    await a.edit((d) => {
      const { [memoId]: _gone, ...memos } = d.memos
      void _gone
      return { ...d, memos }
    })
    await waitFor(async () => !(await b.load()).memos[memoId], '削除が届く')
    await settle(a, b)
  })

  it('オフラインの間に別々の項目を変えたら、両方の変更が残る', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let titleId = ''
    await a.edit((d) => {
      const r = E.createTitle(d, '元の名前')
      titleId = r.result
      return r.data
    })
    await b.online()
    await settle(a, b)
    b.offline()
    await a.edit((d) => E.updateTitle(d, titleId, { name: 'Aで変えた名前' }))
    await settle(a)
    await b.edit((d) => E.updateTitle(d, titleId, { synopsis: 'Bで書いたあらすじ' }))
    await b.online()
    await settle(a, b)
    const t = (await a.load()).titles[titleId]
    expect(t.name).toBe('Aで変えた名前')
    expect(t.synopsis).toBe('Bで書いたあらすじ')
  })

  it('同じ稿の本文を両方で変えたら、片方を別の稿として残す（どちらの文章も消えない）', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let pieceId = ''
    let versionId = ''
    await a.edit((d) => {
      const r = withTitle(d, '作品')
      pieceId = r.pieceId
      versionId = r.data.pieces[r.pieceId].versionIds[0]
      return S.updateVersion(r.data, versionId, { body: '最初の本文' })
    })
    await b.online()
    await settle(a, b)
    b.offline()
    await a.edit((d) => S.updateVersion(d, versionId, { body: 'Aで直した本文' }))
    await settle(a)
    await b.edit((d) => S.updateVersion(d, versionId, { body: 'Bで直した本文', note: 'Bのメモ' }))
    await b.online()
    await settle(a, b)
    const d = await a.load()
    expect(d.versions[versionId].body).toBe('Aで直した本文')
    // 本文以外の項目は合わせる
    expect(d.versions[versionId].note).toBe('Bのメモ')
    const piece = d.pieces[pieceId]
    expect(piece.versionIds).toHaveLength(2)
    const copy = d.versions[piece.versionIds[1]]
    expect(copy.body).toBe('Bで直した本文')
    expect(copy.name).toContain('競合: b')
    expect(piece.activeVersionId).toBe(versionId)
  })

  it('片方で削除・片方で編集したら、削除しつつ編集された文章をゴミ箱に残す', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let memoId = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      const m = E.addMemo(t.data, t.result, '大事なメモ')
      memoId = m.result
      return E.updateMemo(m.data, memoId, { body: '最初' })
    })
    await b.online()
    await settle(a, b)
    b.offline()
    await a.edit((d) => {
      const { [memoId]: _gone, ...memos } = d.memos
      void _gone
      return { ...d, memos }
    })
    await settle(a)
    await b.edit((d) => E.updateMemo(d, memoId, { body: 'オフラインで書き足した' }))
    await b.online()
    await settle(a, b)
    const d = await a.load()
    expect(d.memos[memoId]).toBeUndefined()
    const entries = Object.values(d.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0].reason).toBe('conflict')
    expect(entries[0].kind).toBe('memo')
    const rec = d.trashRecords[entries[0].recordIds[0]]
    expect((rec.record as { body: string }).body).toBe('オフラインで書き足した')
  })

  it('両方で話を足したら、構成の並びに両方が入る', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let titleId = ''
    await a.edit((d) => {
      const r = withTitle(d, '作品')
      titleId = r.titleId
      return r.data
    })
    await b.online()
    await settle(a, b)
    b.offline()
    await a.edit((d) => S.addEpisode(d, titleId).data)
    await settle(a)
    await b.edit((d) => S.addSpecial(d, titleId, { chapterId: null, index: 0 }, 'プロローグ').data)
    await b.online()
    await settle(a, b)
    const d = await b.load()
    const kinds = d.titles[titleId].structure.map((n) => d.pieces[n.id]?.kind)
    expect(kinds).toEqual(['special', 'episode', 'episode'])
  })

  it('大きなレコードは分割して送り、そのまま受け取れる。小さくなったら分割文書を消す', async () => {
    const who = account()
    const a = await makeDevice('a', who, { chunkSize: 1000 })
    const b = await makeDevice('b', who, { chunkSize: 1000 })
    await a.online()
    await b.online()
    let versionId = ''
    const big = '長い本文𠮷'.repeat(900)
    await a.edit((d) => {
      const r = withTitle(d, '長編')
      versionId = r.data.pieces[r.pieceId].versionIds[0]
      return S.updateVersion(r.data, versionId, { body: big })
    })
    await waitFor(async () => (await b.load()).versions[versionId]?.body === big, '大きな本文が届く')
    const col = collection(a.fs, 'users', a.uid, 'records')
    const chunkCount = async () => (await getDocs(col)).docs.filter((x) => x.data().table === '_chunk').length
    expect(await chunkCount()).toBeGreaterThan(1)
    await a.edit((d) => S.updateVersion(d, versionId, { body: '短く' }))
    await waitFor(async () => (await b.load()).versions[versionId]?.body === '短く', '短い本文が届く')
    expect(await chunkCount()).toBe(0)
    await settle(a, b)
  })

  it('送り終わると送信待ちが空になり、同じ内容を書き直し続けない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    await a.online()
    let titleId = ''
    await a.edit((d) => {
      const r = E.createTitle(d, '作品')
      titleId = r.result
      return r.data
    })
    await settle(a)
    const ref = doc(a.fs, 'users', a.uid, 'records', `titles:${titleId}`)
    const first = (await getDoc(ref)).data()?.updated
    await new Promise((r) => setTimeout(r, 500))
    await a.engine?.idle()
    expect((await getDoc(ref)).data()?.updated).toEqual(first)
    expect(await a.p.outboxCount()).toBe(0)
  })

  it('別のアカウントの原稿は読めない', async () => {
    const a = await makeDevice('a', account())
    const other = await makeDevice('x', account())
    await a.online()
    await a.edit((d) => E.createTitle(d, '秘密の作品').data)
    await settle(a)
    await expect(getDocs(collection(other.fs, 'users', a.uid, 'records'))).rejects.toThrow()
  })

  it('続けて書いて送っても、先に送った古い版の通知で本文が巻き戻らず、競合の控えも作らない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    let pieceId = ''
    let versionId = ''
    await a.edit((d) => {
      const r = withTitle(d, '作品')
      pieceId = r.pieceId
      versionId = r.data.pieces[r.pieceId].versionIds[0]
      return r.data
    })
    await settle(a, b)
    let body = ''
    for (let i = 0; i < 25; i++) {
      body += `${i}行目。`
      const text = body
      await a.edit((d) => S.updateVersion(d, versionId, { body: text }))
      void a.engine?.flush()
      await new Promise((r) => setTimeout(r, 15))
    }
    await settle(a, b)
    for (const d of [a, b]) {
      const data = await d.load()
      expect(data.versions[versionId].body).toBe(body)
      expect(data.pieces[pieceId].versionIds).toHaveLength(1)
      expect(Object.keys(data.trashEntries)).toHaveLength(0)
    }
  })

  it('バックアップからの復元は、ほかの端末にも当たる（この端末が受け取っていないレコードも消える）', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let titleId = ''
    let m1 = ''
    let m2 = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      titleId = t.result
      const x = E.addMemo(t.data, t.result, 'メモ1')
      m1 = x.result
      const y = E.addMemo(x.data, t.result, 'メモ2')
      m2 = y.result
      return y.data
    })
    const backup = await a.load()
    await b.online()
    await settle(a, b)
    // A がオフラインの間に、B がメモ3を作った（A は受け取っていない）
    a.offline()
    let m3 = ''
    await b.edit((d) => {
      const z = E.addMemo(d, titleId, 'メモ3')
      m3 = z.result
      return z.data
    })
    await settle(b)
    // A は、メモ2を消してメモ4を足したバックアップで復元する
    const { [m2]: _gone, ...memos } = backup.memos
    void _gone
    const restored = E.addMemo({ ...backup, memos }, titleId, 'メモ4')
    await a.restore(restored.data)
    await a.online()
    await settle(a, b)
    for (const d of [a, b]) {
      const data = await d.load()
      expect(Object.keys(data.memos).sort()).toEqual([m1, restored.result].sort())
      expect(data.memos[m3]).toBeUndefined()
    }
  })

  it('同じバックアップを入れた2台が初めてログインすると、クラウド側を採り、違う文章は控える', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    const t = E.createTitle(emptyData(), '作品')
    const m = E.addMemo(t.data, t.result, 'メモ')
    const k = E.addMemo(m.data, t.result, '消すメモ')
    const base = E.updateMemo(k.data, m.result, { body: '古い本文' })
    await a.restore(base)
    await b.restore(base)
    await a.p.setMeta('authoritative', null)
    await b.p.setMeta('authoritative', null)
    await a.online()
    await settle(a)
    // A が先にログインして同期した後で、メモを直し、もう1つのメモを消した
    await a.edit((d) => {
      const { [k.result]: _gone, ...memos } = E.updateMemo(d, m.result, { body: 'Aで直した本文' }).memos
      void _gone
      return { ...d, memos }
    })
    await settle(a)
    await b.online()
    await settle(a, b)
    const data = await b.load()
    expect(data.memos[m.result].body).toBe('Aで直した本文')
    expect(data.memos[k.result]).toBeUndefined()
    const kept = Object.values(data.trashRecords).map((r) => (r.record as { body?: string; name?: string }).name)
    // 違う内容だった B のメモと、A で消されていたメモは、ゴミ箱に控える
    expect(kept.sort()).toEqual(['メモ', '消すメモ'].sort())
  })

  it('まだ同期したことの無い端末で復元してから初めてログインしても、ほかの端末の内容は消えない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let keep = ''
    await a.edit((d) => {
      const t = E.createTitle(d, 'Aの作品')
      keep = t.result
      return t.data
    })
    await settle(a)
    const t = E.createTitle(emptyData(), 'Bのバックアップの作品')
    await b.restore(t.data)
    await b.online()
    await settle(a, b)
    for (const d of [a, b]) {
      const data = await d.load()
      expect(data.titles[keep]?.name).toBe('Aの作品')
      expect(data.titles[t.result]?.name).toBe('Bのバックアップの作品')
    }
  })

  it('すべて削除はほかの端末からも消え、受け取った端末に控えを作らない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await a.edit((d) => {
      const r = withTitle(d, '作品')
      const vid = r.data.pieces[r.pieceId].versionIds[0]
      return E.addMemo(S.updateVersion(r.data, vid, { body: '本文' }), r.titleId, 'メモ').data
    })
    await b.online()
    await settle(a, b)
    await a.restore(emptyData())
    await settle(a, b)
    const data = await b.load()
    expect(Object.values(data).every((t) => Object.keys(t).length === 0)).toBe(true)
  })

  it('大きなタイトルを削除して何回かに分けて届いても、受け取った端末にゴミ箱の重複を作らない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    let titleId = ''
    await a.edit((d) => {
      const r = withTitle(d, '長編')
      titleId = r.titleId
      let data = r.data
      for (let i = 0; i < 130; i++) data = S.addVersion(data, r.pieceId, { body: `稿${i}` }).data
      return data
    })
    await b.online()
    await settle(a, b)
    await a.edit((d) => E.deleteTitle(d, titleId))
    await settle(a, b)
    const data = await b.load()
    expect(data.titles[titleId]).toBeUndefined()
    expect(Object.keys(data.versions)).toHaveLength(0)
    expect(Object.values(data.trashEntries).filter((e) => e.reason === 'conflict')).toHaveLength(0)
    expect(Object.keys(data.trashEntries)).toHaveLength(1)
  })

  it('本番のアクセスルール: 最初にログインしたアカウントだけが使え、ほかのアカウントは同期できない', async () => {
    await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
      rules: { files: [{ name: 'firestore.rules', content: prodRules }] },
    })
    await emulatorRequest('DELETE', `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`)
    try {
      const owner = await makeDevice('owner', account(), { ownerLock: true })
      await owner.online()
      await owner.edit((d) => E.createTitle(d, '持ち主の作品').data)
      await settle(owner)
      const stranger = await makeDevice('stranger', account(), { ownerLock: true })
      await stranger.online()
      await waitFor(async () => stranger.engine?.status.phase === 'error', '別のアカウントは同期できない')
      expect(stranger.engine?.status.error).toContain('別の Google アカウント')
      // ルールでも、持ち主以外は自分の場所にさえ書けない・持ち主の原稿は読めない
      await expect(getDocs(collection(stranger.fs, 'users', owner.uid, 'records'))).rejects.toThrow()
      await expect(
        setDoc(doc(stranger.fs, 'users', stranger.uid, 'records', 'titles:x'), {
          table: 'titles',
          id: 'x',
          json: '{}',
          chunks: 0,
          deleted: false,
          hash: 'h',
          updated: serverTimestamp(),
          device: 'd',
        }),
      ).rejects.toThrow()
      // 持ち主も、決まった形でない文書は書けない
      await expect(
        setDoc(doc(owner.fs, 'users', owner.uid, 'records', 'titles:y'), { table: 'titles', junk: 'x'.repeat(10) }),
      ).rejects.toThrow()
    } finally {
      await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
        rules: { files: [{ name: 'firestore.rules', content: emuRules }] },
      })
    }
  })
})

async function emulatorRequest(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:8080${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
}
