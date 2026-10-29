// @vitest-environment node
// npm run mobile:firebase の firebase-tools の呼び方（scripts/mobile.mjs の firebase）。firebase-tools は偽物で、
// 本物（15.34）と同じく、失敗の理由を --json では「Failed to list …」の一言に包み、詳しい理由は FIREBASE_DEBUG_PATH の記録にだけ書く
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { firebase } from '../mobile.mjs'

const WRAPPED = 'Failed to list Firebase ANDROID apps. See firebase-debug.log for more info.'
// 本物の記録（ログインが切れた時。refresh token が使えない）
const LOG_401 =
  '[debug] [2026-10-29T10:41:57.296Z] Request to https://firebase.googleapis.com/v1beta1/projects/novel-studio-3352e/androidApps?pageSize=100 had HTTP Error: 401, Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.\n'
const LOG_403 =
  '[debug] [2026-10-29T10:41:57.296Z] Request to https://firebase.googleapis.com/v1beta1/projects/novel-studio-3352e/androidApps?pageSize=100 had HTTP Error: 403, The caller does not have permission\n'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fake-firebase-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 偽物の firebase-tools。記録の場所（FIREBASE_DEBUG_PATH）を seen に控え、log を書いて失敗する */
function fakeCli({ log, stdout = { status: 'error', error: WRAPPED }, code = 2 }) {
  const cli = path.join(dir, 'firebase.mjs')
  fs.writeFileSync(
    cli,
    [
      "import fs from 'node:fs'",
      'const p = process.env.FIREBASE_DEBUG_PATH',
      `fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.txt'))}, p ?? '')`,
      `if (p && ${JSON.stringify(log ?? null)} !== null) fs.writeFileSync(p, ${JSON.stringify(log ?? '')})`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(stdout))})`,
      `process.exit(${code})`,
    ].join('\n'),
  )
  return cli
}
const seenLog = () => fs.readFileSync(path.join(dir, 'seen.txt'), 'utf8')

describe('firebase（mobile:firebase）', () => {
  it('ログインが切れている（記録に 401）: login --reauth を勧める。記録はその回だけの場所に書かせて、後で消す', async () => {
    const cli = fakeCli({ log: LOG_401 })
    await expect(firebase(['apps:list', 'ANDROID'], cli)).rejects.toThrow(/ログインが切れています.*npx firebase login --reauth/)
    const p = seenLog()
    expect(p).toMatch(/ns-fb-/)
    expect(path.resolve(p)).not.toBe(path.resolve('firebase-debug.log'))
    expect(fs.existsSync(path.dirname(p))).toBe(false)
  })

  it('別のアカウント（記録に 403）: 入り直し方（logout → login、または login:add → login:use）を出す', async () => {
    const cli = fakeCli({ log: LOG_403 })
    const e = await firebase(['apps:list', 'ANDROID'], cli).catch((x) => x)
    expect(e.message).toContain('npx firebase logout → npx firebase login')
    expect(e.message).toContain('npx firebase login:use')
  })

  it('一度もログインしていない（記録なし）: 出力だけで見分ける', async () => {
    const cli = fakeCli({ stdout: { status: 'error', error: 'Failed to authenticate, have you run firebase login?' }, code: 1 })
    await expect(firebase(['apps:list', 'ANDROID'], cli)).rejects.toThrow(/--reauth/)
  })

  it('知らない失敗: 理由と、残した記録の場所を出す', async () => {
    const cli = fakeCli({ log: '[debug] FetchError: request failed, reason: ECONNRESET\n' })
    const e = await firebase(['apps:list', 'ANDROID'], cli).catch((x) => x)
    expect(e.message).toContain('firebase apps:list に失敗しました: Failed to list Firebase ANDROID apps.')
    const p = seenLog()
    expect(e.message).toContain(`詳しくは ${p}`)
    expect(fs.readFileSync(p, 'utf8')).toContain('ECONNRESET')
    fs.rmSync(path.dirname(p), { recursive: true, force: true })
  })

  it('うまくいけば result を返し、記録は残さない', async () => {
    const cli = fakeCli({ stdout: { status: 'success', result: [{ appId: '1:1:android:x' }] }, code: 0 })
    await expect(firebase(['apps:list', 'ANDROID'], cli)).resolves.toEqual([{ appId: '1:1:android:x' }])
    expect(fs.existsSync(path.dirname(seenLog()))).toBe(false)
  })
})
