// @vitest-environment node
// iPhone / Android アプリのスクリプトの部品（scripts/mobile/lib.mjs）。Windows と Mac の両方の形で確かめる
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as lib from './lib.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(repoDir, p), 'utf8')

const SHA1 = 'BE:71:A7:07:CE:F7:AA:76:49:6F:31:EE:5A:7B:97:6C:EA:54:B8:F6'
const SHA256 = 'B0:B7:A7:B3:F4:B7:6B:D2:6D:57:FB:22:BD:3C:41:73:DB:19:DE:65:9C:22:88:07:AC:E2:1A:2C:19:B6:E3:D2'

// keytool -J-Duser.language=en -list -v（JDK 21 の実際の出力）
const KEYTOOL_EN = `Alias name: novelstudio
Creation date: Oct 29, 2026
Entry type: PrivateKeyEntry
Certificate chain length: 1
Certificate[1]:
Owner: CN=Novel Studio, C=JP
Issuer: CN=Novel Studio, C=JP
Serial number: 9e460825d674c66e
Valid from: Thu Oct 29 08:32:39 UTC 2026 until: Mon Mar 16 08:32:39 UTC 2054
Certificate fingerprints:
\t SHA1: ${SHA1}
\t SHA256: ${SHA256}
Signature algorithm name: SHA384withRSA
`
// 日本語の Windows で -J-Duser.language=en が効かなかった時
const KEYTOOL_JA = `別名: novelstudio
作成日: 2026/10/29
エントリ・タイプ: PrivateKeyEntry
証明書のフィンガプリント:
\t SHA1: ${SHA1}
\t SHA256: ${SHA256}
署名アルゴリズム名: SHA384withRSA
`

