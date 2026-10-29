// アプリ（iPhone / Android）のログイン: Firebase の初期化・ログイン・ログアウトの分かれ方（Firebase とプラグインは偽物）
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    platform: { native: true },
    auth: { currentUser: null, name: 'auth' },
    initializeAuth: vi.fn((_app: unknown, _deps: unknown) => h.auth),
    initializeApp: vi.fn((options: Record<string, unknown>) => ({ options })),
    signInWithCredential: vi.fn(async (_auth: unknown, _cred: unknown) => {
      calls.push('signInWithCredential')
      return {}
    }),
    signOut: vi.fn(async () => {
      calls.push('signOut')
    }),
    getRedirectResult: vi.fn(async () => null),
    signInWithPopup: vi.fn(async () => ({})),
    credential: vi.fn((idToken: string) => ({ providerId: 'google.com', idToken })),
    nativeGoogleIdToken: vi.fn(async () => 'id-token-from-device'),
    nativeSignOut: vi.fn(async () => {
      calls.push('nativeSignOut')
    }),
  }
})

vi.mock('../platform/platform', () => ({
  isNative: () => h.platform.native,
  nativePlatform: () => (h.platform.native ? 'ios' : null),
}))
vi.mock('../platform/nativeAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../platform/nativeAuth')>()
  return { ...real, nativeGoogleIdToken: h.nativeGoogleIdToken, nativeSignOut: h.nativeSignOut }
})
vi.mock('firebase/app', () => ({ initializeApp: h.initializeApp }))
vi.mock('firebase/firestore', () => ({
  connectFirestoreEmulator: vi.fn(),
  initializeFirestore: vi.fn(() => ({ name: 'firestore' })),
  memoryLocalCache: vi.fn(() => ({})),
}))
vi.mock('firebase/auth', () => {
  class GoogleAuthProvider {
    static credential = h.credential
    setCustomParameters() {}
  }
  return {
    GoogleAuthProvider,
    browserLocalPersistence: 'browserLocal',
    indexedDBLocalPersistence: 'indexedDB',
    browserPopupRedirectResolver: 'resolver',
    connectAuthEmulator: vi.fn(),
    getRedirectResult: h.getRedirectResult,
    initializeAuth: h.initializeAuth,
    onAuthStateChanged: vi.fn(),
    signInWithCredential: h.signInWithCredential,
    signInWithPopup: h.signInWithPopup,
    signInWithRedirect: vi.fn(),
    signOut: h.signOut,
  }
})

const load = async () => {
  vi.resetModules()
  return import('./firebase')
}

beforeEach(() => {
  vi.clearAllMocks()
  h.calls.length = 0
  h.platform.native = true
})

describe('アプリの Firebase', () => {
  it('ポップアップ・リダイレクトの仕組みを入れずに初期化し、ログインの画面のドメインは変えない', async () => {
    const fb = await load()
    fb.firebase()
    const deps = h.initializeAuth.mock.calls[0][1] as Record<string, unknown>
    expect(deps).toEqual({ persistence: ['indexedDB', 'browserLocal'] })
    expect(deps).not.toHaveProperty('popupRedirectResolver')
    expect(h.initializeApp.mock.calls[0][0].authDomain).toBe('novel-studio-3352e.firebaseapp.com')
  })

  it('端末で受け取った ID トークンで signInWithCredential する（ポップアップは開かない）', async () => {
    const fb = await load()
    await fb.signInWithGoogle()
    expect(h.nativeGoogleIdToken).toHaveBeenCalledTimes(1)
    expect(h.credential).toHaveBeenCalledWith('id-token-from-device')
    expect(h.signInWithCredential).toHaveBeenCalledWith(h.auth, { providerId: 'google.com', idToken: 'id-token-from-device' })
    expect(h.signInWithPopup).not.toHaveBeenCalled()
  })

  it('リダイレクトの結果は受け取りに行かない', async () => {
    const fb = await load()
    await fb.completeRedirect()
    expect(h.getRedirectResult).not.toHaveBeenCalled()
  })

  it('ログアウトは Firebase → 端末のアカウント選択の順', async () => {
    const fb = await load()
    await fb.signOutUser()
    expect(h.calls).toEqual(['signOut', 'nativeSignOut'])
  })

  it('アカウント選択の失敗はアプリ用の言葉、閉じただけなら知らせない', async () => {
    const fb = await load()
    expect(fb.describeAuthError(new Error('The user canceled the sign-in flow.'))).toBeNull()
    expect(fb.describeAuthError(new Error('[28444] Developer console is not set up correctly.'))).toContain('SHA-1')
    // Firebase の失敗はこれまでどおり
    expect(fb.describeAuthError({ code: 'auth/network-request-failed' })).toBe(
      'インターネットにつながっていないため、ログインできませんでした。',
    )
  })
})

describe('ブラウザの Firebase（これまでどおり）', () => {
  beforeEach(() => {
    h.platform.native = false
  })

  it('ポップアップ・リダイレクトの仕組みを入れて初期化する', async () => {
    const fb = await load()
    fb.firebase()
    expect(h.initializeAuth.mock.calls[0][1]).toEqual({
      persistence: ['indexedDB', 'browserLocal'],
      popupRedirectResolver: 'resolver',
    })
  })

  it('ポップアップでログインし、リダイレクトの結果も受け取る。端末のログアウトはしない', async () => {
    const fb = await load()
    await fb.signInWithGoogle()
    expect(h.signInWithPopup).toHaveBeenCalledTimes(1)
    expect(h.nativeGoogleIdToken).not.toHaveBeenCalled()
    await fb.completeRedirect()
    expect(h.getRedirectResult).toHaveBeenCalledTimes(1)
    await fb.signOutUser()
    expect(h.calls).toEqual(['signOut'])
  })

  it('アプリの失敗の言葉は使わない', async () => {
    const fb = await load()
    expect(fb.describeAuthError(new Error('cancelled'))).toBe('ログインできませんでした（cancelled）')
  })
})
