// @vitest-environment node
// Android のビルドを動かす Java。いまの Android Studio の Java（JBR）は 25 で、Capacitor 8 の Gradle 8.14 とプラグインは Java 25 では
// ビルドできないので、android/gradle/gradle-daemon-jvm.properties で Gradle 自身を Java 21 で動かす（無ければ Gradle がダウンロードする）。
// その決まりのファイル、mobile:doctor の表示、android:install の失敗の時の案内を確かめる
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { androidBuildFailure, doctor, exec } from '../mobile.mjs'
import * as lib from './lib.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const daemonJvm = fs.readFileSync(path.join(repoDir, 'android', 'gradle', 'gradle-daemon-jvm.properties'), 'utf8')

// Android Studio の jbr/release（JBR 25 の形）
const JBR25_RELEASE = `IMPLEMENTOR="JetBrains s.r.o."
JAVA_RUNTIME_VERSION="25.0.4+8-b329.65"
JAVA_VERSION="25.0.4"
JAVA_VERSION_DATE="2026-07-21"
OS_ARCH="x86_64"
OS_NAME="Windows"
`

// Java 25 で gradlew を動かした時の実際の失敗（CI の android (Java 25)、決まりのファイルが無い時）
const JAVA25_TOOLCHAIN_FAILURE = `FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':capacitor-filesystem:bundleLibCompileToJarDebug'.
> Could not create task ':capacitor-filesystem:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':capacitor-filesystem:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching: {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}. Toolchain download repositories have not been configured.
`
// ビルドの設定を Java 25 で読んだ時（Capacitor 8.5.3・Gradle 8.14.3・JDK 25 の報告）
const JAVA25_SCRIPT_FAILURE = `FAILURE: Build failed with an exception.

* What went wrong:
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 69
`
// Java 21 をダウンロードできなかった時（Gradle 8.14.3 の言い方）
const DOWNLOAD_FAILURE = `FAILURE: Build failed with an exception.

* What went wrong:
Unable to download toolchain matching the requirements ({languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}) from 'https://api.foojay.io/disco/v3.0/ids/ccc3884e65cd85bb71a09d2223c77229/redirect', due to: Could not HEAD 'https://api.foojay.io/disco/v3.0/ids/ccc3884e65cd85bb71a09d2223c77229/redirect'.
`
const LONG_PATH_FAILURE = `> Task :app:mergeReleaseResources FAILED
ERROR: C:\\Users\\me\\Desktop\\とても深いフォルダ\\app-for-novel\\android\\app\\build\\intermediates\\...: Filename longer than 260 characters
`
const COMPILE_FAILURE = `> Task :app:compileReleaseJavaWithJavac FAILED
MainActivity.java:12: error: cannot find symbol
`

describe('android/gradle/gradle-daemon-jvm.properties', () => {
  it('Gradle を Java 21 で動かし、Windows・Mac（Apple シリコン・Intel）・Linux でダウンロード先がある', () => {
    const props = lib.parseProperties(daemonJvm)
    expect(props.toolchainVersion).toBe(String(lib.GRADLE_JAVA))
    expect(lib.GRADLE_JAVA).toBe(21)
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
    ]) {
      expect(lib.daemonJvmProblems(daemonJvm, platform, arch), `${platform} ${arch}`).toEqual([])
      expect(props[`toolchainUrl.${lib.gradlePlatformKey(platform, arch)}`]).toMatch(/^https:\/\/api\.foojay\.io\/disco\//)
    }
    // どの Java の会社のものでもよい（パソコンにある Java 21 を使える）
    expect(props.toolchainVendor).toBeUndefined()
  })

  it('無い・Java 21 でない・このパソコンのダウンロード先が無い時は、元に戻すように言う', () => {
    expect(lib.daemonJvmProblems(null, 'win32', 'x64')[0]).toContain('がありません')
    const v25 = lib.daemonJvmProblems(daemonJvm.replace('toolchainVersion=21', 'toolchainVersion=25'), 'win32', 'x64')
    expect(v25).toHaveLength(1)
    expect(v25[0]).toContain('git checkout -- android/gradle/gradle-daemon-jvm.properties')
    const noWindows = daemonJvm
      .split('\n')
      .filter((l) => !l.startsWith('toolchainUrl.WINDOWS.X86_64'))
      .join('\n')
    expect(lib.daemonJvmProblems(noWindows, 'win32', 'x64')[0]).toContain('toolchainUrl.WINDOWS.X86_64')
    expect(lib.daemonJvmProblems(noWindows, 'darwin', 'arm64')).toEqual([])
  })

  it('このパソコンの名前（Gradle の決まり）', () => {
    expect(lib.gradlePlatformKey('win32', 'x64')).toBe('WINDOWS.X86_64')
    expect(lib.gradlePlatformKey('darwin', 'arm64')).toBe('MAC_OS.AARCH64')
    expect(lib.gradlePlatformKey('linux', 'x64')).toBe('LINUX.X86_64')
  })
})

