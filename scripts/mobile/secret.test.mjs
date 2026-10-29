// @vitest-environment node
// 秘密のファイル（署名の鍵・keystore.properties）の置き方（scripts/mobile/secret.mjs）。Windows では mode を確かめない
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copySecret, makeSecretDir, protectSecret, writeSecret } from './secret.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const posix = process.platform !== 'win32'
const mode = (p) => fs.statSync(p).mode & 0o777

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-secret-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.runIf(posix)('秘密のファイル（Mac・Linux）', () => {
  it('フォルダは自分だけが入れる形で作る', () => {
    const keys = path.join(dir, 'NovelStudioKeys')
    makeSecretDir(keys)
    expect(mode(keys)).toBe(0o700)
  })

  it('書いたファイルは 0600。前からあった 0644 のファイルも直す', () => {
    const f = path.join(dir, 'keystore.properties')
    writeSecret(f, 'storePassword=x\n')
    expect(mode(f)).toBe(0o600)
    fs.chmodSync(f, 0o644)
    writeSecret(f, 'storePassword=y\n')
    expect(mode(f)).toBe(0o600)
    expect(fs.readFileSync(f, 'utf8')).toBe('storePassword=y\n')
  })

  it('コピーした鍵は、元が誰でも読める形（USB メモリなど）でも 0600。コピー先のフォルダは 0700 で作る', () => {
    const src = path.join(dir, 'usb.jks')
    fs.writeFileSync(src, 'key')
    fs.chmodSync(src, 0o777)
    const dest = path.join(dir, 'NovelStudioKeys', 'novelstudio-release.jks')
    copySecret(src, dest)
    expect(mode(dest)).toBe(0o600)
    expect(mode(path.dirname(dest))).toBe(0o700)
    expect(fs.readFileSync(dest, 'utf8')).toBe('key')
  })

  it('keytool の作った鍵（0644）を 0600 にする', () => {
    const f = path.join(dir, 'novelstudio-release.jks')
    fs.writeFileSync(f, 'key', { mode: 0o644 })
    protectSecret(f)
    expect(mode(f)).toBe(0o600)
  })
})

describe('scripts/mobile.mjs', () => {
  it('署名の鍵と keystore.properties は secret.mjs の形で置く（fs のそのままの書き込み・コピーを使わない）', () => {
    const src = fs.readFileSync(path.join(repoDir, 'scripts', 'mobile.mjs'), 'utf8')
    const body = src.slice(src.indexOf('async function keystore('), src.indexOf('async function firebaseCommand('))
    expect(body).not.toMatch(/fs\.(writeFileSync|copyFileSync|mkdirSync)\(/)
    expect(body).toContain('writeSecret(files.keystoreProperties')
    expect(body).toContain('copySecret(src, target)')
    expect(body).toContain('protectSecret(target)')
    expect(body).toContain('makeSecretDir(path.dirname(target))')
  })
})
