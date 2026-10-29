// iPhone / Android アプリ（2.4）のスクリプト（scripts/mobile.mjs・scripts/mobile/ci.mjs）の部品。
// ファイル・コマンドに触らない純粋な関数だけを置く（scripts/mobile/lib.test.mjs で確かめる）。
// Windows（PowerShell）でも Mac（ターミナル）でも同じに動くよう、パスの作り方は platform を受け取って決める。
import path from 'node:path'

/** アプリ ID（capacitor.config.ts の appId・Android の applicationId・iPhone のバンドル ID） */
export const APP_ID = 'jp.barraquda.novelstudio'
/** Firebase のプロジェクト（.firebaserc の default） */
export const FIREBASE_PROJECT = 'novel-studio-3352e'
/** Firebase に登録するアプリの表示名 */
export const APP_DISPLAY_NAME = 'Novel Studio'
/** 署名の鍵の別名（keytool -alias） */
export const KEY_ALIAS = 'novelstudio'
/** 署名の鍵のファイル名（ホームの NovelStudioKeys の中） */
export const KEYSTORE_FILE = 'novelstudio-release.jks'
export const KEYSTORE_DIR = 'NovelStudioKeys'
/** Xcode の最低の版（Capacitor 8。App Store Connect へ送るのにも 26 以上が要る） */
export const MIN_XCODE = 26

// ---- 版 ----

/** package.json の version（x.y.z）から Android の versionCode・iPhone の CURRENT_PROJECT_VERSION を作る（2.4.0 → 20400） */
export function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''))
  if (!m) throw new Error(`version は x.y.z の形にしてください: ${version}`)
  const [maj, min, pat] = m.slice(1).map(Number)
  if (min > 99 || pat > 99) throw new Error(`version の 2つ目・3つ目は 99 まで: ${version}`)
  return maj * 10000 + min * 100 + pat
}

// ---- 署名の鍵（keytool） ----

/** 指紋（SHA-1・SHA-256）を Firebase に送る形にする（小文字・コロンなし） */
export function normalizeSha(sha) {
  return String(sha ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()
}

/** 指紋を人が読む形にする（大文字・コロン区切り。keytool・Firebase コンソールと同じ） */
export function formatSha(sha) {
  return (
    normalizeSha(sha)
      .toUpperCase()
      .match(/.{1,2}/g)
      ?.join(':') ?? ''
  )
}

/**
 * keytool -list -v の出力から指紋を読む（英語でも日本語でも。ラベルの SHA1・SHA256 はどちらも英字のまま）。
 * 見つからなければ null
 */
export function parseKeytoolFingerprints(text) {
  const t = String(text ?? '')
  const sha1 = /SHA-?1\s*[:：]\s*((?:[0-9A-Fa-f]{2}:){19}[0-9A-Fa-f]{2})/.exec(t)?.[1]
  const sha256 = /SHA-?256\s*[:：]\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/.exec(t)?.[1]
  if (!sha1 || !sha256) return null
  return { sha1: normalizeSha(sha1), sha256: normalizeSha(sha256) }
}

/** keytool の失敗の理由（wrong_password = パスワードが違う、no_alias = 別名が無い、no_file = ファイルが無い） */
export function keytoolProblem(text) {
  const t = String(text ?? '')
  if (/password was incorrect|パスワードが(?:不正|正しくありません)|Given final block not properly padded/i.test(t))
    return 'wrong_password'
  if (/Alias <[^>]*> does not exist|別名<[^>]*>は存在しません/i.test(t)) return 'no_alias'
  if (/FileNotFoundException|NoSuchFileException|Keystore file does not exist|キーストア・ファイルは存在しません/i.test(t))
    return 'no_file'
  return null
}

/** 鍵を作る keytool の引数（パスワードは環境変数 NS_KS_PASS で渡す。コマンドの履歴・画面に残さない） */
export function keytoolGenerateArgs(keystore) {
  return [
    '-J-Duser.language=en',
    '-genkeypair',
    '-storetype',
    'PKCS12',
    '-keystore',
    keystore,
    '-alias',
    KEY_ALIAS,
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '10000',
    '-dname',
    'CN=Novel Studio, C=JP',
    '-storepass:env',
    'NS_KS_PASS',
    '-keypass:env',
    'NS_KS_PASS',
  ]
}

/** 指紋を読む keytool の引数（英語で出させて読む） */
export function keytoolListArgs(keystore, alias = KEY_ALIAS) {
  return ['-J-Duser.language=en', '-list', '-v', '-keystore', keystore, '-alias', alias, '-storepass:env', 'NS_KS_PASS']
}

/**
 * 鍵のパスワードの決まり（keytool は 6 文字以上。keystore.properties に書くので、半角の英数字・記号だけにする）。
 * 問題が無ければ null、あれば理由
 */
export function passwordProblem(password) {
  const p = String(password ?? '')
  if (p.length < 8) return '8 文字以上にしてください'
  if (!/^[\x21-\x7e]+$/.test(p)) return '半角の英数字と記号だけにしてください（空白・日本語は使えません）'
  return null
}

/** keystore.properties の値の書き方（\ と先頭の空白・日本語などを Java の Properties の形でエスケープする） */
export function escapePropertyValue(value) {
  let out = ''
  for (const ch of String(value)) {
    const c = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c > 0x7e) {
      // Properties は ISO-8859-1 で読むので、それ以外は \uXXXX（サロゲートペアは2つに）
      for (const unit of ch.split('')) out += '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')
    } else out += ch
  }
  return out.replace(/^ /, '\\ ')
}