const GOOGLE_SERVICES = {
  project_info: { project_number: '223868754377', project_id: 'novel-studio-3352e' },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '1:223868754377:android:abc',
        android_client_info: { package_name: 'jp.barraquda.novelstudio' },
      },
      oauth_client: [
        {
          client_id: '223868754377-a.apps.googleusercontent.com',
          client_type: 1,
          android_info: { package_name: 'jp.barraquda.novelstudio', certificate_hash: lib.normalizeSha(SHA1) },
        },
        { client_id: '223868754377-web.apps.googleusercontent.com', client_type: 3 },
      ],
      api_key: [{ current_key: 'AIza-not-secret' }],
    },
  ],
  configuration_version: '1',
}

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CLIENT_ID</key>
\t<string>223868754377-ios.apps.googleusercontent.com</string>
\t<key>REVERSED_CLIENT_ID</key>
\t<string>com.googleusercontent.apps.223868754377-ios</string>
\t<key>BUNDLE_ID</key>
\t<string>jp.barraquda.novelstudio</string>
\t<key>GOOGLE_APP_ID</key>
\t<string>1:223868754377:ios:def</string>
</dict>
</plist>
`
const PLIST_WITHOUT_CLIENT = PLIST.replace(
  /\t<key>CLIENT_ID<\/key>\n\t<string>[^<]*<\/string>\n\t<key>REVERSED_CLIENT_ID<\/key>\n\t<string>[^<]*<\/string>\n/,
  '',
)

const win = {
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  home: 'C:\\Users\\me',
}
const mac = { platform: 'darwin', env: { HOME: '/Users/me' }, home: '/Users/me' }

describe('版', () => {
  it('versionCode は x.y.z から（2.4.0 → 20400）', () => {
    expect(lib.versionCode('2.4.0')).toBe(20400)
    expect(lib.versionCode('2.10.3')).toBe(21003)
    expect(lib.versionCode('3.0.0')).toBe(30000)
    expect(() => lib.versionCode('2.4')).toThrow()
    expect(() => lib.versionCode('2.100.0')).toThrow()
  })

  it('Android（app/build.gradle）は同じ作り方で package.json から作る', () => {
    const gradle = read('android/app/build.gradle')
    expect(gradle).toContain("new groovy.json.JsonSlurper().parse(file('../../package.json'))")
    expect(gradle).toMatch(/versionCode vMaj \* 10000 \+ vMin \* 100 \+ vPat/)
    expect(gradle).toMatch(/versionName pkg\.version/)
    const version = JSON.parse(read('package.json')).version
    expect(read('ios/App/novelstudio.xcconfig')).toContain(`CURRENT_PROJECT_VERSION = ${lib.versionCode(version)}`)
  })
})

describe('署名の鍵（keytool）', () => {
  it('英語でも日本語でも指紋を読む（小文字・コロンなしにする）', () => {
    const want = { sha1: 'be71a707cef7aa76496f31ee5a7b976cea54b8f6', sha256: lib.normalizeSha(SHA256) }
    expect(lib.parseKeytoolFingerprints(KEYTOOL_EN)).toEqual(want)
    expect(lib.parseKeytoolFingerprints(KEYTOOL_JA)).toEqual(want)
    // 文字化けした日本語の画面（ラベルは英字のまま）
    expect(lib.parseKeytoolFingerprints(KEYTOOL_JA.replace(/[^\x00-\x7f]/g, '?'))).toEqual(want)
    expect(lib.parseKeytoolFingerprints('keytool error: java.io.IOException: keystore password was incorrect')).toBeNull()
  })

  it('指紋の形を変える', () => {
    expect(lib.formatSha(lib.normalizeSha(SHA1))).toBe(SHA1)
    expect(lib.normalizeSha(' be:71:A7 ')).toBe('be71a7')
  })

  it('失敗の理由を見分ける', () => {
    expect(lib.keytoolProblem('keytool error: java.io.IOException: keystore password was incorrect')).toBe('wrong_password')
    expect(lib.keytoolProblem('keytoolエラー: java.io.IOException: キーストアのパスワードが不正です')).toBe('wrong_password')
    expect(lib.keytoolProblem('keytool error: java.lang.Exception: Alias <x> does not exist')).toBe('no_alias')
    expect(lib.keytoolProblem('keytool error: java.lang.Exception: Keystore file does not exist: a.jks')).toBe('no_file')
    expect(lib.keytoolProblem('something else')).toBeNull()
  })

  it('パスワードはコマンドの引数に入れない（環境変数 NS_KS_PASS）', () => {
    const args = lib.keytoolGenerateArgs('C:\\Users\\me\\NovelStudioKeys\\novelstudio-release.jks')
    expect(args).toEqual(
      expect.arrayContaining(['-genkeypair', '-storetype', 'PKCS12', '-alias', 'novelstudio', '-keyalg', 'RSA']),
    )
    expect(args.join(' ')).toContain('-storepass:env NS_KS_PASS')
    expect(args.join(' ')).toContain('-keypass:env NS_KS_PASS')
    expect(args.join(' ')).toContain('-validity 10000')
    expect(lib.keytoolListArgs('a.jks').join(' ')).toBe(
      '-J-Duser.language=en -list -v -keystore a.jks -alias novelstudio -storepass:env NS_KS_PASS',
    )
  })

  it('パスワードの決まり', () => {
    expect(lib.passwordProblem('short')).toMatch(/8 文字/)
    expect(lib.passwordProblem('パスワード日本語です')).toMatch(/半角/)
    expect(lib.passwordProblem('has space 123')).toMatch(/半角/)
    expect(lib.passwordProblem('Good#Pass\\word=1')).toBeNull()
  })
})

describe('keystore.properties・local.properties', () => {
  it('Windows のパスは / にして書き、パスワードの記号もそのまま読み戻せる', () => {
    const password = 'p\\a#s:s=w!o rd'
    const text = lib.keystoreProperties({ storeFile: 'C:\\Users\\me\\NovelStudioKeys\\novelstudio-release.jks', password })
    expect(text).toContain('storeFile=C:/Users/me/NovelStudioKeys/novelstudio-release.jks')
    expect(text).not.toContain('\\Users')
    const props = lib.parseProperties(text)
    expect(props).toEqual({
      storeFile: 'C:/Users/me/NovelStudioKeys/novelstudio-release.jks',
      storePassword: password,
      keyAlias: 'novelstudio',
      keyPassword: password,
    })
    expect(lib.keystorePropertiesProblems(props)).toEqual([])
    expect(lib.keystorePropertiesProblems({ storeFile: 'a' })).toEqual(['storePassword', 'keyAlias', 'keyPassword'])
  })

  it('Mac のパス・日本語のフォルダ名・先頭の空白も Properties の形で書く', () => {
    const text = lib.keystoreProperties({ storeFile: '/Users/me/鍵/novelstudio-release.jks', password: ' lead' })
    expect(text).toContain('storeFile=/Users/me/\\u9375/novelstudio-release.jks')
    expect(text).toContain('storePassword=\\ lead')
    expect(lib.parseProperties(text).storeFile).toBe('/Users/me/鍵/novelstudio-release.jks')
    expect(lib.parseProperties(text).storePassword).toBe(' lead')
  })

  it('Properties の書き方のいろいろを読む', () => {
    const text = '# comment\n! comment\nkey1 = value1\nkey2:value2\nkey3 value3\nlong=first \\\n    second\nescaped\\=key=v\n'
    expect(lib.parseProperties(text)).toEqual({
      key1: 'value1',
      key2: 'value2',
      key3: 'value3',
      long: 'first second',
      'escaped=key': 'v',
    })
  })

  it('local.properties（SDK の場所）', () => {
    const text = lib.localPropertiesText('C:\\Users\\me\\AppData\\Local\\Android\\Sdk')
    expect(text).toContain('sdk.dir=C\\:/Users/me/AppData/Local/Android/Sdk')
    expect(lib.parseProperties(text)['sdk.dir']).toBe('C:/Users/me/AppData/Local/Android/Sdk')
    expect(lib.parseProperties(lib.localPropertiesText('/Users/me/Library/Android/sdk'))['sdk.dir']).toBe(
      '/Users/me/Library/Android/sdk',
    )
  })
})

describe('パソコンの中の場所', () => {
  it('鍵の置き場所', () => {
    expect(lib.defaultKeystorePath(win)).toBe('C:\\Users\\me\\NovelStudioKeys\\novelstudio-release.jks')
    expect(lib.defaultKeystorePath(mac)).toBe('/Users/me/NovelStudioKeys/novelstudio-release.jks')
  })

  it('Android Studio の Java（JBR）は Android Studio のものを先に、JAVA_HOME は最後', () => {
    const w = lib.jbrCandidates({ ...win, env: { ...win.env, ProgramFiles: 'C:\\Program Files', JAVA_HOME: 'C:\\jdk17' } })
    expect(w[0]).toBe('C:\\Program Files\\Android\\Android Studio\\jbr')
    expect(w).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Android Studio\\jbr')
    expect(w.at(-1)).toBe('C:\\jdk17')
    const custom = lib.jbrCandidates({
      ...win,
      env: { ...win.env, CAPACITOR_ANDROID_STUDIO_PATH: 'D:\\Tools\\Android Studio\\bin\\studio64.exe' },
    })
    expect(custom[0]).toBe('D:\\Tools\\Android Studio\\jbr')
    const m = lib.jbrCandidates(mac)
    expect(m[0]).toBe('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
    expect(m).toContain('/Users/me/Applications/Android Studio.app/Contents/jbr/Contents/Home')
  })

  it('Android SDK', () => {
    expect(lib.sdkCandidates(win)).toEqual(['C:\\Users\\me\\AppData\\Local\\Android\\Sdk'])
    expect(lib.sdkCandidates(mac)).toEqual(['/Users/me/Library/Android/sdk'])
    expect(lib.sdkCandidates({ ...mac, env: { ...mac.env, ANDROID_HOME: '/opt/sdk' } })[0]).toBe('/opt/sdk')
  })

  it('道具のファイル（Windows は .exe）と Gradle の動かし方', () => {
    expect(lib.keytoolIn('win32', 'C:\\Program Files\\Android\\Android Studio\\jbr')).toBe(
      'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe',
    )
    expect(lib.adbIn('win32', 'C:\\sdk')).toBe('C:\\sdk\\platform-tools\\adb.exe')
    expect(lib.adbIn('darwin', '/Users/me/Library/Android/sdk')).toBe('/Users/me/Library/Android/sdk/platform-tools/adb')
    expect(lib.javaIn('darwin', '/jbr')).toBe('/jbr/bin/java')
    expect(lib.gradleCommand('win32', ['assembleRelease'])).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'gradlew.bat assembleRelease'],
    })
    expect(lib.gradleCommand('darwin', ['assembleRelease'])).toEqual({ command: './gradlew', args: ['assembleRelease'] })
  })

  it('Android Studio の場所（cap open android に教える）', () => {
    expect(lib.studioFromJbr('win32', 'C:\\Program Files\\Android\\Android Studio\\jbr')).toBe(
      'C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe',
    )
    expect(lib.studioFromJbr('darwin', '/Applications/Android Studio.app/Contents/jbr/Contents/Home')).toBe(
      '/Applications/Android Studio.app',
    )
  })
})

describe('adb', () => {
  it('つないでいるスマホの一覧', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      '3A281FDJH00ABC         device usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:2',
      'R58M12345              unauthorized usb:1-2 transport_id:3',
      '',
    ].join('\r\n')
    expect(lib.parseAdbDevices(out)).toEqual([
      { serial: '3A281FDJH00ABC', state: 'device', model: 'Pixel 8' },
      { serial: 'R58M12345', state: 'unauthorized', model: '' },
    ])
    expect(lib.parseAdbDevices('List of devices attached\n\n')).toEqual([])
  })

  it('インストールの失敗は「アプリを削除しない」案内にする', () => {
    expect(lib.explainInstallFailure('Performing Streamed Install\nSuccess\n')).toBeNull()
    const sig = lib.explainInstallFailure(
      'adb: failed to install app-release.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package jp.barraquda.novelstudio signatures do not match newer version; ignoring!]',
    )
    expect(sig).toMatch(/署名の鍵が違います/)
    expect(sig).toMatch(/削除（アンインストール）しないでください/)
    expect(sig).toMatch(/mobile:keystore -- --use/)
    const down = lib.explainInstallFailure('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]')
    expect(down).toMatch(/古い版/)
    expect(down).toMatch(/削除（アンインストール）しないでください/)
    expect(lib.explainInstallFailure('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')).toMatch(/空き容量/)
  })
})

describe('Firebase', () => {
  it('firebase-tools の --json の出力を読む（前に何か出ていても）', () => {
    expect(lib.parseFirebaseJson('{\n  "status": "success",\n  "result": [1]\n}')).toEqual({ status: 'success', result: [1] })
    expect(lib.parseFirebaseJson('✔ Preparing\n{\n  "status": "error",\n  "error": "Failed"\n}')).toEqual({
      status: 'error',
      error: 'Failed',
    })
    expect(lib.parseFirebaseJson('no json')).toBeNull()
  })

  it('失敗の理由', () => {
    expect(lib.firebaseProblem('Failed to authenticate, have you run firebase login?')).toBe('login')
    expect(lib.firebaseProblem('HTTP Error: 403, The caller does not have permission')).toBe('permission')
    expect(lib.firebaseProblem('Network error')).toBeNull()
  })

  it('登録済みのアプリをパッケージ名・バンドル ID で探す', () => {
    const apps = [
      { appId: '1:1:web:x', platform: 'WEB' },
      { appId: '1:1:android:other', platform: 'ANDROID', packageName: 'com.example' },
      { appId: '1:1:android:ns', platform: 'ANDROID', packageName: 'jp.barraquda.novelstudio' },
      { appId: '1:1:ios:ns', platform: 'IOS', bundleId: 'jp.barraquda.novelstudio' },
    ]
    expect(lib.findFirebaseApp(apps, 'ANDROID')?.appId).toBe('1:1:android:ns')
    expect(lib.findFirebaseApp(apps, 'IOS')?.appId).toBe('1:1:ios:ns')
    expect(lib.findFirebaseApp([], 'IOS')).toBeNull()
    expect(lib.findFirebaseApp(undefined, 'IOS')).toBeNull()
  })

  it('登録済みの指紋（形が違っても同じものは同じ）', () => {
    const certs = [{ name: 'projects/p/androidApps/a/sha/1', shaHash: lib.normalizeSha(SHA1), certType: 'SHA_1' }]
    expect(lib.hasSha(certs, SHA1)).toBe(true)
    expect(lib.hasSha(certs, SHA256)).toBe(false)
  })

  it('google-services.json を確かめる', () => {
    expect(lib.googleServicesProblems(GOOGLE_SERVICES, { sha1: SHA1 })).toEqual([])
    expect(lib.googleServicesProblems(JSON.stringify(GOOGLE_SERVICES), { sha1: lib.normalizeSha(SHA1) })).toEqual([])
    expect(lib.googleServicesProblems(GOOGLE_SERVICES, { sha1: '00'.repeat(20) })[0]).toMatch(/SHA-1/)
    const noAndroid = structuredClone(GOOGLE_SERVICES)
    noAndroid.client[0].oauth_client = noAndroid.client[0].oauth_client.filter((o) => o.client_type !== 1)
    expect(lib.googleServicesProblems(noAndroid, { sha1: SHA1 })).toEqual([
      'Android のログインの設定（OAuth クライアント）がまだできていません',
    ])
    const noWeb = structuredClone(GOOGLE_SERVICES)
    noWeb.client[0].oauth_client = noWeb.client[0].oauth_client.filter((o) => o.client_type !== 3)
    expect(lib.googleServicesProblems(noWeb, { sha1: SHA1 })).toEqual(['Web のログインの設定（client_type 3）がまだありません'])
    expect(lib.googleServicesProblems(GOOGLE_SERVICES, { packageName: 'com.example' })[0]).toMatch(
      /com\.example のアプリがありません/,
    )
    expect(lib.googleServicesProblems('{')).toEqual(['google-services.json が JSON として読めません'])
  })

  it('GoogleService-Info.plist を確かめる', () => {
    expect(lib.servicePlistCheck(PLIST)).toEqual({
      problems: [],
      clientId: '223868754377-ios.apps.googleusercontent.com',
      reversedClientId: 'com.googleusercontent.apps.223868754377-ios',
    })
    expect(lib.servicePlistCheck(PLIST_WITHOUT_CLIENT).problems).toEqual([
      'CLIENT_ID がありません（Google ログインの設定がまだできていません）',
      'REVERSED_CLIENT_ID がありません',
    ])
    expect(lib.servicePlistCheck(PLIST.replace('apps.223868754377-ios</string>', 'apps.other</string>')).problems).toEqual([
      'CLIENT_ID と REVERSED_CLIENT_ID が合っていません',
    ])
    expect(
      lib.servicePlistCheck(PLIST.replace('<string>jp.barraquda.novelstudio</string>', '<string>com.example</string>'))
        .problems[0],
    ).toMatch(/バンドル ID/)
    // CI 用の中身のないもの（ios/ci）も同じ形
    expect(lib.servicePlistCheck(read('ios/ci/GoogleService-Info.ci.plist')).problems).toEqual([])
  })

  it('--ios-client-id: plist に CLIENT_ID と REVERSED_CLIENT_ID を足す', () => {
    expect(lib.reverseClientId('223868754377-ios.apps.googleusercontent.com')).toBe('com.googleusercontent.apps.223868754377-ios')
    const added = lib.addClientIdToPlist(PLIST_WITHOUT_CLIENT, '223868754377-ios.apps.googleusercontent.com')
    expect(lib.servicePlistCheck(added).problems).toEqual([])
    // あるものは足さない
    expect(lib.addClientIdToPlist(PLIST, 'x.apps.googleusercontent.com')).toBe(PLIST)
  })

  it('local.xcconfig（Google ログインの戻り先とチーム ID）', () => {
    expect(lib.isTeamId('ABCDE12345')).toBe(true)
    expect(lib.isTeamId('abcde12345')).toBe(false)
    expect(lib.isTeamId('ABCDE1234')).toBe(false)
    const text = lib.localXcconfig({ reversedClientId: 'com.googleusercontent.apps.1-ios', team: 'ABCDE12345' })
    expect(lib.parseXcconfig(text)).toEqual({
      GOOGLE_REVERSED_CLIENT_ID: 'com.googleusercontent.apps.1-ios',
      DEVELOPMENT_TEAM: 'ABCDE12345',
    })
    expect(lib.localXcconfigProblems(text, 'com.googleusercontent.apps.1-ios')).toEqual([])
    expect(lib.localXcconfigProblems(text, 'com.googleusercontent.apps.2-ios')).toEqual([
      'GOOGLE_REVERSED_CLIENT_ID が GoogleService-Info.plist と違います',
    ])
    expect(lib.localXcconfigProblems('', '')).toHaveLength(2)
  })
})

describe('ビルドの結果', () => {
  it('Xcode の版', () => {
    expect(lib.parseXcodeVersion('Xcode 26.6\nBuild version 17F113\n')).toEqual({ major: 26, text: '26.6' })
    expect(lib.parseXcodeVersion('Xcode 27.1.1\nBuild version 18B5')).toEqual({ major: 27, text: '27.1.1' })
    expect(lib.parseXcodeVersion('xcode-select: error: tool requires Xcode')).toBeNull()
  })

  it('APK の版と署名', () => {
    const badging =
      "package: name='jp.barraquda.novelstudio' versionCode='20400' versionName='2.4.0' platformBuildVersionName='16'"
    expect(lib.parseBadging(badging)).toEqual({
      packageName: 'jp.barraquda.novelstudio',
      versionCode: 20400,
      versionName: '2.4.0',
    })
    const signer = `Signer #1 certificate DN: CN=Novel Studio, C=JP\nSigner #1 certificate SHA-256 digest: ${lib.normalizeSha(SHA256)}\nSigner #1 certificate SHA-1 digest: x`
    expect(lib.parseApksignerSha256(signer)).toBe(lib.normalizeSha(SHA256))
  })
})

