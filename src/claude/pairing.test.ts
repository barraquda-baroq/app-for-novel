// 連携の決まり（アプリとコネクタが同じこのファイルを使う）。値は src/test/pairingFixture.ts（コネクタのテストと同じ）
import { describe, expect, it } from 'vitest'
import emuRules from '../../firestore.emu.rules?raw'
import prodRules from '../../firestore.rules?raw'
import { PAIRING_FIXTURE as F } from '../test/pairingFixture'
import {
  callbackUrl,
  CONNECTION_ID,
  connectionNameKey,
  connectionsOf,
  connectPageUrl,
  CONNECTION_KEYS,
  CONNECTION_NAME_MAX,
  CONNECTOR_DOC_KEYS,
  CONNECTOR_DOC_VERSION,
  defaultConnectionName,
  identityUrl,
  isPairingHash,
  isPairingKey,
  LEGACY_CONNECTION_ID,
  LEGACY_CONNECTION_NAME,
  MAX_CONNECTIONS,
  newConnectionId,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  randomPairingKey,
  stateFromConnectUrl,
  validState,
} from './pairing'
import { refKey } from './refs'

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

  it('config/connector のキーはアクセスルール（validConnector）と同じ', () => {
    for (const [file, rules] of [
      ['firestore.rules', prodRules],
      ['firestore.emu.rules', emuRules],
    ]) {
      const m = /function validConnector\(\)[\s\S]*?hasOnly\(\[([^\]]*)\]\)/.exec(rules)
      expect(m, file).not.toBeNull()
      const keys = m![1].split(',').map((k) => k.trim().replace(/'/g, ''))
      expect(new Set(keys)).toEqual(new Set(CONNECTOR_DOC_KEYS))
    }
  })

  it('2.9: 記録の版・接続ごとのキー・接続の id の形・数の上限もアクセスルールと同じ', () => {
    for (const [file, rules] of [
      ['firestore.rules', prodRules],
      ['firestore.emu.rules', emuRules],
    ]) {
      const body = /function validConnector\(\)[\s\S]*?\n {4}\}/.exec(rules)![0]
      expect(body, file).toContain(`d.v == ${CONNECTOR_DOC_VERSION}`)
      expect(body, file).toContain(`d.pairingCid.matches('${CONNECTION_ID.source}')`)
      expect(body, file).toContain(`d.connections.size() <= ${MAX_CONNECTIONS}`)
      const one = /function validConnection\(c\)[\s\S]*?hasOnly\(\[([^\]]*)\]\)[\s\S]*?\n {4}\}/.exec(rules)
      expect(one, file).not.toBeNull()
      expect(new Set(one![1].split(',').map((k) => k.trim().replace(/'/g, '')))).toEqual(new Set(CONNECTION_KEYS))
      // アプリの名前の上限（20）はルールの上限（40）の中
      const max = Number(/c\.name\.size\(\) <= (\d+)/.exec(one![0])![1])
      expect(CONNECTION_NAME_MAX).toBeLessThanOrEqual(max)
    }
  })
})