/** Windows の区切り（\）を / にする（keystore.properties・local.properties には / で書く） */
export function toForwardSlashes(p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * android/keystore.properties の中身（app/build.gradle が読む）。storeFile は / 区切りの絶対パス。
 * PKCS12 の鍵は、鍵のパスワードと保管庫のパスワードが同じ
 */
export function keystoreProperties({ storeFile, password, alias = KEY_ALIAS }) {
  return [
    '# Novel Studio の Android アプリの署名の鍵（npm run mobile:keystore が書いた。秘密。リポジトリに入れない・チャットに貼らない）',
    `storeFile=${escapePropertyValue(toForwardSlashes(storeFile))}`,
    `storePassword=${escapePropertyValue(password)}`,
    `keyAlias=${escapePropertyValue(alias)}`,
    `keyPassword=${escapePropertyValue(password)}`,
    '',
  ].join('\n')
}

/** Java の Properties の形を読む（keystore.properties・local.properties。続きの行・\uXXXX にも対応） */
export function parseProperties(text) {
  const out = {}
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '')
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    // 行末の \ は次の行へ続く（\\ は文字の \）
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '')
    let k = 0
    let key = ''
    while (k < line.length && !/[=:\s]/.test(line[k])) {
      if (line[k] === '\\' && k + 1 < line.length) {
        key += line[k] + line[k + 1]
        k += 2
      } else key += line[k++]
    }
    let rest = line.slice(k).replace(/^\s*[=:]?\s*/, '')
    out[unescapeProperty(key)] = unescapeProperty(rest)
  }
  return out
}

function unescapeProperty(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16))
    return { n: '\n', r: '\r', t: '\t', f: '\f' }[e] ?? e
  })
}

/** keystore.properties に要るものがそろっているか（足りない項目の名前の一覧） */
export function keystorePropertiesProblems(props) {
  return ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].filter((k) => !props?.[k])
}

/** android/local.properties の中身（Android Studio・Gradle が SDK の場所を知るため） */
export function localPropertiesText(sdkDir) {
  return `# Android SDK の場所（npm run android:install が書いた。リポジトリに入れない）\nsdk.dir=${escapePropertyValue(toForwardSlashes(sdkDir)).replace(/:/g, '\\:')}\n`
}

// ---- パソコンの中の場所 ----

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix)

/** ホームのフォルダ */
export function homeDir({ platform, env, home }) {
  if (platform === 'win32') return env.USERPROFILE || home
  return env.HOME || home
}

/** 署名の鍵の置き場所（Windows: %USERPROFILE%\NovelStudioKeys\…、Mac: ~/NovelStudioKeys/…） */
export function defaultKeystorePath(ctx) {
  return pathFor(ctx.platform).join(homeDir(ctx), KEYSTORE_DIR, KEYSTORE_FILE)
}

