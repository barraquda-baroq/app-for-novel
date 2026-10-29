// @vitest-environment node
// npm run mobile:doctor の iPhone の項目（scripts/mobile.mjs の doctor）と、Windows での mobile:firebase -- --ios
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { doctor, main } from '../mobile.mjs'
import * as lib from './lib.mjs'

// Git を入れた時に選ばれる Command Line Tools のままの Mac（本物の xcodebuild の言い方）
const CLT_ERROR =
  "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance"

let dir = ''
let lines = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-doctor-'))
  lines = []
  vi.spyOn(console, 'log').mockImplementation((m = '') => lines.push(String(m)))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exitCode = undefined
})

/** 偽物の xcodebuild（out を出して code で終わる） */
function fakeXcodebuild(out, code) {
  const p = path.join(dir, 'xcodebuild')
  fs.writeFileSync(p, `#!/bin/sh\necho "${out}" >&2\nexit ${code}\n`)
  fs.chmodSync(p, 0o755)
  return p
}
const iphoneSection = () =>
  lines.slice(
    lines.findIndex((l) => l.includes('iPhone')),
    lines.findIndex((l) => l.includes('共通')),
  )

describe('xcodeStatus', () => {
  it('Xcode の版、Command Line Tools、Xcode なしを見分ける', () => {
    expect(lib.xcodeStatus({ code: 0, out: 'Xcode 27.1\nBuild version 27B100\n' })).toEqual({
      version: { major: 27, text: '27.1' },
    })
    expect(lib.xcodeStatus({ code: 1, out: CLT_ERROR })).toEqual({ problem: 'clt' })
    expect(lib.xcodeStatus({ code: -1, out: 'spawn xcodebuild ENOENT' })).toEqual({ problem: 'missing' })
  })
})

describe('mobile:doctor の iPhone', () => {
  it('Windows では iPhone のファイルを確かめない（✗ を出して Mac のコマンドを勧めない）', async () => {
    await doctor({ platform: 'win32' })
    const section = iphoneSection().join('\n')
    expect(section).toContain('iPhone の項目は Mac で確かめます')
    expect(section).not.toContain('GoogleService-Info.plist')
    expect(section).not.toContain('local.xcconfig')
    expect(section).not.toContain('✗')
  })

  it.runIf(process.platform !== 'win32')(
    'Mac で Command Line Tools が選ばれている時は、Xcode を入れ直させずに xcode-select を勧める',
    async () => {
      await doctor({ platform: 'darwin', xcodebuild: fakeXcodebuild(CLT_ERROR, 1) })
      const section = iphoneSection().join('\n')
      expect(section).toContain('Command Line Tools が選ばれています（sudo xcode-select -s /Applications/Xcode.app）')
      expect(section).not.toContain('Xcode が見つかりません')
      // Mac では iPhone のファイルも確かめる
      expect(section).toContain('GoogleService-Info.plist')
    },
  )
})

describe.runIf(process.platform !== 'darwin')('mobile:firebase -- --ios（Mac 以外）', () => {
  it('Mac で行うように言って止まる（Firebase には触らない）', async () => {
    await main(['firebase', '--ios'])
    expect(process.exitCode).toBe(1)
    expect(lines.join('\n')).toContain('iPhone の設定（--ios）は Mac で行います')
  })
})