describe('コマンド', () => {
  it('引数（--android・--ios を付けなければ、Mac は両方・Windows は Android だけ）', () => {
    expect(lib.parseMobileArgs(['firebase'], 'darwin')).toMatchObject({
      command: 'firebase',
      android: true,
      ios: true,
      defaulted: true,
    })
    // iPhone のアプリは Mac で作るので、Windows では Android だけ
    expect(lib.parseMobileArgs(['firebase'], 'win32')).toMatchObject({ android: true, ios: false, defaulted: true })
    expect(lib.parseMobileArgs(['firebase', '--android'])).toMatchObject({ android: true, ios: false })
    expect(lib.parseMobileArgs(['firebase', '--ios', '--team', 'ABCDE12345'])).toMatchObject({
      android: false,
      ios: true,
      team: 'ABCDE12345',
    })
    expect(lib.parseMobileArgs(['firebase', '--team=ABCDE12345']).team).toBe('ABCDE12345')
    expect(lib.parseMobileArgs(['keystore', '--use', 'D:\\USB\\novel studio.jks']).use).toBe('D:\\USB\\novel studio.jks')
    expect(lib.parseMobileArgs(['android-install', '--serial', 'R58M']).serial).toBe('R58M')
    expect(lib.parseMobileArgs(['doctor', '--nope']).unknown).toEqual(['--nope'])
  })

  it('package.json の npm run mobile:… / android:… / ios:… は scripts/mobile.mjs のコマンド', () => {
    const scripts = JSON.parse(read('package.json')).scripts
    const mobile = read('scripts/mobile.mjs')
    const names = Object.entries(scripts).filter(([k]) => /^(mobile|android|ios):/.test(k))
    expect(names.map(([k]) => k).sort()).toEqual([
      'android:install',
      'android:open',
      'ios:open',
      'mobile:doctor',
      'mobile:firebase',
      'mobile:keystore',
    ])
    for (const [, v] of names) {
      const cmd = /^node scripts\/mobile\.mjs ([a-z-]+)$/.exec(v)?.[1]
      expect(cmd, v).toBeTruthy()
      expect(mobile).toMatch(new RegExp(`(^|\\s)'?${cmd}'?[:,]`, 'm'))
    }
  })
})