/**
 * Android Studio に入っている Java（JBR）の候補（先にあるものほど優先）。
 * Capacitor 8 は Java 21 が要るので、Android Studio のものを先に使い、JAVA_HOME（古い Java のことがある）は最後にする。
 * CAPACITOR_ANDROID_STUDIO_PATH（cap open android が使う）からも探す
 */
export function jbrCandidates({ platform, env, home }) {
  const p = pathFor(platform)
  const out = []
  const studio = env.CAPACITOR_ANDROID_STUDIO_PATH
  if (platform === 'win32') {
    if (studio) out.push(p.join(p.dirname(p.dirname(studio)), 'jbr'))
    for (const base of [env.ProgramFiles || 'C:\\Program Files', env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')]) {
      if (base) out.push(p.join(base, 'Android', 'Android Studio', 'jbr'), p.join(base, 'Android Studio', 'jbr'))
    }
  } else if (platform === 'darwin') {
    if (studio) out.push(p.join(studio.replace(/\/Contents\/MacOS\/studio$/, ''), 'Contents', 'jbr', 'Contents', 'Home'))
    for (const app of [
      '/Applications/Android Studio.app',
      p.join(homeDir({ platform, env, home }), 'Applications', 'Android Studio.app'),
    ])
      out.push(p.join(app, 'Contents', 'jbr', 'Contents', 'Home'))
  } else {
    const h = homeDir({ platform, env, home })
    if (studio) out.push(p.join(p.dirname(p.dirname(studio)), 'jbr'))
    out.push(p.join(h, 'android-studio', 'jbr'), '/opt/android-studio/jbr', '/usr/local/android-studio/jbr')
  }
  if (env.JAVA_HOME) out.push(env.JAVA_HOME)
  return [...new Set(out)]
}

/** Android SDK の候補（ANDROID_HOME・ANDROID_SDK_ROOT、なければ Android Studio の既定の場所） */
export function sdkCandidates({ platform, env, home }) {
  const p = pathFor(platform)
  const out = []
  if (env.ANDROID_HOME) out.push(env.ANDROID_HOME)
  if (env.ANDROID_SDK_ROOT) out.push(env.ANDROID_SDK_ROOT)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || p.join(homeDir({ platform, env, home }), 'AppData', 'Local')
    out.push(p.join(local, 'Android', 'Sdk'))
  } else if (platform === 'darwin') out.push(p.join(homeDir({ platform, env, home }), 'Library', 'Android', 'sdk'))
  else out.push(p.join(homeDir({ platform, env, home }), 'Android', 'Sdk'))
  return [...new Set(out)]
}

/** 道具のファイル（Windows は .exe）。dir = JBR・SDK の場所 */
export function toolPath(platform, dir, ...parts) {
  const p = pathFor(platform)
  const file = p.join(dir, ...parts)
  return platform === 'win32' ? `${file}.exe` : file
}

export const keytoolIn = (platform, jbr) => toolPath(platform, jbr, 'bin', 'keytool')
export const javaIn = (platform, jbr) => toolPath(platform, jbr, 'bin', 'java')
export const adbIn = (platform, sdk) => toolPath(platform, sdk, 'platform-tools', 'adb')

/** Gradle を動かすコマンド（Windows の gradlew.bat は cmd.exe を通す。Node は .bat を直接は動かせない） */
export function gradleCommand(platform, tasks) {
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', ['gradlew.bat', ...tasks].join(' ')] }
  return { command: './gradlew', args: tasks }
}

/** Android Studio の実行ファイル（cap open android に CAPACITOR_ANDROID_STUDIO_PATH で教える）。jbr の場所から作る */
export function studioFromJbr(platform, jbr) {
  const p = pathFor(platform)
  if (platform === 'win32') return p.join(p.dirname(jbr), 'bin', 'studio64.exe')
  if (platform === 'darwin') return jbr.replace(/\/Contents\/jbr\/Contents\/Home\/?$/, '')
  return p.join(p.dirname(jbr), 'bin', 'studio.sh')
}

// ---- adb ----

