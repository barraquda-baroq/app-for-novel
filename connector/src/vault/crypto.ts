// 暗号の道具（WebCrypto。Workers と Node の両方にある）。
// - 匿名のアカウントの更新用トークンだけを AES-GCM で暗号化する（鍵は秘密 TOKEN_ENC_KEY の SHA-256）。
//   Durable Object の保存領域はもともと暗号化されているので、取り込んだ記録（原稿）は暗号化しない（DECISIONS 1）
// - 連携の確かめの指紋 sha256hex(s + '.' + k)・k の形は、アプリの連携の画面と同じ src/claude/pairing.ts を使う
import { base64url } from '../../../src/claude/pairing'

export { base64url, isPairingKey, pairingHash, sha256hex } from '../../../src/claude/pairing'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export class KeyMissingError extends Error {
  constructor() {
    super('TOKEN_ENC_KEY が設定されていません')
    this.name = 'KeyMissingError'
  }
}

export class DecryptError extends Error {
  constructor() {
    super('暗号化した値を戻せません（鍵が変わった可能性）')
    this.name = 'DecryptError'
  }
}

async function aesKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new KeyMissingError()
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** 暗号化する（v1.<iv>.<暗号文>） */
export async function seal(secret: string | undefined, plain: string, aad = 'identity'): Promise<string> {
  const key = await aesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plain)),
  )
  return `v1.${base64url(iv)}.${base64url(ct)}`
}

export async function unseal(secret: string | undefined, sealed: string, aad = 'identity'): Promise<string> {
  const key = await aesKey(secret)
  const [v, iv, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !ct) throw new DecryptError()
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(iv), additionalData: enc.encode(aad) },
      key,
      fromBase64url(ct),
    )
    return dec.decode(plain)
  } catch {
    throw new DecryptError()
  }
}