describe('docs/MOBILE.md', () => {
  const doc = read('docs/MOBILE.md')
  const headings = doc.split('\n').filter((l) => /^#{2,3} /.test(l))

  it('アプリ・スクリプトが案内する「…」の節がある', () => {
    const sources = [
      'scripts/mobile.mjs',
      'scripts/mobile/lib.mjs',
      'src/platform/update.ts',
      'src/platform/nativeAuth.ts',
      'android/app/build.gradle',
      'ios/App/novelstudio.xcconfig',
    ]
    const refs = new Set(sources.flatMap((f) => [...read(f).matchAll(/MOBILE\.md「([^」]+)」/g)].map((m) => m[1])))
    expect(refs.size).toBeGreaterThan(5)
    for (const ref of refs)
      expect(
        headings.some((h) => h.includes(ref)),
        ref,
      ).toBe(true)
  })

  it('npm run のコマンドをすべて説明する', () => {
    for (const name of ['mobile:doctor', 'mobile:keystore', 'mobile:firebase', 'android:install', 'android:open', 'ios:open'])
      expect(doc, name).toContain(`npm run ${name}`)
  })

  it('ページの中のリンクの行き先がある（GitHub の見出しの id の作り方）', () => {
    const ids = new Set(
      headings.map((h) =>
        h
          .replace(/^#+ /, '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, '')
          .replace(/\s/g, '-'),
      ),
    )
    const links = [...doc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(3)
    for (const link of links) expect(ids.has(link), link).toBe(true)
  })
})

describe('公開リポジトリに入れないもの', () => {
  it('鍵・パスワード・Firebase の設定ファイル・手元の設定は .gitignore にある', () => {
    const ignore = read('.gitignore').split('\n')
    for (const f of [
      'android/keystore.properties',
      '*.jks',
      '*.keystore',
      'android/app/google-services.json',
      'ios/App/App/GoogleService-Info.plist',
      'ios/App/local.xcconfig',
      'connector.local.json',
    ])
      expect(ignore, f).toContain(f)
  })

  it('iPhone の設定は local.xcconfig を読み、Info.plist はそこの URL スキームを使う', () => {
    expect(read('ios/App/novelstudio.xcconfig')).toContain('#include? "local.xcconfig"')
    expect(read('ios/debug.xcconfig')).toContain('#include "App/novelstudio.xcconfig"')
    expect(read('ios/App/App/Info.plist')).toContain('<string>$(GOOGLE_REVERSED_CLIENT_ID)</string>')
  })
})

describe('ネイティブのプロジェクト（cap sync が書くもの）', () => {
  // package.json のプラグイン（@capacitor/core・cli・android・ios は本体）
  const deps = Object.keys(JSON.parse(read('package.json')).dependencies)
  const plugins = deps.filter(
    (d) =>
      (d.startsWith('@capacitor/') || d.startsWith('@capacitor-firebase/')) && !/^@capacitor\/(core|android|ios|cli)$/.test(d),
  )

  it('Android のプロジェクトに、すべてのプラグインが入っている（プラグインを変えたら npx cap sync android）', () => {
    expect(plugins.length).toBeGreaterThanOrEqual(7)
    const settings = read('android/capacitor.settings.gradle')
    for (const p of plugins) expect(settings, p).toContain(`node_modules/${p}/android`)
  })

  it('iPhone のプロジェクトに、すべてのプラグインが入っている（Google ログインだけの形・最低の iOS 16）', () => {
    const pkg = read('ios/App/CapApp-SPM/Package.swift')
    for (const p of plugins.filter((x) => x.startsWith('@capacitor/'))) expect(pkg, p).toContain(`node_modules/${p}"`)
    expect(pkg).toContain(
      '.package(name: "CapacitorFirebaseAuthentication", path: "symlinks/CapacitorFirebaseAuthentication", traits: ["Google"])',
    )
    expect(pkg).toContain('platforms: [.iOS(.v16)]')
    const capVersion = JSON.parse(read('package.json')).dependencies['@capacitor/ios']
    expect(pkg).toContain(`capacitor-swift-pm.git", exact: "${capVersion}"`)
  })
})