/** adb devices -l の出力（state: device = 使える、unauthorized = スマホで許可していない、offline） */
export function parseAdbDevices(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || /^List of devices|^\*/.test(line)) continue
    const m =
      /^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|no permissions|authorizing|connecting)\b(.*)$/.exec(
        line.trim(),
      )
    if (!m) continue
    const model = /\bmodel:(\S+)/.exec(m[3])?.[1]?.replace(/_/g, ' ')
    out.push({ serial: m[1], state: m[2], model: model ?? '' })
  }
  return out
}

/** スマホを待つ時の状態（ready = 入れられる、unauthorized = スマホの画面で許可を待っている、missing = まだ見つからない） */
export function adbWaitState(devices, serial) {
  const mine = serial ? devices.filter((d) => d.serial === serial) : devices
  if (mine.some((d) => d.state === 'device')) return 'ready'
  if (mine.some((d) => d.state === 'unauthorized' || d.state === 'authorizing')) return 'unauthorized'
  return 'missing'
}

/** adb install の出力を見て、失敗の時の日本語の案内を返す（成功・分からない時は null） */
export function explainInstallFailure(text) {
  const t = String(text ?? '')
  if (/\bSuccess\b/.test(t) && !/Failure/.test(t)) return null
  const keep =
    'スマホのアプリは **削除（アンインストール）しないでください**。削除すると、送っていない変更・端末内のデータが消えます。'
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(t))
    return [
      'いま入っているアプリと、署名の鍵が違います（別のパソコンの鍵・Android Studio の既定の鍵で作った版が入っている）。',
      keep,
      '前と同じ鍵（.jks）を使ってください: そのパソコンの鍵をコピーして npm run mobile:keystore -- --use <鍵のファイル> を実行してから、もう一度 npm run android:install（docs/MOBILE.md「Android」の「困ったとき」）。',
    ].join('\n')
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(t))
    return [
      'いま入っているアプリより古い版を入れようとしました。',
      keep,
      'git pull で最新にしてから、もう一度 npm run android:install を実行してください。',
    ].join('\n')
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(t))
    return 'スマホの空き容量が足りません。写真などを整理してから、もう一度試してください。'
  if (/INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_ABORTED/i.test(t))
    return 'スマホの画面でインストールが止められました。スマホに出た確認で「インストール」を選び、もう一度試してください。'
  if (/Failure|failed/i.test(t)) return `インストールできませんでした。上の表示を見てください。\n${keep}`
  return null
}

// ---- Firebase ----

/** firebase-tools の --json の出力（{ status, result }）を読む。前に何か出ていても、最後の JSON を読む */
export function parseFirebaseJson(stdout) {
  const t = String(stdout ?? '').trim()
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const whole = tryParse(t)
  if (whole && typeof whole === 'object') return whole
  const starts = [...t.matchAll(/^\{/gm)].map((m) => m.index).reverse()
  for (const i of starts) {
    const v = tryParse(t.slice(i))
    if (v && typeof v === 'object') return v
  }
  return null
}

/**
 * firebase-tools の失敗の理由（出力と、その回の firebase-debug.log）。login = ログインしていない・切れた（401・invalid_grant）、
 * permission = このプロジェクトを操作できない（別のアカウント。403）。ログインの切れは 403 より先に見る
 */
export function firebaseProblem(text) {
  const t = String(text ?? '')
  if (
    /firebase login|Failed to authenticate|not logged in|invalid_grant|reauth|no longer valid|HTTP Error: 401|UNAUTHENTICATED/i.test(
      t,
    )
  )
    return 'login'
  if (/PERMISSION_DENIED|does not have permission|HTTP Error: 403/i.test(t)) return 'permission'
  return null
}

/** apps:list の結果から、このアプリ（パッケージ名・バンドル ID）を探す */
export function findFirebaseApp(apps, platform, id = APP_ID) {
  const list = Array.isArray(apps) ? apps : []
  return (
    list.find((a) => {
      if (String(a?.platform ?? '').toUpperCase() !== platform) return false
      const name = platform === 'ANDROID' ? (a.packageName ?? a.namespace) : (a.bundleId ?? a.namespace)
      return name === id
    }) ?? null
  )
}

/** apps:android:sha:list の結果に、その指紋があるか */
export function hasSha(certificates, sha) {
  const want = normalizeSha(sha)
  return (Array.isArray(certificates) ? certificates : []).some((c) => normalizeSha(c?.shaHash) === want)
}

/**
 * google-services.json を確かめる（docs/MOBILE.md「Android」）。
 * このアプリの client があり、その oauth_client に、Android（client_type 1）でこの鍵の SHA-1 のものと、Web（client_type 3）のものがあること。
 * sha1 を渡さない時は、Android の oauth_client があることだけを見る
 */
export function googleServicesProblems(json, { packageName = APP_ID, sha1 } = {}) {
  const problems = []
  let data = json
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch {
      return ['google-services.json が JSON として読めません']
    }
  }
  const client = (data?.client ?? []).find((c) => c?.client_info?.android_client_info?.package_name === packageName)
  if (!client) return [`google-services.json に ${packageName} のアプリがありません`]
  const oauth = Array.isArray(client.oauth_client) ? client.oauth_client : []
  const android = oauth.filter((o) => Number(o?.client_type) === 1 && o?.android_info?.package_name === packageName)
  if (android.length === 0) problems.push('Android のログインの設定（OAuth クライアント）がまだできていません')
  else if (sha1 && !android.some((o) => normalizeSha(o.android_info.certificate_hash) === normalizeSha(sha1)))
    problems.push(`この鍵の SHA-1（${formatSha(sha1)}）の設定がまだありません`)
  if (!oauth.some((o) => Number(o?.client_type) === 3)) problems.push('Web のログインの設定（client_type 3）がまだありません')
  return problems
}

