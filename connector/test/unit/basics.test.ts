// 小さな部品: 値の変換・太平洋時間の日付・暗号・書き込みの形・Firestore の失敗の扱い。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeRecord } from '../../../src/sync/codec'
import { FirestoreError, FirestoreRest } from '../../src/vault/firestore'
import { DecryptError, isPairingKey, pairingHash, seal, unseal } from '../../src/vault/crypto'
import { nextPacificMidnight, pacificDay, resetLabel } from '../../src/vault/quota'
import { fromFields, fromValue, timestampMicros, toValue } from '../../src/vault/values'
import { EncodeError, prepareWrite, rowsOfCommit } from '../../src/vault/writer'
import { safeError, safeUrl, safeValue } from '../../src/log'

describe('Firestore の値', () => {
  it('文字列・整数（10進の文字列）・真偽・null・時刻・入れ子', () => {
    const v = toValue({ a: 'x', n: 12, b: true, z: null, list: [1, 'y'], t: { timestamp: '2026-10-29T00:00:00.123456Z' } })
    expect(v).toEqual({
      mapValue: {
        fields: {
          a: { stringValue: 'x' },
          n: { integerValue: '12' },
          b: { booleanValue: true },
          z: { nullValue: null },
          list: { arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'y' }] } },
          t: { timestampValue: '2026-10-29T00:00:00.123456Z' },
        },
      },
    })
    expect(fromValue(v)).toEqual({ a: 'x', n: 12, b: true, z: null, list: [1, 'y'], t: { timestamp: '2026-10-29T00:00:00.123456Z' } })
    expect(fromFields({ chunks: { integerValue: '3' } })).toEqual({ chunks: 3 })
  })

  it('時刻をマイクロ秒にする（ミリ秒・マイクロ秒・ナノ秒の文字列）', () => {
    const base = Date.UTC(2026, 9, 29) * 1000
    expect(timestampMicros('2026-10-29T00:00:00Z')).toBe(base)
    expect(timestampMicros('2026-10-29T00:00:00.5Z')).toBe(base + 500_000)
    expect(timestampMicros('2026-10-29T00:00:00.123456Z')).toBe(base + 123_456)
    expect(timestampMicros('2026-10-29T00:00:00.123456789Z')).toBe(base + 123_456)
    expect(Number.isNaN(timestampMicros('yesterday'))).toBe(true)
  })
})

describe('太平洋時間の日付（Firestore の無料枠の切り替わり）', () => {
  it('夏時間の間は日本時間16時、2026-11-01 の切り替え後は17時', () => {
    // 2026-10-31 12:00 JST = 太平洋時間 10/30 20:00（夏時間）
    const a = Date.UTC(2026, 9, 31, 3, 0)
    expect(pacificDay(a)).toBe('2026-10-30')
    expect(new Date(nextPacificMidnight(a)).toISOString()).toBe('2026-10-31T07:00:00.000Z')
    expect(resetLabel(a)).toBe('日本時間16時')
    // 2026-10-31 23:00 JST = 太平洋時間 10/31 7:00 → 次は 11/1 0:00（まだ夏時間）= 11/1 16:00 JST
    const b = Date.UTC(2026, 9, 31, 14, 0)
    expect(new Date(nextPacificMidnight(b)).toISOString()).toBe('2026-11-01T07:00:00.000Z')
    expect(resetLabel(b)).toBe('明日の日本時間16時')
    // 2026-11-01 17:00 JST = 太平洋時間 11/1 1:00（まだ夏時間）→ 次は 11/2 0:00（冬時間）= 11/2 17:00 JST
    const c = Date.UTC(2026, 10, 1, 8, 0)
    expect(pacificDay(c)).toBe('2026-11-01')
    expect(new Date(nextPacificMidnight(c)).toISOString()).toBe('2026-11-02T08:00:00.000Z')
    expect(resetLabel(c)).toBe('明日の日本時間17時')
    // 11/1 の 16:00 JST ちょうどに日付が変わる
    expect(pacificDay(Date.UTC(2026, 10, 1, 6, 59))).toBe('2026-10-31')
    expect(pacificDay(Date.UTC(2026, 10, 1, 7, 0))).toBe('2026-11-01')
  })
})

describe('暗号', () => {
  it('暗号化して戻せる。鍵が違えば戻せない', async () => {
    const key = 'k'.repeat(40)
    const sealed = await seal(key, 'refresh-token-value')
    expect(sealed).not.toContain('refresh')
    expect(await unseal(key, sealed)).toBe('refresh-token-value')
    await expect(unseal('x'.repeat(40), sealed)).rejects.toBeInstanceOf(DecryptError)
  })

  it('連携の確かめの指紋は sha256hex(s + "." + k)（アプリと同じ）', async () => {
    const s = 'state-abc'
    const k = 'A'.repeat(43)
    expect(await pairingHash(s, k)).toBe(createHash('sha256').update(`${s}.${k}`).digest('hex'))
    expect(isPairingKey(k)).toBe(true)
    expect(isPairingKey('short')).toBe(false)
    expect(isPairingKey(`${k}=`)).toBe(false)
  })
})

