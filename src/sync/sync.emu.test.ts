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
  onSnapshot,
  serverTimestamp,
  setDoc,
  terminate,
  type Firestore,
} from 'firebase/firestore'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistence, type ConflictNote, type Persistence } from '../db/persistence'
import * as A from '../domain/acts'
import * as E from '../domain/entityOps'
import { repairData } from '../domain/repair'
import * as S from '../domain/storyOps'
import { emptyData, type AppData } from '../domain/types'
import { newId } from '../domain/util'
import {
  ACTS_SCENARIOS,
  scenarioProblems,
  scenarioStart,
  seenVersions,
  texts,
  type ActsScenario,
  type Order,
} from '../test/actsScenarios'
import { appModelRef, type AppModel } from './appModel'
import { createConflictHooks } from './conflicts'
import { createSyncEngine, type SyncEngine, type SyncTarget } from './engine'
import { stableStringify } from './merge'

/**
 * 購読の通知を端末ごとに間引く（ページが止まった・裏に回った間に、自分の書き込みの通知を受け取れなかった時の再現）。
 * dropOwn に Firestore と端末の名前を入れると、その端末の書き込みだけの通知を捨てる（ほかの端末の書き込みは届く）
 */
const listen = vi.hoisted(() => ({ dropOwn: new Map<unknown, string>() }))
vi.mock('firebase/firestore', async (importOriginal) => {
  const m = await importOriginal<typeof import('firebase/firestore')>()
  type Snap = { docChanges?: () => { doc: { data: () => { device?: unknown } } }[] }
  const onSnapshot = (ref: { firestore: unknown }, ...rest: unknown[]) => {
    const i = rest.findIndex((x) => typeof x === 'function')
    const next = rest[i] as (snap: Snap) => void
    rest[i] = (snap: Snap) => {
      const own = listen.dropOwn.get(ref.firestore)
      const changes = own && snap.docChanges ? snap.docChanges() : []
      if (own && changes.length && changes.every((c) => c.doc.data().device === own)) return
      next(snap)
    }
    return (m.onSnapshot as unknown as (...a: unknown[]) => () => void)(ref, ...rest)
  }
  return { ...m, onSnapshot }
})

const PROJECT = 'demo-novel-studio'
let seq = 0

interface Device {
  name: string
  uid: string
  p: Persistence
  fs: Firestore
  engine: SyncEngine | null
  /** 競合の知らせ（applyRemote の report） */
  notes: ConflictNote[]
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
  listen.dropOwn.clear()
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
  opts: { chunkSize?: number; ownerLock?: boolean; appModel?: AppModel } = {},
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
  const notes: ConflictNote[] = []
  const target: SyncTarget = {
    readOutbox: (n) => p.readOutbox(n),
    completeUpload: (s) => p.completeUpload(s),
    applyRemote: async (changes, cursor, opts) => {
      // 控えの表記は、反映する前の表示用の内容で作る（ストアと同じ）
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
    fs,
    engine: null,
    notes,
    load() {
      return p.load()
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
        appModel: opts.appModel,
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

  it('送った後に自分の書き込みの通知を受け取れなくても、ほかの端末がその後に消したものは消える', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    let titleId = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      titleId = t.result
      return t.data
    })
    await settle(a, b)
    // A は送った後にページが止まり、自分の書き込みの通知を受け取らない
    listen.dropOwn.set(a.fs, 'a')
    let memoId = ''
    await a.edit((d) => {
      const m = E.addMemo(d, titleId, '作ったメモ')
      memoId = m.result
      return m.data
    })
    const ref = doc(a.fs, 'users', a.uid, 'records', `memos:${memoId}`)
    await waitFor(async () => (await getDoc(ref)).exists() && (await a.p.outboxCount()) === 0, 'A のメモが送られる')
    await waitFor(async () => (await b.load()).memos[memoId], 'B にメモが届く')
    // B が消す（削除の文書は、どれも同じ指紋）
    await b.edit((d) => {
      const { [memoId]: _gone, ...memos } = d.memos
      void _gone
      return { ...d, memos }
    })
    await waitFor(async () => (await getDoc(ref)).data()?.deleted === true, 'B の削除が送られる')
    await waitFor(async () => !(await a.load()).memos[memoId], 'A でもメモが消える')
    expect(await a.p.outboxCount()).toBe(0)
    listen.dropOwn.clear()
    await settle(a, b)
  })

