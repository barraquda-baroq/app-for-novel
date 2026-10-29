#!/usr/bin/env node
// CI（.github/workflows/ci.yml の android・ios）で、できたアプリと設定を確かめる。手元では使わない（docs/MOBILE.md は scripts/mobile.mjs）。
//   android-version <apk>            版（versionCode・versionName）が package.json と同じ
//   android-keystore <jks>           使い捨ての鍵を作り、android/keystore.properties を書く（mobile:keystore と同じ形）
//   android-signature <apk> <jks>    APK がその鍵で署名されている
//   ios-build                        シミュレーター用に Debug でビルドする（署名なし）
//   ios-build-device                 実機用に Release でビルドする（署名なし。Mac の Product > Archive に近い形）
//   ios-app <App.app>                できたアプリの Info.plist・中身
//   ios-settings                     xcconfig（版・最低の iOS・local.xcconfig）が Debug・Release の両方で効く
//   ios-missing-google               Google ログインの設定が無い時に、ビルドが日本語の案内で止まる
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_ID,
  keystoreProperties,
  keytoolGenerateArgs,
  keytoolListArgs,
  localXcconfig,
  parseApksignerSha256,
  parseBadging,
  parseKeytoolFingerprints,
  parseProperties,
  versionCode,
} from './lib.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version
const code = versionCode(version)