describe('書き込みの形（作るだけ）', () => {
  const fs = new FirestoreRest({ fetch: fetch, baseUrl: 'http://x/v1', projectId: 'p', token: async () => 't' })
  const rec = { id: 'ci-1', v: 1, source: 'claude', titleId: 't1', createdAt: 1, updatedAt: 1, heading: '見出し', body: '本文', checked: false, checkedAt: null, pieceIds: [], order: 0 }

  it('決まった項目だけ・updated はサーバー時刻・無い時だけ作る・device は claude-connector', () => {
    const p = prepareWrite(fs, 'owner', { table: 'revisionIdeas', record: rec as never })
    expect(p.write.update!.name).toBe('projects/p/databases/(default)/documents/users/owner/records/revisionIdeas:ci-1')
    expect(Object.keys(p.write.update!.fields).sort()).toEqual(['chunks', 'deleted', 'device', 'hash', 'id', 'json', 'table'])
    expect(p.write.update!.fields.chunks).toEqual({ integerValue: '0' })
    expect(p.write.update!.fields.deleted).toEqual({ booleanValue: false })
    expect(p.write.update!.fields.device).toEqual({ stringValue: 'claude-connector' })
    expect(p.write.updateTransforms).toEqual([{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }])
    expect(p.write.currentDocument).toEqual({ exists: false })
    expect(JSON.stringify(p.write)).not.toContain('reset')
    // 端末の decodeRecord で読める（指紋・id が合う）
    const back = decodeRecord(
      { table: 'revisionIdeas', id: 'ci-1', json: p.json, chunks: 0, deleted: false, hash: p.hash, updated: null, device: 'claude-connector' },
      () => undefined,
    )
    expect(back).toEqual(rec)
    const rows = rowsOfCommit([p], { writeResults: [{ updateTime: '2026-10-29T00:00:00.000001Z', transformResults: [{ timestampValue: '2026-10-29T00:00:00.000001Z' } as never] }], commitTime: '' })
    expect(rows[0]).toMatchObject({ name: 'revisionIdeas:ci-1', device: 'claude-connector', deleted: false, chunks: 0 })
  })

  it('20万字を超える記録・原稿の表・長すぎる id は作らない', () => {
    expect(() => prepareWrite(fs, 'o', { table: 'revisionIdeas', record: { ...rec, body: 'あ'.repeat(200_001) } as never })).toThrow(EncodeError)
    expect(() => prepareWrite(fs, 'o', { table: 'versions' as never, record: rec as never })).toThrow(EncodeError)
    expect(() => prepareWrite(fs, 'o', { table: 'revisionIdeas', record: { ...rec, id: 'x'.repeat(65) } as never })).toThrow(EncodeError)
  })
})

describe('Firestore の失敗の扱い', () => {
  function client(responses: (() => Response)[], tokens: boolean[] = []) {
    let i = 0
    const f = (async () => responses[Math.min(i++, responses.length - 1)]()) as unknown as typeof fetch
    return {
      fs: new FirestoreRest({
        fetch: f,
        baseUrl: 'http://x/v1',
        projectId: 'p',
        token: async (force) => {
          tokens.push(Boolean(force))
          return 'tok'
        },
        sleep: async () => undefined,
      }),
      count: () => i,
    }
  }
  const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status })

  it('5xx は2回まで試し直す', async () => {
    const c = client([json({}, 503), json({}, 500), json({ writeResults: [], commitTime: 't' })])
    await expect(c.fs.commit([])).resolves.toMatchObject({ commitTime: 't' })
    expect(c.count()).toBe(3)
    const d = client([json({}, 503), json({}, 503), json({}, 503)])
    await expect(d.fs.commit([])).rejects.toMatchObject({ status: 503 })
  })

  it('401 は ID トークンを更新して1回だけ試し直す', async () => {
    const tokens: boolean[] = []
    const c = client([json({ error: { status: 'UNAUTHENTICATED' } }, 401), json([])], tokens)
    await expect(c.fs.runQuery('users/u', {})).resolves.toEqual([])
    expect(tokens).toEqual([false, true, false])
  })

  it('403・409・429 は状態と印を付けて返す', async () => {
    for (const [status, code] of [
      [403, 'PERMISSION_DENIED'],
      [409, 'ALREADY_EXISTS'],
      [429, 'RESOURCE_EXHAUSTED'],
      [400, 'FAILED_PRECONDITION'],
    ] as const) {
      const c = client([json({ error: { code: status, status: code, message: 'm' } }, status)])
      const e = await c.fs.commit([]).catch((x) => x)
      expect(e).toBeInstanceOf(FirestoreError)
      expect([e.status, e.code]).toEqual([status, code])
    }
  })
})

describe('ログの値', () => {
  it('長い文字列・URL の問い合わせ部分・トークンらしい英数字は出さない', () => {
    expect(safeValue('あ'.repeat(201))).toBe('[201字の文字列は出しません]')
    expect(safeValue({ a: 1 })).toBe('[object]')
    expect(safeUrl('https://x.workers.dev/pair/callback?state=s&k=secret')).toBe('x.workers.dev/pair/callback')
    expect(safeError(new Error(`token ${'a'.repeat(50)}`))).toBe('Error: token […]')
  })
})