/** plist（Firebase が作る XML の形）から文字の値を読む */
export function plistString(text, key) {
  const re = new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</key>\\s*<string>([^<]*)</string>`)
  return re.exec(String(text ?? ''))?.[1]?.trim() ?? ''
}

/** CLIENT_ID（xxx.apps.googleusercontent.com）から REVERSED_CLIENT_ID（com.googleusercontent.apps.xxx）を作る */
export function reverseClientId(clientId) {
  return String(clientId ?? '')
    .split('.')
    .reverse()
    .join('.')
}

/** GoogleService-Info.plist を確かめる。問題の一覧と、読めた値 */
export function servicePlistCheck(text, bundleId = APP_ID) {
  const clientId = plistString(text, 'CLIENT_ID')
  const reversed = plistString(text, 'REVERSED_CLIENT_ID')
  const bundle = plistString(text, 'BUNDLE_ID')
  const problems = []
  if (!/<plist\b/.test(String(text ?? ''))) problems.push('GoogleService-Info.plist の形ではありません')
  if (bundle && bundle !== bundleId) problems.push(`バンドル ID が ${bundleId} ではありません（${bundle}）`)
  if (!clientId) problems.push('CLIENT_ID がありません（Google ログインの設定がまだできていません）')
  if (!reversed) problems.push('REVERSED_CLIENT_ID がありません')
  else if (!reversed.startsWith('com.googleusercontent.apps.')) problems.push('REVERSED_CLIENT_ID の形が違います')
  else if (clientId && reverseClientId(clientId) !== reversed) problems.push('CLIENT_ID と REVERSED_CLIENT_ID が合っていません')
  return { problems, clientId, reversedClientId: reversed }
}

/** GoogleService-Info.plist に CLIENT_ID・REVERSED_CLIENT_ID を足す（--ios-client-id。Firebase が作らなかった時だけの最後の手段） */
export function addClientIdToPlist(text, clientId) {
  const t = String(text)
  const entries = [
    ['CLIENT_ID', clientId],
    ['REVERSED_CLIENT_ID', reverseClientId(clientId)],
  ]
    .filter(([k]) => !plistString(t, k))
    .map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>\n`)
    .join('')
  if (!entries) return t
  return t.replace(/<dict>[^\S\n]*\n?/, (m) => `${m.trimEnd()}\n${entries}`)
}

/** Apple のチーム ID（英大文字と数字の 10 文字） */
export function isTeamId(v) {
  return /^[A-Z0-9]{10}$/.test(String(v ?? ''))
}

