// 同期の司令塔: ログインの状態を見て同期エンジンを動かし、状態を画面に知らせる。
// - Firebase は一度でもログインした端末だけ起動時に読み込む（それ以外は「ログイン」を押した時）
// - 同じ端末で複数の画面（タブ・ウィンドウ）を開いている時は、1つの画面だけが同期を受け持つ
import { create } from 'zustand'
import { newId } from '../domain/util'
import { applyRemoteChanges, flushNow, getPersistence, onExternalSave, onLocalSave } from '../store/appStore'
import type { SyncEngine, SyncStatus, SyncTarget } from './engine'

export interface SyncUser {
  uid: string
  name: string
  email: string
}

export interface SyncState {
  /** idle = まだ Firebase を読み込んでいない（ログインしたことのない端末） */
  auth: 'idle' | 'checking' | 'signedOut' | 'signedIn'
  user: SyncUser | null
  status: SyncStatus | null
  /** この画面が同期を受け持っている */
  leader: boolean
  /** この端末で一度でもログインしたことがある */
  everSignedIn: boolean
  busy: boolean
  error: string | null
  /**
   * この端末は以前、別のアカウント（previousEmail）と同期していた。確かめるまで同期を始めない
   * （間違えて別のアカウントを選んだ時に、原稿がそのアカウントへ写らないように）
   */
  accountMismatch: { previousEmail: string } | null
}

const initial: SyncState = {
  auth: 'idle',
  user: null,
  status: null,
  leader: false,
  everSignedIn: false,
  busy: false,
  error: null,
  accountMismatch: null,
}

export const useSync = create<SyncState>(() => ({ ...initial }))

let engine: SyncEngine | null = null
let generation = 0
let releaseLeader: (() => void) | null = null
let booted: Promise<void> | null = null
let hooksInstalled = false

const firebaseModule = () => import('./firebase')

function storeTarget(): SyncTarget {
  const p = getPersistence()
  if (!p) throw new Error('保存先が初期化されていません')
  return {
    readOutbox: (n) => p.readOutbox(n),
    completeUpload: (sent) => p.completeUpload(sent),
    applyRemote: (changes, cursor) => applyRemoteChanges(changes, cursor),
    outboxCount: () => p.outboxCount(),
    markAllDirty: () => p.markAllDirty(),
    localKeys: () => p.localKeys(),
    getMeta: (k) => p.getMeta(k),
    setMeta: (k, v) => p.setMeta(k, v),
    flush: () => flushNow(),
  }
}

async function deviceId(): Promise<string> {
  const p = getPersistence()
  const stored = await p?.getMeta<string>('deviceId')
  if (stored) return stored
  const id = newId()
  await p?.setMeta('deviceId', id)
  return id
}

/** 同期を受け持つ画面が、ほかの画面（タブ・ウィンドウ）に状態を知らせる */
const STATUS_CHANNEL = 'novel-studio-sync-status'
let statusChannel: BroadcastChannel | null = null
/** 画面がこれより長く裏にあったら、戻った時に購読し直す（長く切れていた購読は全件を読み直すため） */
const REANCHOR_AFTER_MS = 20 * 60 * 1000

function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  onLocalSave(() => engine?.requestUpload())
  onExternalSave(() => engine?.requestUpload())
  if (typeof document !== 'undefined') {
    let hiddenAt = 0
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        // 画面を閉じる・裏に回る時は待たずに送る
        engine?.requestUpload(true)
      } else if (hiddenAt && Date.now() - hiddenAt > REANCHOR_AFTER_MS) {
        engine?.reanchor()
      }
    })
  }
  try {
    statusChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(STATUS_CHANNEL)
    if (statusChannel) {
      statusChannel.onmessage = (ev: MessageEvent<{ status?: SyncStatus; request?: boolean }>) => {
        const { leader, status } = useSync.getState()
        // 後から開いた画面が尋ねてきたら、いまの状態を答える
        if (ev.data?.request) {
          if (leader && status) publishStatus(status)
          return
        }
        // 同期を受け持っていない画面は、受け持つ画面の状態を出す
        if (!leader && ev.data?.status) useSync.setState({ status: ev.data.status })
      }
      statusChannel.postMessage({ request: true })
    }
  } catch {
    statusChannel = null
  }
}

function publishStatus(status: SyncStatus): void {
  try {
    statusChannel?.postMessage({ status })
  } catch {
    /* noop */
  }
}

function stopEngine(): void {
  generation += 1
  engine?.stop()
  engine = null
  releaseLeader?.()
  releaseLeader = null
  useSync.setState({ leader: false, status: null })
}

