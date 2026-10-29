// 連携の決まり（アプリとコネクタが同じこのファイルを使う）。値は src/test/pairingFixture.ts（コネクタのテストと同じ）
import { describe, expect, it } from 'vitest'
import { PAIRING_FIXTURE as F } from '../test/pairingFixture'
import {
  callbackUrl,
  connectPageUrl,
  CONNECTOR_DOC_KEYS,
  identityUrl,
  isPairingHash,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  randomPairingKey,
  stateFromConnectUrl,
  validState,
} from './pairing'

describe('連携の URL', () => {
  it('コネクタが開くアプリの画面・アプリが戻るコネクタの URL・身元の URL', () => {
    expect(connectPageUrl(F.appOrigin, F.state)).toBe(F.connectUrl)
    expect(callbackUrl(F.connectorOrigin, F.state, F.k)).toBe(F.callbackUrl)
    expect(identityUrl(F.connectorOrigin)).toBe(`${F.connectorOrigin}/connect/identity`)
  })

  it('印は URL を行き来しても同じ値（アプリの画面・コネクタの戻り先のどちらでも）', () => {
    for (const s of [F.state, F.oddState]) {
      const page = connectPageUrl(F.appOrigin, s)
      expect(stateFromConnectUrl(page)).toBe(s)
      // HashRouter が読む ?s= と同じ読み方
      const search = new URL(page).hash.split('?')[1]
      expect(new URLSearchParams(search).get('s')).toBe(s)
      const back = new URL(callbackUrl(F.connectorOrigin, s, F.k))
      expect(back.pathname).toBe('/pair/callback')
      expect(back.searchParams.get('state')).toBe(s)
      expect(back.searchParams.get('k')).toBe(F.k)
    }
  })

  it('違う形の画面の URL からは印を取り出さない', () => {
    expect(stateFromConnectUrl(`${F.appOrigin}/#/settings?s=${F.state}`)).toBeNull()
    expect(stateFromConnectUrl(`${F.appOrigin}/#/claude/connect`)).toBeNull()
    expect(stateFromConnectUrl(`${F.appOrigin}/#/claude/connect?s=a%20b`)).toBeNull()
    expect(stateFromConnectUrl('not a url')).toBeNull()
  })

  it('origin は https（開発中は localhost）だけ', () => {
    expect(normalizeOrigin(`${F.connectorOrigin}/`)).toBe(F.connectorOrigin)
    expect(normalizeOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeOrigin('http://example.com')).toBe('')
    expect(normalizeOrigin(`${F.connectorOrigin}/mcp`)).toBe('')
  })
})

describe('k と指紋', () => {
  it("指紋 = sha256hex(s + '.' + k)（Node の crypto で計算した値と同じ）", async () => {
    expect(await pairingHash(F.state, F.k)).toBe(F.hash)
    expect(await pairingHash(F.oddState, F.k)).toBe(F.oddHash)
    expect(isPairingHash(F.hash)).toBe(true)
    expect(isPairingHash(F.hash.toUpperCase())).toBe(false)
  })

  it('k は 32 バイトの base64url（43 字）。作った k はコネクタの確かめに通る', () => {
    expect(isPairingKey(F.k)).toBe(true)
    for (let i = 0; i < 20; i++) expect(isPairingKey(randomPairingKey())).toBe(true)
    expect(randomPairingKey((a) => a.fill(255))).toBe('_'.repeat(42) + '8')
    expect(isPairingKey(F.k.slice(1))).toBe(false)
    expect(isPairingKey(`${F.k.slice(1)}+`)).toBe(false)
  })

  it('印は空白・制御文字の無い 1〜2048 文字', () => {
    expect(validState(F.state)).toBe(F.state)
    expect(validState(F.oddState)).toBe(F.oddState)
    expect(validState('')).toBeNull()
    expect(validState('a'.repeat(2049))).toBeNull()
    expect(validState('a\nb')).toBeNull()
  })
})

describe('身元と記録の形', () => {
  it('/connect/identity の答え', () => {
    expect(parseIdentity(F.identity)).toEqual(F.identity)
    expect(parseIdentity({ ...F.identity, model: '3' })).toEqual({ ...F.identity, model: null })
    expect(parseIdentity({ uid: 'a/b' })).toBeNull()
    expect(parseIdentity([F.identity])).toBeNull()
  })

  it('config/connector のキーはアクセスルール（validConnector）と同じ', async () => {
    const fs = await import('node:fs')
    for (const file of ['firestore.rules', 'firestore.emu.rules']) {
      const rules = fs.readFileSync(file, 'utf8')
      const m = /function validConnector\(\)[\s\S]*?hasOnly\(\[([^\]]*)\]\)/.exec(rules)
      expect(m, file).not.toBeNull()
      const keys = m![1].split(',').map((k) => k.trim().replace(/'/g, ''))
      expect(new Set(keys)).toEqual(new Set(CONNECTOR_DOC_KEYS))
    }
  })
})
