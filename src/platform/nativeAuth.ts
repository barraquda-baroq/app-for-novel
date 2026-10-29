// アプリ（iPhone / Android）の Google ログイン。端末のアカウント選択（Android は Credential Manager、iPhone は Google Sign-In）で
// ID トークンだけを受け取り、ログインそのものは Web と同じ Firebase JS SDK で行う（src/sync/firebase.ts の signInWithCredential）。
// 同期・アクセスルール・持ち主の確認は Web と同じものがそのまま働く。プラグインはアプリでログインする時だけ読み込む。

/** 時間内に終わらなければ code = timeoutCode のエラーで失敗させる */
export function withTimeout<T>(p: Promise<T>, ms: number, timeoutCode = 'native-timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: timeoutCode })), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** アカウント選択の画面を待つ長さ（端末にアカウントを足しに行く時間も見込む） */
export const SIGN_IN_TIMEOUT_MS = 120_000
/** ログアウトを待つ長さ（端末側の状態を消せなくても、アプリのログアウトは済んでいる） */
const SIGN_OUT_TIMEOUT_MS = 5_000

const plugin = async () => (await import('@capacitor-firebase/authentication')).FirebaseAuthentication

/** 端末の Google のアカウント選択を開き、選んだアカウントの ID トークンを返す */
export async function nativeGoogleIdToken(): Promise<string> {
  const auth = await plugin()
  const r = await withTimeout(auth.signInWithGoogle({ skipNativeAuth: true }), SIGN_IN_TIMEOUT_MS)
  const token = r.credential?.idToken
  if (!token) throw Object.assign(new Error('no idToken'), { code: 'auth/missing-id-token' })
  return token
}

/** 端末のアカウント選択の状態も消す（次のログインで別のアカウントを選べるように） */
export async function nativeSignOut(): Promise<void> {
  try {
    const auth = await plugin()
    await withTimeout(auth.signOut(), SIGN_OUT_TIMEOUT_MS)
  } catch {
    /* 消せなくても、アプリのログアウトは済んでいる */
  }
}

const errorCode = (e: unknown): string =>
  typeof e === 'object' && e && 'code' in e && (e as { code: unknown }).code != null ? String((e as { code: unknown }).code) : ''
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '')

/**
 * アプリのアカウント選択の失敗を利用者向けの言葉にする。
 * null = 閉じただけ（知らせない）、undefined = アプリの失敗ではない（Firebase の失敗として扱う）
 */
export function describeNativeAuthError(e: unknown): string | null | undefined {
  const code = errorCode(e)
  const message = errorMessage(e)
  if (code === 'native-timeout')
    return 'ログインの画面が応答しませんでした。アプリを開き直して、もう一度ログインしてください（iPhone で続く時は docs/MOBILE.md「ログインの設定」）。'
  // Firebase の失敗（auth/…）は、これまでどおりの言葉にする
  if (code.startsWith('auth/')) return undefined
  // 閉じた・やめた（Android は cancelled、iPhone は canceled）
  if (/cancel/i.test(message) || /cancel/i.test(code)) return null
  if (/28444|developer console/i.test(message))
    return 'Firebase に登録した署名（SHA-1）とアプリの署名が合っていません（docs/MOBILE.md「Android の署名」）。'
  if (/No credentials|NoCredential/i.test(message))
    return 'この端末に Google アカウントがありません。端末の「設定」→「アカウント」で追加してから、もう一度ログインしてください。'
  return undefined
}