  it('送った後に自分の書き込みの通知を受け取れなくても、ほかの端末が同じ内容で戻したものは戻る', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    let memoId = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      const m = E.addMemo(t.data, t.result, '戻すメモ')
      memoId = m.result
      return E.updateMemo(m.data, memoId, { body: '本文' })
    })
    await settle(a, b)
    const original = (await a.load()).memos[memoId]
    // A が消して送った後、ページが止まり、自分の書き込みの通知を受け取らない
    listen.dropOwn.set(a.fs, 'a')
    await a.edit((d) => {
      const { [memoId]: _gone, ...memos } = d.memos
      void _gone
      return { ...d, memos }
    })
    const ref = doc(a.fs, 'users', a.uid, 'records', `memos:${memoId}`)
    await waitFor(
      async () => (await getDoc(ref)).data()?.deleted === true && (await a.p.outboxCount()) === 0,
      'A の削除が送られる',
    )
    await waitFor(async () => !(await b.load()).memos[memoId], 'B でも消える')
    // B がまったく同じ内容で戻す（消す前と同じ指紋）
    await b.edit((d) => ({ ...d, memos: { ...d.memos, [memoId]: original } }))
    await waitFor(async () => (await getDoc(ref)).data()?.deleted === false, 'B の戻した内容が送られる')
    await waitFor(async () => (await a.load()).memos[memoId], 'A でもメモが戻る')
    expect((await a.load()).memos[memoId]).toEqual(original)
    expect(await a.p.outboxCount()).toBe(0)
    listen.dropOwn.clear()
    await settle(a, b)
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

  it('復元でこの端末に無いクラウドのレコードを消す時は、子から先に消す（何回かに分けて書いても）', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await a.edit((d) => E.createTitle(d, '作品').data)
    await b.online()
    await settle(a, b)
    const backup = await a.load()
    // A がオフラインの間に、B が大きなタイトルを作った（A は受け取っていないので、復元でまとめて消す）
    a.offline()
    let titleId = ''
    await b.edit((d) => {
      const r = withTitle(d, '長編')
      titleId = r.titleId
      let data = r.data
      for (let i = 0; i < 250; i++) data = S.addVersion(data, r.pieceId, { body: `稿${i}` }).data
      return data
    })
    await settle(b)
    await a.restore(backup)
    await a.online()
    await settle(a, b)
    // 消した文書の時刻: 稿（子）はどれも、話・タイトル（親）より後に消されていない
    const docs = (await getDocs(collection(a.fs, 'users', a.uid, 'records'))).docs.map(
      (x) => x.data() as { table: string; deleted: boolean; reset?: boolean; updated: { toMillis(): number } },
    )
    const gone = (table: string) => docs.filter((x) => x.table === table && x.deleted && x.reset).map((x) => x.updated.toMillis())
    expect(gone('versions')).toHaveLength(251)
    expect(Math.max(...gone('versions'))).toBeLessThanOrEqual(Math.min(...gone('pieces')))
    expect(Math.max(...gone('pieces'))).toBeLessThanOrEqual(Math.min(...gone('titles')))
    // 受け取った端末は、消えた親の子を控えない（子の削除が先か同じ通知で届いている）
    const data = await b.load()
    expect(data.titles[titleId]).toBeUndefined()
    expect(Object.keys(data.trashEntries)).toEqual([])
  })

  it('受け取り済みの復元の書き込みが、購読し直して届き直しても、その後の書き換えを戻さない', async () => {
    const who = account()
    const a = await makeDevice('a', who)
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    let versionId = ''
    await a.edit((d) => {
      const r = withTitle(d, '作品')
      versionId = r.data.pieces[r.pieceId].versionIds[0]
      return S.updateVersion(r.data, versionId, { body: '戻した本文' })
    })
    await settle(a, b)
    // A がバックアップから戻し（1回の書き込み）、B が受け取った（B の受け取った位置 = その書き込みの時刻）
    await a.restore(await a.load())
    await settle(a, b)
    // B は閉じている間に書き換えてから開き直した: 記録した位置から購読し直すと、その時刻の復元の書き込みが届き直す
    // （復元の印は次に書かれるまで残る）。届き直した通知を反映するまで、B は送らない
    b.offline()
    await b.edit((d) => S.updateVersion(d, versionId, { body: 'Bで後から書いた' }))
    let applied: () => void = () => undefined
    const firstApply = new Promise<void>((r) => (applied = r))
    const realApply = b.p.applyRemote.bind(b.p)
    b.p.applyRemote = async (changes, opts) => {
      const r = await realApply(changes, opts)
      if (changes.some((c) => c.table === 'versions' && c.id === versionId)) applied()
      return r
    }
    const realRead = b.p.readOutbox.bind(b.p)
    b.p.readOutbox = async (n) => {
      await firstApply
      return realRead(n)
    }
    await b.online()
    await settle(a, b)
    for (const d of [a, b]) {
      const data = await d.load()
      expect(data.versions[versionId].body).toBe('Bで後から書いた')
      expect(Object.keys(data.trashEntries)).toEqual([])
    }
    expect(b.notes).toEqual([])
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

/**
 * 幕の場面を1つ試す: 2台で揃えてから、片方（second）をオフラインにして、先に送る端末（first）の操作を送り終え、
 * オフラインの端末でも操作してからつなぐ。揃った後の内容が場面の約束を守っているかを返す
 */
async function runActsScenario(s: ActsScenario, order: Order): Promise<string[]> {
  const who = account()
  const x = await makeDevice('x', who)
  const y = await makeDevice('y', who)
  await x.online()
  await y.online()
  const start = scenarioStart(s)
  await x.edit(() => start.data)
  await settle(x, y)
  x.notes.length = 0
  y.notes.length = 0
  const ep = start.ep
  const [first, second] = order === 'x-first' ? [x, y] : [y, x]
  const opOf = (d: Device) => (d === x ? s.x : s.y)
  second.offline()
  await first.edit((d) => opOf(first)(d, ep))
  await settle(first)
  await second.edit((d) => opOf(second)(d, ep))
  const seen = [...texts(await x.load()), ...texts(await y.load())]
  const seenV = [...seenVersions(await x.load(), start.data), ...seenVersions(await y.load(), start.data)]
  await second.online()
  await settle(x, y)
  const problems = scenarioProblems(s, order, await x.load(), ep, seen, seenV, { x: x.notes, y: y.notes })
  if (problems.length) problems.push(`知らせ: x=${JSON.stringify(x.notes)} y=${JSON.stringify(y.notes)}`)
  return problems
}

describe('幕の構成を2台で同時に変えた時の同期（エミュレーター）', () => {
  it('幕のまとまりは1回の書き込みで送られ、ほかの端末には幕の並びと幕がいっしょに届く', async () => {
    const who = account()
    const x = await makeDevice('x', who)
    const y = await makeDevice('y', who)
    await x.online()
    await y.online()
    const start = scenarioStart({ body: 'ABCDEF', splitAt: null })
    const ep = start.ep
    await x.edit(() => start.data)
    await settle(x, y)
    // 生の購読で、届いた内容が途中の状態（話の幕の並びに載っていない幕がある）にならないかを見る
    const seenDocs = new Map<string, { json: string | null; deleted: boolean }>()
    const problems: string[] = []
    const unsub = onSnapshot(collection(y.fs, 'users', y.uid, 'records'), (snap) => {
      for (const ch of snap.docChanges()) {
        const d = ch.doc.data() as { json: string | null; deleted: boolean }
        seenDocs.set(ch.doc.id, d)
      }
      const episode = seenDocs.get(`pieces:${ep}`)
      const listed: string[] = episode?.json ? ((JSON.parse(episode.json) as { actIds?: string[] }).actIds ?? []) : []
      for (const [id, d] of seenDocs) {
        if (!id.startsWith('pieces:') || !d.json || d.deleted) continue
        const rec = JSON.parse(d.json) as { kind?: string; parentId?: string; id: string }
        if (rec.kind === 'act' && rec.parentId === ep && !listed.includes(rec.id))
          problems.push(`幕 ${rec.id} が話の幕の並びより先に届いた`)
      }
    })
    // Y が先に話の題を変えて送り、オフラインだった X が分ける（X の話は書けないので、幕だけ先に書かれないように）
    x.offline()
    await y.edit((d) => S.updatePiece(d, ep, { subtitle: 'Yの題' }))
    await settle(y)
    await x.edit((d) => A.separatePiece(d, ep, [3]).data)
    const calls: number[] = []
    const realApply = y.p.applyRemote.bind(y.p)
    y.p.applyRemote = async (changes, opts) => {
      const acts = changes.filter((c) => c.table === 'pieces' && (c.record as { kind?: string } | null)?.kind === 'act')
      if (acts.length) calls.push(changes.filter((c) => c.table === 'pieces').length)
      return realApply(changes, opts)
    }
    await x.online()
    await settle(x, y)
    unsub()
    expect(problems).toEqual([])
    // 幕は、話の幕の並びと同じ反映で届いた（話 + 幕2つ）
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((n) => n >= 3)).toBe(true)
    const d = await y.load()
    expect(d.pieces[ep].actIds).toHaveLength(2)
    expect(d.pieces[ep].subtitle).toBe('Yの題')
  })

  it('つないだ端末の送信を待たせている間も、負けた側の幕はクラウドに残っている（第2幕と第3幕をつなぐ側が後）', async () => {
    const who = account()
    const x = await makeDevice('x', who)
    const y = await makeDevice('y', who)
    await x.online()
    await y.online()
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: [3, 6] })
    const ep = start.ep
    await x.edit(() => start.data)
    await settle(x, y)
    const acts = start.data.pieces[ep].actIds!
    y.offline()
    await x.edit((d) => A.joinActWithNext(d, acts[0]).data)
    await settle(x)
    await y.edit((d) => A.joinActWithNext(d, acts[1]).data)
    // Y の送信（第3幕の削除を含むまとまり）は、話がクラウドで変わっているので書かれない
    const ref = doc(y.fs, 'users', y.uid, 'records', `pieces:${acts[2]}`)
    await y.online()
    await settle(x, y)
    const cloud = (await getDoc(ref)).data() as { deleted: boolean } | undefined
    expect(cloud?.deleted).toBe(false)
    expect((await y.load()).pieces[acts[2]]).toBeDefined()
  })

  for (const s of ACTS_SCENARIOS.filter((x) => x.emu)) {
    for (const order of ['x-first', 'y-first'] as const) {
      it(`${s.name}（${order === 'x-first' ? 'X' : 'Y'} が先に送る）`, async () => {
        expect(await runActsScenario(s, order)).toEqual([])
      })
    }
  }
})