let failed = false
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : `（期待: ${JSON.stringify(expected)}）`}`)
  if (!ok) failed = true
}
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
  if (r.error) throw r.error
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function must(command, args, opts) {
  const r = run(command, args, opts)
  if (r.code !== 0) {
    console.log(r.out)
    throw new Error(`${command} ${args.join(' ')} が失敗しました`)
  }
  return r.out
}

// ---- Android ----

function buildTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdk) throw new Error('ANDROID_HOME がありません')
  const versions = fs
    .readdirSync(path.join(sdk, 'build-tools'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .reverse()
  for (const v of versions) {
    const p = path.join(sdk, 'build-tools', v, name)
    if (fs.existsSync(p)) return p
  }
  throw new Error(`build-tools に ${name} がありません`)
}

const keytool = () => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool')

function keystoreSha256(jks, password) {
  const out = must(keytool(), keytoolListArgs(jks), { env: { ...process.env, NS_KS_PASS: password } })
  const fp = parseKeytoolFingerprints(out)
  if (!fp) throw new Error('keytool の出力から指紋を読めませんでした')
  return fp.sha256
}

const commands = {
  'android-version'(apk) {
    const b = parseBadging(must(buildTool('aapt2'), ['dump', 'badging', apk]))
    check('パッケージ名', b.packageName, APP_ID)
    check('versionCode', b.versionCode, code)
    check('versionName', b.versionName, version)
  },
  'android-keystore'(jks) {
    const password = randomBytes(12).toString('base64url')
    fs.rmSync(jks, { force: true })
    must(keytool(), keytoolGenerateArgs(jks), { env: { ...process.env, NS_KS_PASS: password } })
    fs.writeFileSync(path.join(repoDir, 'android', 'keystore.properties'), keystoreProperties({ storeFile: jks, password }))
    console.log('  ✓ 使い捨ての鍵と android/keystore.properties を作りました')
  },
  'android-signature'(apk, jks) {
    const props = parseProperties(fs.readFileSync(path.join(repoDir, 'android', 'keystore.properties'), 'utf8'))
    check('keystore.properties の storeFile', props.storeFile, jks.replace(/\\/g, '/'))
    const out = must(buildTool('apksigner'), ['verify', '--print-certs', apk])
    check('APK の署名の鍵（SHA-256）', parseApksignerSha256(out), keystoreSha256(jks, props.storePassword))
  },

  // ---- iPhone ----

  'ios-build'() {
    const r = spawnSync('xcodebuild', xcodebuildArgs(['GOOGLE_REVERSED_CLIENT_ID=com.googleusercontent.apps.ci']), {
      cwd: repoDir,
      stdio: 'inherit',
    })
    if (r.status !== 0) {
      console.log('✗ iPhone のビルドに失敗しました')
      process.exit(r.status || 1)
    }
    // Swift Package の版の控え（Xcode が書く）。リポジトリのものと違えば知らせる（Mac でも CI と同じ版を使うよう、新しいものを入れる）
    const resolved = 'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
    if (fs.existsSync(path.join(repoDir, resolved))) {
      const changed = run('git', ['status', '--porcelain', '--', resolved], { cwd: repoDir }).out.trim()
      if (changed) {
        console.log(`::warning::${resolved} がリポジトリのものと違います（下の内容でリポジトリのものを置き換えてください）`)
        console.log(`::group::${resolved}`)
        console.log(fs.readFileSync(path.join(repoDir, resolved), 'utf8'))
        console.log('::endgroup::')
      } else console.log(`  ✓ ${resolved} はリポジトリのものと同じ`)
    }
  },
  'ios-build-device'() {
    const r = spawnSync(
      'xcodebuild',
      xcodebuildArgs(['GOOGLE_REVERSED_CLIENT_ID=com.googleusercontent.apps.ci'], { device: true }),
      {
        cwd: repoDir,
        stdio: 'inherit',
      },
    )
    if (r.status !== 0) {
      console.log('✗ 実機用（Release）のビルドに失敗しました')
      process.exit(r.status || 1)
    }
    const app = path.join(
      process.env.IOS_DERIVED_DATA || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'dd'),
      'Build',
      'Products',
      'Release-iphoneos',
      'App.app',
    )
    const info = JSON.parse(must('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]))
    check('CFBundleShortVersionString（Release）', info.CFBundleShortVersionString, version)
    check('CFBundleVersion（Release）', info.CFBundleVersion, String(code))
    check('CAPACITOR_DEBUG（Release では空）', info.CAPACITOR_DEBUG ?? '', '')
  },
  'ios-app'(app) {
    const info = JSON.parse(must('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]))
    check('CFBundleIdentifier', info.CFBundleIdentifier, APP_ID)
    check('CFBundleDisplayName', info.CFBundleDisplayName, 'Novel Studio')
    check('CFBundleShortVersionString', info.CFBundleShortVersionString, version)
    check('CFBundleVersion', info.CFBundleVersion, String(code))
    check('MinimumOSVersion', info.MinimumOSVersion, '16.0')
    check('CFBundleDevelopmentRegion', info.CFBundleDevelopmentRegion, 'ja')
    check('ITSAppUsesNonExemptEncryption', info.ITSAppUsesNonExemptEncryption, false)
    check('URL スキーム', info.CFBundleURLTypes?.[0]?.CFBundleURLSchemes?.[0], 'com.googleusercontent.apps.ci')
    for (const f of ['PrivacyInfo.xcprivacy', 'GoogleService-Info.plist', 'capacitor.config.json', 'public/index.html'])
      check(`${f} がある`, fs.existsSync(path.join(app, f)), true)
    // dist-native（サービスワーカーなし）を載せている
    for (const f of ['public/sw.js', 'public/manifest.webmanifest']) check(`${f} が無い`, fs.existsSync(path.join(app, f)), false)
    const cap = JSON.parse(fs.readFileSync(path.join(app, 'capacitor.config.json'), 'utf8'))
    check('iosScheme', cap.server?.iosScheme, 'capacitor')
    check('Keyboard.resize', cap.plugins?.Keyboard?.resize, 'none')
  },
  'ios-settings'() {
    const local = path.join(repoDir, 'ios', 'App', 'local.xcconfig')
    const saved = fs.existsSync(local) ? fs.readFileSync(local) : null
    try {
      fs.rmSync(local, { force: true })
      for (const configuration of ['Debug', 'Release']) {
        console.log(`${configuration}（local.xcconfig なし）`)
        const s = buildSettings(configuration)
        check('MARKETING_VERSION', s.MARKETING_VERSION, version)
        check('CURRENT_PROJECT_VERSION', s.CURRENT_PROJECT_VERSION, String(code))
        check('IPHONEOS_DEPLOYMENT_TARGET', s.IPHONEOS_DEPLOYMENT_TARGET, '16.0')
        check('PRODUCT_BUNDLE_IDENTIFIER', s.PRODUCT_BUNDLE_IDENTIFIER, APP_ID)
        check('GOOGLE_REVERSED_CLIENT_ID', s.GOOGLE_REVERSED_CLIENT_ID ?? '', '')
        check('CAPACITOR_DEBUG', s.CAPACITOR_DEBUG ?? '', configuration === 'Debug' ? 'true' : '')
      }
      fs.writeFileSync(local, localXcconfig({ reversedClientId: 'com.googleusercontent.apps.local-check', team: 'ABCDE12345' }))
      for (const configuration of ['Debug', 'Release']) {
        console.log(`${configuration}（local.xcconfig あり）`)
        const s = buildSettings(configuration)
        check('GOOGLE_REVERSED_CLIENT_ID', s.GOOGLE_REVERSED_CLIENT_ID, 'com.googleusercontent.apps.local-check')
        check('DEVELOPMENT_TEAM', s.DEVELOPMENT_TEAM, 'ABCDE12345')
        check('MARKETING_VERSION', s.MARKETING_VERSION, version)
      }
    } finally {
      fs.rmSync(local, { force: true })
      if (saved) fs.writeFileSync(local, saved)
    }
  },
  'ios-missing-google'() {
    const local = path.join(repoDir, 'ios', 'App', 'local.xcconfig')
    if (fs.existsSync(local)) throw new Error('ios/App/local.xcconfig があると確かめられません')
    const r = run('xcodebuild', xcodebuildArgs([]), { cwd: repoDir })
    const message = 'Google ログインの設定がありません'
    check('ビルドが止まる', r.code !== 0, true)
    check(`「${message}」と出る`, r.out.includes(message), true)
    if (failed) console.log(r.out.split('\n').slice(-40).join('\n'))
  },
}

function xcodebuildArgs(extra, { device = false } = {}) {
  const tmp = process.env.RUNNER_TEMP || os.tmpdir()
  return [
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'App',
    '-configuration',
    device ? 'Release' : 'Debug',
    '-sdk',
    device ? 'iphoneos' : 'iphonesimulator',
    '-destination',
    device ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
    '-derivedDataPath',
    process.env.IOS_DERIVED_DATA || path.join(tmp, 'dd'),
    '-clonedSourcePackagesDirPath',
    process.env.SPM_PACKAGES || path.join(os.homedir(), 'spm-packages'),
    '-skipPackagePluginValidation',
    '-skipMacroValidation',
    'CODE_SIGNING_ALLOWED=NO',
    ...extra,
    'build',
  ]
}

function buildSettings(configuration) {
  const out = must(
    'xcodebuild',
    [
      '-project',
      'ios/App/App.xcodeproj',
      '-target',
      'App',
      '-configuration',
      configuration,
      '-sdk',
      'iphonesimulator',
      '-showBuildSettings',
    ],
    { cwd: repoDir },
  )
  const s = {}
  for (const line of out.split('\n')) {
    const m = /^\s{4}([A-Z0-9_]+) = (.*)$/.exec(line)
    if (m) s[m[1]] = m[2]
  }
  return s
}

const [name, ...args] = process.argv.slice(2)
if (!commands[name]) {
  console.log(`使い方: node scripts/mobile/ci.mjs <${Object.keys(commands).join('|')}> …`)
  process.exit(2)
}
console.log(`▶ ${name}`)
await commands[name](...args)
if (failed) {
  console.log(`✗ ${name}: 合わないものがありました`)
  process.exit(1)
}
