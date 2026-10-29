// アプリの Google ログイン（プラグインは偽物）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('@capacitor-firebase/authentication', () => ({
  FirebaseAuthentication: { signInWithGoogle: h.signInWithGoogle, signOut: h.signOut },
}))

import { describeNativeAuthError, nativeGoogleIdToken, nativeSignOut, SIGN_IN_TIMEOUT_MS, withTimeout } from './nativeAuth'

beforeEach(() => {
  h.signInWithGoogle.mockReset()
  h.signOut.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('nativeGoogleIdToken', () => {
  it('端末側ではログインせず（skipNativeAuth）、ID トークンを返す', async () => {
    h.signInWithGoogle.mockResolvedValue({ user: null, credential: { providerId: 'google.com', idToken: 'tok' } })
    await expect(nativeGoogleIdToken()).resolves.toBe('tok')
    expect(h.signInWithGoogle).toHaveBeenCalledWith({ skipNativeAuth: true })
  })

  it('ID トークンが無ければ auth/missing-id-token', async () => {
    h.signInWithGoogle.mockResolvedValue({ user: null, credential: { providerId: 'google.com' } })
    await expect(nativeGoogleIdToken()).rejects.toMatchObject({ code: 'auth/missing-id-token' })
  })

  it('アカウント選択が応答しなければ時間切れにする', async () => {
    vi.useFakeTimers()
    h.signInWithGoogle.mockReturnValue(new Promise(() => {}))
    const p = nativeGoogleIdToken()
    const result = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS + 1)
    const e = await result
    expect(e).toMatchObject({ code: 'native-timeout' })
    expect(describeNativeAuthError(e)).toContain('応答しませんでした')
  })
})

describe('nativeSignOut', () => {
  it('端末のアカウント選択の状態を消す。失敗しても投げない', async () => {
    h.signOut.mockResolvedValue(undefined)
    await nativeSignOut()
    expect(h.signOut).toHaveBeenCalledTimes(1)
    h.signOut.mockRejectedValue(new Error('boom'))
    await expect(nativeSignOut()).resolves.toBeUndefined()
  })

  it('応答しなくても5秒で終える', async () => {
    vi.useFakeTimers()
    h.signOut.mockReturnValue(new Promise(() => {}))
    let done = false
    void nativeSignOut().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(done).toBe(true)
  })
})

describe('withTimeout', () => {
  it('間に合えばそのまま、失敗もそのまま', async () => {
    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toBe(1)
    await expect(withTimeout(Promise.reject(new Error('x')), 100)).rejects.toThrow('x')
  })
})

describe('describeNativeAuthError', () => {
  const cases: [string, unknown, string | null | undefined][] = [
    ['Android で閉じた', new Error('activity is cancelled by the user.'), null],
    ['iPhone で閉じた', new Error('The user canceled the sign-in flow.'), null],
    ['code が CANCELED', { code: 'CANCELED', message: 'x' }, null],
    ['SHA-1 が合わない', new Error('[28444] Developer console is not set up correctly.'), 'SHA-1'],
    ['アカウントが無い', new Error('No credentials available'), 'Google アカウントがありません'],
    [
      'アカウントが無い（例外の名前）',
      new Error('androidx.credentials.exceptions.NoCredentialException'),
      'Google アカウントがありません',
    ],
    ['時間切れ', { code: 'native-timeout' }, '応答しませんでした'],
    ['Firebase の失敗', { code: 'auth/network-request-failed', message: 'cancel' }, undefined],
    ['知らない失敗', new Error('something else'), undefined],
  ]
  it.each(cases)('%s', (_name, error, expected) => {
    const r = describeNativeAuthError(error)
    if (typeof expected === 'string') expect(r).toContain(expected)
    else expect(r).toBe(expected)
  })
})