describe('データの形の版（エミュレーター）', () => {
  const APP = { model: 2, appVersion: '2.2' }

  it('新しい版のアプリで書かれたデータがあると、受け取りは続け、送るのは止める。記録が消えたら書き直して送る', async () => {
    const who = account()
    const a = await makeDevice('a', who, { appModel: APP })
    const b = await makeDevice('b', who)
    await a.online()
    await b.online()
    const ref = appModelRef(a.fs, a.uid)
    // 記録が無ければ、この版を書く
    await waitFor(async () => (await getDoc(ref)).data()?.model === 2, '形の版が記録される')
    expect((await getDoc(ref)).data()?.appVersion).toBe('2.2')
    // 新しい版のアプリが記録を上げた
    await setDoc(ref, { model: 3, appVersion: '2.3', updatedAt: serverTimestamp() })
    await waitFor(async () => a.engine?.status.outdated?.model === 3, '古い版の端末が気付く')
    expect(a.engine?.status.outdated?.appVersion).toBe('2.3')
    // 受け取りは続ける
    let memoId = ''
    await b.edit((d) => {
      const t = E.createTitle(d, '作品')
      const m = E.addMemo(t.data, t.result, 'Bのメモ')
      memoId = m.result
      return m.data
    })
    await waitFor(async () => (await a.load()).memos[memoId], 'B の変更が届く')
    // 送らない（送信待ちに残し、クラウドには書かない）
    let ideaId = ''
    await a.edit((d) => {
      const r = E.addIdea(d, null, 'Aのアイデア', '本文')
      ideaId = r.result
      return r.data
    })
    await new Promise((r) => setTimeout(r, 1500))
    await a.engine?.idle()
    expect(await a.p.outboxCount()).toBeGreaterThan(0)
    const ideaDoc = doc(a.fs, 'users', a.uid, 'records', `ideas:${ideaId}`)
    expect((await getDoc(ideaDoc)).exists()).toBe(false)
    // 記録が消された（新しい版をやめて戻した）: この版を書き直し、残していた変更を送る
    await emulatorRequest('DELETE', `/v1/projects/${PROJECT}/databases/(default)/documents/users/${a.uid}/meta/app`)
    await waitFor(async () => (await getDoc(ref)).data()?.model === 2, '形の版が書き直される')
    await waitFor(async () => (await getDoc(ideaDoc)).exists(), '残していた変更が送られる')
    await settle(a, b)
    expect(a.engine?.status.outdated ?? null).toBeNull()
    expect((await b.load()).ideas[ideaId]).toBeDefined()
  })

  it('送っている途中で新しい版のアプリで書かれたデータに気付いたら、残りは送らない', async () => {
    const who = account()
    const a = await makeDevice('a', who, { appModel: APP })
    await a.edit((d) => {
      let data = E.createTitle(d, '作品').data
      const titleId = Object.keys(data.titles)[0]
      for (let i = 0; i < 250; i++) data = E.addMemo(data, titleId, `メモ${i}`).data
      return data
    })
    const ref = appModelRef(a.fs, a.uid)
    // 1回目を送った後、2回目を読む時に、新しい版のアプリが記録を上げた（古い版の端末が気付くまで待つ）
    let reads = 0
    const realRead = a.p.readOutbox.bind(a.p)
    a.p.readOutbox = async (n) => {
      reads += 1
      if (reads === 2) {
        await setDoc(ref, { model: 3, appVersion: '2.3', updatedAt: serverTimestamp() })
        await waitFor(async () => a.engine?.status.outdated?.model === 3, '古い版の端末が気付く')
      }
      return realRead(n)
    }
    await a.online()
    await waitFor(async () => reads >= 2 && a.engine?.status.outdated, '2回目を読む')
    await new Promise((r) => setTimeout(r, 1500))
    await a.engine?.idle()
    const cloudMemos = (await getDocs(collection(a.fs, 'users', a.uid, 'records'))).docs.filter((x) => x.id.startsWith('memos:'))
    // 1回目（100件まで）だけ。残りは送信待ちに残る
    expect(cloudMemos.length).toBeGreaterThan(0)
    expect(cloudMemos.length).toBeLessThanOrEqual(100)
    expect(await a.p.outboxCount()).toBeGreaterThanOrEqual(150)
  })

  it('いますぐ同期は、データの形の版を確かめ終わるのを待ってから送る', async () => {
    const who = account()
    const a = await makeDevice('a', who, { appModel: APP })
    let titleId = ''
    await a.edit((d) => {
      const t = E.createTitle(d, '作品')
      titleId = t.result
      return t.data
    })
    await a.online()
    // 同期を始めた直後（まだ確かめていない）に押した
    await a.engine?.flush()
    expect(await a.p.outboxCount()).toBe(0)
    expect((await getDoc(doc(a.fs, 'users', a.uid, 'records', `titles:${titleId}`))).exists()).toBe(true)
  })

  it('本番のアクセスルール: 持ち主だけが読み書きでき、形の違う記録・下げる書き込みは拒む', async () => {
    await emulatorRequest('PUT', `/emulator/v1/projects/${PROJECT}:securityRules`, {
      rules: { files: [{ name: 'firestore.rules', content: prodRules }] },
    })
    await emulatorRequest('DELETE', `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`)
    try {
      const owner = await makeDevice('owner', account(), { ownerLock: true, appModel: APP })
      await owner.online()
      const ref = appModelRef(owner.fs, owner.uid)
      await waitFor(async () => (await getDoc(ref)).data()?.model === 2, '持ち主が形の版を記録できる')
      // 上げられる
      await setDoc(ref, { model: 3, appVersion: '2.3', updatedAt: serverTimestamp() })
      expect((await getDoc(ref)).data()?.model).toBe(3)
      // 下げられない・形の違う記録は書けない
      await expect(setDoc(ref, { model: 2, appVersion: '2.2', updatedAt: serverTimestamp() })).rejects.toThrow()
      await expect(setDoc(ref, { model: 4, appVersion: '2.4', updatedAt: serverTimestamp(), extra: 1 })).rejects.toThrow()
      await expect(setDoc(ref, { model: '4', appVersion: '2.4', updatedAt: serverTimestamp() })).rejects.toThrow()
      await expect(setDoc(ref, { model: 4, appVersion: '2.4', updatedAt: 12345 })).rejects.toThrow()
      expect((await getDoc(ref)).data()?.model).toBe(3)
      // 持ち主でないアカウントは、持ち主の記録を読めず、自分の場所にも書けない
      const stranger = await makeDevice('stranger', account())
      await expect(getDoc(appModelRef(stranger.fs, owner.uid))).rejects.toThrow()
      await expect(
        setDoc(appModelRef(stranger.fs, stranger.uid), { model: 2, appVersion: '2.2', updatedAt: serverTimestamp() }),
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
    // owner = エミュレーターの管理者（アクセスルールを通さない）
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
}