function startEngine(uid: string): void {
  stopEngine()
  const token = generation
  const run = async () => {
    if (token !== generation) return
    const [{ createSyncEngine }, fb] = await Promise.all([import('./engine'), firebaseModule()])
    if (token !== generation) return
    const e = createSyncEngine({
      firestore: fb.firebase().firestore,
      uid,
      deviceId: await deviceId(),
      target: storeTarget(),
      ownerLock: !fb.usingEmulator,
      onStatus: (status) => {
        if (engine !== e) return
        useSync.setState({ status })
        publishStatus(status)
      },
    })
    engine = e
    useSync.setState({ leader: true, status: e.status })
    await e.start()
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks?.request) {
    const released = new Promise<void>((resolve) => {
      releaseLeader = resolve
    })
    void locks
      .request('novel-studio-sync', async () => {
        await run().catch(reportError)
        await released
      })
      .catch(reportError)
  } else {
    void run().catch(reportError)
  }
}

function reportError(e: unknown): void {
  console.warn('同期を始められませんでした', e)
  useSync.setState({ error: e instanceof Error ? e.message : String(e) })
}

function boot(): Promise<void> {
  booted ??= (async () => {
    installHooks()
    useSync.setState({ auth: 'checking' })
    const fb = await firebaseModule()
    fb.firebase()
    await fb.completeRedirect().catch((e) => {
      const message = fb.describeAuthError(e)
      if (message) useSync.setState({ error: message })
    })
    try {
      localStorage.removeItem(REDIRECT_MARK)
    } catch {
      /* noop */
    }
    fb.watchUser((user) => {
      if (user) {
        const email = user.email ?? ''
        useSync.setState({
          auth: 'signedIn',
          user: { uid: user.uid, name: user.displayName ?? '', email },
          everSignedIn: true,
          error: null,
        })
        void (async () => {
          const p = getPersistence()
          const previous = await p?.getMeta<string>('uid')
          if (previous && previous !== user.uid) {
            stopEngine()
            useSync.setState({ accountMismatch: { previousEmail: (await p?.getMeta<string>('email')) ?? '' } })
            return
          }
          await p?.setMeta('email', email)
          useSync.setState({ accountMismatch: null })
          startEngine(user.uid)
        })().catch(reportError)
      } else {
        stopEngine()
        useSync.setState({ auth: 'signedOut', user: null, accountMismatch: null })
      }
    })
  })()
  return booted
}

/** 起動時に呼ぶ。ログインしたことのある端末なら同期を始める */
export async function initSync(): Promise<void> {
  const p = getPersistence()
  if (!p) return
  const everSignedIn = Boolean(await p.getMeta('uid'))
  useSync.setState({ everSignedIn })
  // リダイレクトでログインして戻ってきた時も、その結果を受け取るために Firebase を読み込む
  if (everSignedIn || redirectPending()) await boot().catch(reportError)
}

const REDIRECT_MARK = 'novel-studio:auth-redirect'

function redirectPending(): boolean {
  try {
    if (localStorage.getItem(REDIRECT_MARK)) return true
    for (let i = 0; i < sessionStorage.length; i++) {
      if (sessionStorage.key(i)?.startsWith('firebase:pendingRedirect')) return true
    }
  } catch {
    /* noop */
  }
  return false
}

/** この端末を、いまログインしているアカウントと同期するようにする（以前は別のアカウントと同期していた時） */
export async function confirmAccountSwitch(): Promise<void> {
  const user = useSync.getState().user
  const p = getPersistence()
  if (!user || !p) return
  await p.setMeta('email', user.email)
  useSync.setState({ accountMismatch: null })
  startEngine(user.uid)
}

export async function signIn(): Promise<void> {
  useSync.setState({ busy: true, error: null })
  try {
    await boot()
    const fb = await firebaseModule()
    // リダイレクトでのログインが、Firebase を読み込んだ時点で済んでいることがある
    if (fb.firebase().auth.currentUser) return
    await fb.signInWithGoogle()
  } catch (e) {
    const fb = await firebaseModule().catch(() => null)
    const message = fb ? fb.describeAuthError(e) : e instanceof Error ? e.message : String(e)
    if (message) useSync.setState({ error: message })
  } finally {
    useSync.setState({ busy: false })
  }
}

export async function signOut(): Promise<void> {
  useSync.setState({ busy: true, error: null })
  try {
    // 送れるものは送ってからログアウトする（送れなくても端末内には残り、次にログインした時に送る）
    await engine?.flush().catch(() => undefined)
    const fb = await firebaseModule()
    await fb.signOutUser()
  } catch (e) {
    reportError(e)
  } finally {
    useSync.setState({ busy: false })
  }
}

/** いますぐ送る（「今すぐ同期」ボタン） */
export function syncNow(): Promise<void> {
  return engine ? engine.flush() : Promise.resolve()
}

/** テスト用: エミュレーターの仮のアカウントでログインする */
export async function signInForTest(sub: string): Promise<void> {
  await boot()
  const fb = await firebaseModule()
  await fb.signInForTest(sub)
}

/** テスト用 */
export function resetSyncForTests(): void {
  stopEngine()
  booted = null
  useSync.setState({ ...initial })
}