describe('JDK の版（jbr/release）', () => {
  it('JAVA_VERSION を読む（JAVA_VERSION_DATE は見ない）', () => {
    expect(lib.parseJavaRelease(JBR25_RELEASE)).toEqual({ text: '25.0.4', major: 25 })
    expect(lib.parseJavaRelease('JAVA_VERSION="21.0.8"\r\n')).toEqual({ text: '21.0.8', major: 21 })
    expect(lib.parseJavaRelease('JAVA_VERSION="1.8.0_402"')).toEqual({ text: '1.8.0_402', major: 8 })
    expect(lib.parseJavaRelease('JAVA_VERSION_DATE="2026-07-21"')).toBeNull()
    expect(lib.parseJavaRelease(null)).toBeNull()
  })
})

describe('android:install のビルドの失敗の案内', () => {
  it('Java 25 で動いた時は、決まりのファイルを確かめるように言う（長いパスの案内は出さない）', () => {
    for (const out of [JAVA25_TOOLCHAIN_FAILURE, JAVA25_SCRIPT_FAILURE]) {
      const hints = lib.gradleFailureHints(out, 'win32')
      expect(hints).toHaveLength(1)
      expect(hints[0]).toContain('android/gradle/gradle-daemon-jvm.properties')
      const message = androidBuildFailure(out, 'win32')
      expect(message).toContain('Java が新しすぎます')
      expect(message).not.toContain('短い場所')
    }
  })

  it('Java 21 をダウンロードできなかった時は、インターネットを確かめてやり直すように言う', () => {
    const hints = lib.gradleFailureHints(DOWNLOAD_FAILURE, 'darwin')
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('ダウンロードできませんでした')
  })

  it('長いパスの案内は、Windows でその失敗の時だけ', () => {
    expect(androidBuildFailure(LONG_PATH_FAILURE, 'win32')).toContain('C:\\Users\\<名前>\\dev\\app-for-novel')
    expect(lib.gradleFailureHints(LONG_PATH_FAILURE, 'darwin')).toEqual([])
    // ほかの失敗では、関係のない置き直しを勧めない
    expect(lib.gradleFailureHints(COMPILE_FAILURE, 'win32')).toEqual([])
    expect(androidBuildFailure(COMPILE_FAILURE, 'win32')).toBe(
      'Android のアプリのビルドに失敗しました（上の表示を見てください）。',
    )
  })
})

describe.runIf(process.platform !== 'win32')('exec の teeStderr（gradlew のエラーの表示を、画面に出しながら控える）', () => {
  it('エラーの表示は画面にも出て、控えたものが返る（ふつうの出力は控えない）', async () => {
    const shown = []
    vi.spyOn(process.stderr, 'write').mockImplementation((d) => (shown.push(String(d)), true))
    const r = await exec('sh', ['-c', 'echo progress; echo "Filename longer than 260 characters" >&2; exit 3'], {
      teeStderr: true,
    })
    vi.restoreAllMocks()
    expect(r.code).toBe(3)
    expect(r.out).toBe('Filename longer than 260 characters\n')
    expect(shown.join('')).toBe('Filename longer than 260 characters\n')
  })
})

describe.runIf(process.platform !== 'win32')('mobile:doctor の Android の Java', () => {
  let dir = ''
  let jbr = ''
  let lines = []
  const saved = process.env.CAPACITOR_ANDROID_STUDIO_PATH
  beforeEach(() => {
    // 偽物の Android Studio（CAPACITOR_ANDROID_STUDIO_PATH の場所が一番先に探される）と、その Java（jbr/bin/keytool と release）
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-studio-'))
    const mac = process.platform === 'darwin'
    jbr = mac ? path.join(dir, 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home') : path.join(dir, 'jbr')
    fs.mkdirSync(path.join(jbr, 'bin'), { recursive: true })
    fs.writeFileSync(lib.keytoolIn(process.platform, jbr), '')
    fs.writeFileSync(path.join(jbr, 'release'), JBR25_RELEASE)
    process.env.CAPACITOR_ANDROID_STUDIO_PATH = mac
      ? path.join(dir, 'Android Studio.app', 'Contents', 'MacOS', 'studio')
      : path.join(dir, 'bin', 'studio.sh')
    lines = []
    vi.spyOn(console, 'log').mockImplementation((m = '') => lines.push(String(m)))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (saved === undefined) delete process.env.CAPACITOR_ANDROID_STUDIO_PATH
    else process.env.CAPACITOR_ANDROID_STUDIO_PATH = saved
    fs.rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('Java の版を出し、Gradle は Java 21 で動く（無ければダウンロードする）と言う', async () => {
    await doctor({ platform: 'win32', arch: 'x64' })
    const text = lines.join('\n')
    expect(text).toContain(`✓ Android Studio の Java: ${jbr}（Java 25.0.4）`)
    expect(text).toContain(
      '✓ アプリのビルド（Gradle）は Java 21 で動きます（パソコンに無ければ、初めてのビルドの時に自動でダウンロード',
    )
    expect(text).not.toContain('gradle-daemon-jvm.properties')
  })
})