describe('複数の接続（2.9）', () => {
  it('接続の id は c と base36 の 12 字（c0 にならない・ルールの形に合う）', () => {
    expect(MAX_CONNECTIONS).toBe(10)
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const cid = newConnectionId()
      expect(cid).toMatch(/^c[0-9a-z]{12}$/)
      expect(CONNECTION_ID.test(cid)).toBe(true)
      expect(cid).not.toBe(LEGACY_CONNECTION_ID)
      seen.add(cid)
    }
    expect(seen.size).toBe(50)
    expect(newConnectionId((n) => new Uint8Array(n).fill(0))).toBe('c000000000000')
    expect(newConnectionId((n) => new Uint8Array(n).fill(35))).toBe('czzzzzzzzzzzz')
    expect(newConnectionId(() => new Uint8Array(2).fill(1))).toBe('c110000000000')
    expect(CONNECTION_ID.test(LEGACY_CONNECTION_ID)).toBe(true)
    for (const bad of ['c', 'C1', 'x1', 'c-1', `c${'a'.repeat(32)}`]) expect(CONNECTION_ID.test(bad), bad).toBe(false)
  })

  it('既定の名前は、空いている一番小さい番号の「接続n」（全角の数字・字の幅も同じに見る）', () => {
    expect(defaultConnectionName([])).toBe('接続1')
    expect(defaultConnectionName([LEGACY_CONNECTION_NAME])).toBe('接続2')
    expect(defaultConnectionName(['接続1', '接続3'])).toBe('接続2')
    expect(defaultConnectionName(['接続１', '接続２', '仕事用'])).toBe('接続3')
    expect(defaultConnectionName([' 接続1 ', '接続 2', '接続x'])).toBe('接続2')
  })

  it('名前の重なりの形は refKey と同じ（字の幅・空白の違いは同じ）', () => {
    for (const name of ['接続1', '接続１', '　仕事用　', '仕事  用', 'ｃｌａｕｄｅ', '新作の　相談'])
      expect(connectionNameKey(name), name).toBe(refKey(name))
    expect(connectionNameKey('接続１')).toBe(connectionNameKey('接続1'))
  })

  it('v1 の記録（connections が無い）は c0「接続1」1つ', () => {
    expect(connectionsOf({ v: 1, pairing: 'h1', pairedAt: 123, approvedOn: 'Mac' })).toEqual([
      { cid: 'c0', name: '接続1', pairing: 'h1', pairedAt: 123, approvedOn: 'Mac' },
    ])
    // 時刻の変換を渡せる（Firestore の Timestamp など）
    expect(connectionsOf({ pairing: 'h1', pairedAt: { ms: 9 } }, (v) => (v as { ms: number }).ms)).toEqual([
      { cid: 'c0', name: '接続1', pairing: 'h1', pairedAt: 9, approvedOn: '' },
    ])
    expect(connectionsOf({})).toEqual([{ cid: 'c0', name: '接続1', pairing: '', pairedAt: null, approvedOn: '' }])
  })

  it('v2 は鍵が接続の id の形・値が map のものだけ。名前が壊れていれば「接続」、制御文字を除き 40 字まで。時刻の順', () => {
    const list = connectionsOf({
      v: 2,
      pairing: 'h2',
      connections: {
        cbbb: { name: '仕事用', pairing: 'h2', pairedAt: 200, approvedOn: 'iPhone' },
        c0: { name: '接続1', pairing: 'h0', pairedAt: 100, approvedOn: 'Mac' },
        caaa: { name: 42, pairing: 7, pairedAt: 'x' },
        cccc: { name: '\u0007改\n行\u0000', pairing: 'h3', pairedAt: 200, approvedOn: 'Pixel' },
        cddd: { name: 'あ'.repeat(50), pairing: 'h4', pairedAt: 300, approvedOn: 'x'.repeat(200) },
        'not-a-cid': { name: 'x', pairing: 'h5', pairedAt: 1 },
        cnull: null,
        clist: ['x'],
        cstr: 'x',
        C9: { name: 'x', pairing: 'h6', pairedAt: 1 },
      },
    })
    expect(list).toEqual([
      { cid: 'caaa', name: '接続', pairing: '', pairedAt: null, approvedOn: '' },
      { cid: 'c0', name: '接続1', pairing: 'h0', pairedAt: 100, approvedOn: 'Mac' },
      { cid: 'cbbb', name: '仕事用', pairing: 'h2', pairedAt: 200, approvedOn: 'iPhone' },
      { cid: 'cccc', name: '改行', pairing: 'h3', pairedAt: 200, approvedOn: 'Pixel' },
      { cid: 'cddd', name: 'あ'.repeat(40), pairing: 'h4', pairedAt: 300, approvedOn: 'x'.repeat(100) },
    ])
    // 空白だけ・制御文字だけの名前も「接続」
    expect(connectionsOf({ connections: { c1: { name: ' \u0001 ', pairing: 'h' } } })![0].name).toBe('接続')
  })

  it('v2 で正しい接続が1つも無い（空の map・map でない）は null（解除と同じ）', () => {
    expect(connectionsOf({ v: 2, connections: {} })).toBeNull()
    expect(connectionsOf({ v: 2, connections: { bad: { name: 'x' } } })).toBeNull()
    expect(connectionsOf({ v: 2, connections: null })).toBeNull()
    expect(connectionsOf({ v: 2, connections: [] })).toBeNull()
    expect(connectionsOf({ v: 2, connections: 'c1' })).toBeNull()
  })
})
