// Firebase（ログインとクラウドの保存先）の初期化。同期を使う時だけ読み込む（未ログインの端末の起動を重くしない）。
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getRedirectResult,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore'

// Firebase の Web アプリの設定値（公開してよい識別子。原稿はアクセスルールで本人だけに限っている）
const config = {
  apiKey: 'AIzaSyADnvD0uAVwicAMol6_Txl-7CRV_xxsg00',
  authDomain: 'novel-studio-3352e.firebaseapp.com',
  projectId: 'novel-studio-3352e',
  storageBucket: 'novel-studio-3352e.firebasestorage.app',
  messagingSenderId: '223868754377',
  appId: '1:223868754377:web:37765607c43f63d4de3018',
}

/** 開発・テスト用: エミュレーターのホスト（例: 127.0.0.1）。設定するとクラウドではなくエミュレーターにつなぐ */
const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR as string | undefined
export const usingEmulator = Boolean(emulatorHost)

/**
 * Firebase Hosting に置いた時は、ログインの画面も同じドメインで開く
 * （Safari などでサードパーティの保存領域が使えなくてもログインできるように）。
 */
function authDomain(): string {
  if (typeof location !== 'undefined' && /\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) return location.host
  return config.authDomain
}

export interface FirebaseServices {
  app: FirebaseApp
  auth: Auth
  firestore: Firestore
}

let services: FirebaseServices | null = null

export function firebase(): FirebaseServices {
  if (services) return services
  const app = initializeApp({
    ...config,
    authDomain: authDomain(),
    ...(usingEmulator ? { projectId: 'demo-novel-studio' } : {}),
  })
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    popupRedirectResolver: browserPopupRedirectResolver,
  })
  const firestore = initializeFirestore(app, { localCache: memoryLocalCache() })
  if (emulatorHost) {
    connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true })
    connectFirestoreEmulator(firestore, emulatorHost, 8080)
  }
  services = { app, auth, firestore }
  return services
}

export function watchUser(fn: (user: User | null) => void): () => void {
  return onAuthStateChanged(firebase().auth, fn)
}

/** ホーム画面に追加した iPhone のアプリなど、ポップアップが使いにくい環境 */
function prefersRedirect(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true
}

/** リダイレクトでログインに出かける印（戻ってきた時に、まだログインしたことのない端末でも結果を受け取るため） */
const REDIRECT_MARK = 'novel-studio:auth-redirect'

async function redirectSignIn(auth: Auth, provider: GoogleAuthProvider): Promise<void> {
  try {
    localStorage.setItem(REDIRECT_MARK, String(Date.now()))
  } catch {
    /* noop */
  }
  await signInWithRedirect(auth, provider)
}

export async function signInWithGoogle(): Promise<void> {
  const { auth } = firebase()
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  if (prefersRedirect()) {
    await redirectSignIn(auth, provider)
    return
  }
  try {
    await signInWithPopup(auth, provider)
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await redirectSignIn(auth, provider)
      return
    }
    throw e
  }
}

/** リダイレクトでログインして戻ってきた時の結果を受け取る */
export async function completeRedirect(): Promise<void> {
  await getRedirectResult(firebase().auth)
}

export async function signOutUser(): Promise<void> {
  await signOut(firebase().auth)
}

/** テスト用: エミュレーターの仮のアカウントでログインする */
export async function signInForTest(sub: string, email = `${sub}@example.com`): Promise<void> {
  if (!usingEmulator) throw new Error('エミュレーターを使っている時だけ使えます')
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true, name: sub }))
  await signInWithCredential(firebase().auth, cred)
}

/** ログインの失敗を利用者向けの言葉にする（閉じただけなら null） */
export function describeAuthError(e: unknown): string | null {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled')
    return null
  if (code === 'auth/network-request-failed') return 'インターネットにつながっていないため、ログインできませんでした。'
  if (code === 'auth/unauthorized-domain')
    return 'このアドレスからはログインできません。Firebase の Authentication の「承認済みドメイン」に追加してください。'
  if (code === 'auth/popup-blocked') return 'ポップアップがブロックされました。ブラウザの設定で許可してください。'
  return `ログインできませんでした（${code || (e instanceof Error ? e.message : String(e))}）`
}