/** ios/App/local.xcconfig の中身（novelstudio.xcconfig が読む。リポジトリに入れない） */
export function localXcconfig({ reversedClientId, team }) {
  return [
    '// Novel Studio の iPhone アプリの手元の設定（npm run mobile:firebase -- --ios が書いた。リポジトリに入れない）',
    '// Google ログインの戻り先（GoogleService-Info.plist の REVERSED_CLIENT_ID）',
    `GOOGLE_REVERSED_CLIENT_ID = ${reversedClientId}`,
    '// Apple のチーム ID（Xcode の署名に使う。秘密ではない）',
    `DEVELOPMENT_TEAM = ${team}`,
    '',
  ].join('\n')
}

/** xcconfig の値を読む（// のコメントは飛ばす） */
export function parseXcconfig(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/** local.xcconfig を確かめる（plist の REVERSED_CLIENT_ID と同じで、チーム ID があること） */
export function localXcconfigProblems(text, reversedClientId) {
  const v = parseXcconfig(text)
  const problems = []
  if (!v.GOOGLE_REVERSED_CLIENT_ID) problems.push('GOOGLE_REVERSED_CLIENT_ID がありません')
  else if (reversedClientId && v.GOOGLE_REVERSED_CLIENT_ID !== reversedClientId)
    problems.push('GOOGLE_REVERSED_CLIENT_ID が GoogleService-Info.plist と違います')
  if (!isTeamId(v.DEVELOPMENT_TEAM)) problems.push('DEVELOPMENT_TEAM（チーム ID、10文字）がありません')
  return problems
}

// ---- Xcode・ビルドの結果 ----

/** xcodebuild -version の出力から版（26.6 → { major: 26, text: '26.6' }）。読めなければ null */
export function parseXcodeVersion(text) {
  const m = /Xcode\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text ?? ''))
  if (!m) return null
  return { major: Number(m[1]), text: m.slice(1).filter(Boolean).join('.') }
}

/**
 * xcodebuild -version の結果（{ code, out }）。Xcode の版、または使えない理由（clt = Xcode ではなく Command Line Tools が選ばれている。
 * Git を入れた時に入る。missing = Xcode が無い）。mobile:doctor と ios:open で同じに見分ける
 */
export function xcodeStatus({ code, out }) {
  const version = code === 0 ? parseXcodeVersion(out) : null
  if (version) return { version }
  return { problem: /command line tools/i.test(String(out ?? '')) ? 'clt' : 'missing' }
}

/** aapt2 dump badging の出力から、パッケージ名と版 */
export function parseBadging(text) {
  const t = String(text ?? '')
  const name = /package: name='([^']+)'/.exec(t)?.[1] ?? ''
  const code = /versionCode='(\d+)'/.exec(t)?.[1]
  const vname = /versionName='([^']*)'/.exec(t)?.[1] ?? ''
  return { packageName: name, versionCode: code ? Number(code) : null, versionName: vname }
}

/** apksigner verify --print-certs の出力から、署名した鍵の SHA-256 */
export function parseApksignerSha256(text) {
  const m = /certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(String(text ?? ''))
  return m ? normalizeSha(m[1]) : null
}

// ---- コマンドの引数 ----

/**
 * scripts/mobile.mjs の引数。command と、--android・--ios、値を取る --team・--use・--serial・--ios-client-id。
 * --android・--ios のどちらも付けない時（defaulted）は、Mac では両方、Windows などでは Android だけ（iPhone のアプリは Mac で作るので）
 */
export function parseMobileArgs(argv, platform = process.platform) {
  const out = {
    command: '',
    android: false,
    ios: false,
    defaulted: false,
    team: '',
    use: '',
    serial: '',
    iosClientId: '',
    unknown: [],
  }
  const takes = { '--team': 'team', '--use': 'use', '--serial': 'serial', '--ios-client-id': 'iosClientId' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    if (eq && takes[eq[1]]) out[takes[eq[1]]] = eq[2]
    else if (takes[a]) out[takes[a]] = argv[++i] ?? ''
    else if (a === '--android') out.android = true
    else if (a === '--ios') out.ios = true
    else if (!a.startsWith('-') && !out.command) out.command = a
    else out.unknown.push(a)
  }
  if (!out.android && !out.ios) {
    out.defaulted = true
    out.android = true
    out.ios = platform === 'darwin'
  }
  return out
}

/** Node の版（22 以上で動く。24 を勧める） */
export function nodeMajor(version = process.versions.node) {
  return Number(String(version).split('.')[0])
}
