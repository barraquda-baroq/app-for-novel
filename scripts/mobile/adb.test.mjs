// @vitest-environment node
// npm run android:install のスマホの待ち方（scripts/mobile.mjs の waitForDevice）。adb は偽物（Mac・Linux のシェルのスクリプト）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForDevice } from '../mobile.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HEAD = 'List of devices attached'
const UNAUTHORIZED = 'R58M12345              unauthorized usb:1-1 transport_id:1'
const DEVICE = 'R58M12345              device usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:1'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fake-adb-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 呼ばれるたびに outputs を順に出す偽物の adb（最後のものを出し続ける） */
function fakeAdb(outputs) {
  outputs.forEach((o, i) => fs.writeFileSync(path.join(dir, `out${i}.txt`), `${HEAD}\n${o}\n\n`))
  const adb = path.join(dir, 'adb')
  fs.writeFileSync(
    adb,
    [
      '#!/bin/sh',
      `cd "${dir}"`,
      'n=$(cat count 2>/dev/null || echo 0)',
      'echo $((n + 1)) > count',
      `last=${outputs.length - 1}`,
      'if [ "$n" -gt "$last" ]; then n=$last; fi',
      'cat "out$n.txt"',
    ].join('\n'),
  )
  fs.chmodSync(adb, 0o755)
  return adb
}
const calls = () => Number(fs.readFileSync(path.join(dir, 'count'), 'utf8'))

describe.runIf(process.platform !== 'win32')('waitForDevice（android:install のビルドの前）', () => {
  it('スマホで許可されるまで待つ。許可のお願いは一度だけ出す', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adb = fakeAdb([UNAUTHORIZED, UNAUTHORIZED, UNAUTHORIZED, DEVICE])
    await expect(waitForDevice(adb, process.env, undefined, { intervalMs: 1 })).resolves.toBe(true)
    expect(calls()).toBe(4)
    const asked = log.mock.calls.filter(([m]) => String(m).includes('USB デバッグを許可しますか？'))
    expect(asked).toHaveLength(1)
  })

  it('つながっていれば待たない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adb = fakeAdb([DEVICE])
    await expect(waitForDevice(adb, process.env, undefined, { intervalMs: 1 })).resolves.toBe(true)
    expect(calls()).toBe(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('待っても見つからなければ false（理由は chooseDevice が説明する）。つなぐようにお願いする', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adb = fakeAdb([''])
    await expect(waitForDevice(adb, process.env, undefined, { tries: 3, intervalMs: 1 })).resolves.toBe(false)
    expect(calls()).toBe(3)
    expect(log.mock.calls.some(([m]) => String(m).includes('USB ケーブルでつないで'))).toBe(true)
  })

  it('--serial の時は、そのスマホを待つ', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const adb = fakeAdb([DEVICE])
    await expect(waitForDevice(adb, process.env, 'OTHER', { tries: 2, intervalMs: 1 })).resolves.toBe(false)
    await expect(waitForDevice(adb, process.env, 'R58M12345', { tries: 2, intervalMs: 1 })).resolves.toBe(true)
  })
})

describe('android:install の順番', () => {
  const src = fs.readFileSync(path.join(repoDir, 'scripts', 'mobile.mjs'), 'utf8')
  const fn = (name) => {
    const start = src.indexOf(`async function ${name}(`)
    return src.slice(start, src.indexOf('\n}\n', start))
  }

  it('長いビルドの前にスマホを待って確かめ、ビルドの後は同じスマホに入れる', () => {
    const body = fn('androidInstall')
    const wait = body.indexOf('await waitForDevice(adb, env, opts.serial)')
    const check = body.indexOf('await chooseDevice(adb, env, opts.serial)')
    const build = body.indexOf("await buildAndSync('android')")
    expect(wait).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(wait)
    expect(build).toBeGreaterThan(check)
    expect(body.indexOf('await chooseDevice(adb, env, first.serial)')).toBeGreaterThan(build)
  })

  it('android:open はスマホが無くても開ける', () => {
    expect(fn('androidOpen')).not.toContain('waitForDevice')
    expect(fn('androidPreflight')).not.toContain('waitForDevice')
  })
})
