#!/usr/bin/env node
// iPhone / Android アプリ（2.4）の準備とインストール。Windows の PowerShell でも Mac のターミナルでも同じに動く（docs/MOBILE.md）。
//   npm run mobile:doctor                          何がそろっているかを表示する（パスワード・ファイルの中身は出さない）
//   npm run mobile:keystore                        Android の署名の鍵を作る（パスワードは画面に出さずに2回入力）
//   npm run mobile:keystore -- --use <鍵のファイル>  別のパソコンで作った鍵を、このパソコンでも使う
//   npm run mobile:firebase [-- --android | --ios] [--team <チームID>]
//                                                  Firebase にアプリを登録し、ログインの設定ファイルを取ってくる（先に npx firebase login）。
//                                                  どちらも付けない時は、Mac では両方、Windows では Android だけ
//   npm run android:install [-- --serial <端末>]   ビルドして、USB でつないだ Android のスマホに上書きで入れる
//   npm run android:open                           ビルドして Android Studio で開く
//   npm run ios:open                               （Mac だけ）ビルドして Xcode で開く
// 秘密（鍵のパスワード）はコマンドの引数・画面に出さない。keytool には環境変数 NS_KS_PASS で渡す。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { binOf, ng, ok, runNode, say } from '../connector/scripts/lib.mjs'
import * as lib from './mobile/lib.mjs'
import { copySecret, makeSecretDir, protectSecret, writeSecret } from './mobile/secret.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ctx = { platform: process.platform, env: process.env, home: os.homedir() }
const files = {
  keystoreProperties: path.join(repoDir, 'android', 'keystore.properties'),
  localProperties: path.join(repoDir, 'android', 'local.properties'),
  googleServices: path.join(repoDir, 'android', 'app', 'google-services.json'),
  servicePlist: path.join(repoDir, 'ios', 'App', 'App', 'GoogleService-Info.plist'),
  localXcconfig: path.join(repoDir, 'ios', 'App', 'local.xcconfig'),
  connectorLocal: path.join(repoDir, 'connector.local.json'),
  releaseApk: path.join(repoDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
}
const rel = (p) => path.relative(repoDir, p).replace(/\\/g, '/')

/** 利用者に見せて止める失敗（スタックトレースを出さない） */
class Stop extends Error {}

// ---- 道具 ----

/** コマンドを動かす（シェルを通さない）。capture = 出力を控える（画面には出さない） */
function exec(command, args, { cwd = repoDir, env = process.env, capture = false } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ code: -1, out: String(e?.message ?? e) })
      return
    }
    if (capture) {
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
    }
    child.on('error', (e) => resolve({ code: -1, out: `${out}${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

const exists = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
const firstExisting = (paths, test = exists) => paths.find((p) => p && test(p)) ?? null

function findJbr() {
  return firstExisting(lib.jbrCandidates(ctx), (p) => exists(lib.keytoolIn(ctx.platform, p)))
}
function findSdk() {
  return firstExisting(lib.sdkCandidates(ctx), (p) => exists(path.join(p, 'platform-tools')) || exists(path.join(p, 'platforms')))
}
/** keytool（Android Studio の JBR のもの。無ければ PATH の keytool） */
function keytoolPath() {
  const jbr = findJbr()
  return jbr ? lib.keytoolIn(ctx.platform, jbr) : 'keytool'
}

/** パスワードを、画面に出さずに入力してもらう */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Stop('パスワードを入力できません。PowerShell（Windows）かターミナル（Mac）で直接実行してください。'))
      return
    }
    process.stdout.write(question)
    let value = ''
    const finish = (err) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') return finish(new Stop('中止しました。'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function askText(question) {
  if (!process.stdin.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

function readKeystoreProperties() {
  if (!exists(files.keystoreProperties))
    throw new Stop(
      `署名の鍵の設定（${rel(files.keystoreProperties)}）がありません。先に npm run mobile:keystore を実行してください（docs/MOBILE.md「Android」）。`,
    )
  const props = lib.parseProperties(fs.readFileSync(files.keystoreProperties, 'utf8'))
  const missing = lib.keystorePropertiesProblems(props)
  if (missing.length)
    throw new Stop(
      `${rel(files.keystoreProperties)} に ${missing.join('・')} がありません。npm run mobile:keystore -- --use <鍵のファイル> で書き直してください。`,
    )
  if (!exists(props.storeFile))
    throw new Stop(
      `鍵のファイルが見つかりません: ${props.storeFile}\n  鍵を移した時は npm run mobile:keystore -- --use <鍵のファイル> で場所を書き直してください（鍵は作り直さない）。`,
    )
  return props
}

/** 鍵の指紋（SHA-1・SHA-256）。パスワードは環境変数で渡す */
async function fingerprints(storeFile, password, alias = lib.KEY_ALIAS) {
  const r = await exec(keytoolPath(), lib.keytoolListArgs(storeFile, alias), {
    capture: true,
    env: { ...process.env, NS_KS_PASS: password },
  })
  const fp = r.code === 0 ? lib.parseKeytoolFingerprints(r.out) : null
  if (fp) return fp
  const problem = lib.keytoolProblem(r.out)
  if (problem === 'wrong_password') throw new Stop('鍵のパスワードが違います。')
  if (problem === 'no_alias')
    throw new Stop(`この鍵のファイルには ${alias} の鍵がありません（Novel Studio の鍵ではないかもしれません）。`)
  if (r.code === -1)
    throw new Stop('keytool が見つかりません。Android Studio を入れてください（docs/MOBILE.md「Android」の 1）。')
  throw new Stop(`鍵を読めませんでした:\n${r.out.trim().split('\n').slice(-5).join('\n')}`)
}

function showFingerprints(fp) {
  say(`  SHA-1:   ${lib.formatSha(fp.sha1)}`)
  say(`  SHA-256: ${lib.formatSha(fp.sha256)}`)
  say('  （指紋は秘密ではありません。Firebase に登録します）')
}

function nodeBin(pkg, bin) {
  const p = binOf(pkg, bin, repoDir)
  if (!p) throw new Stop(`${pkg} が入っていません。リポジトリの直下で npm ci を実行してから、もう一度試してください。`)
  return p
}

async function step(label, script, args, env) {
  say(`\n▶ ${label}`)
  const r = await runNode(script, args, { cwd: repoDir, env })
  if (r.code !== 0) throw new Stop(`${label} に失敗しました（上の表示を見てください）。`)
}

function warnConnector() {
  if (exists(files.connectorLocal)) return
  say(
    '\n注意: このパソコンに connector.local.json がありません。アプリの「設定 → Claude 連携」が「コネクタ未設定」になります（執筆・同期には関係ありません）。' +
      '\n  Claude 用のコネクタを使っている時は、npm run connector:setup をしたパソコンから connector.local.json をリポジトリの直下にコピーしてください（秘密ではありません）。',
  )
}

/** アプリの画面（dist-native）を作って、Android・iPhone のプロジェクトに写す。plain な cap sync は使わない（Windows で iOS の部分が失敗する） */
async function buildAndSync(platform) {
  warnConnector()
  await step('型の確かめ（tsc -b）', nodeBin('typescript', 'tsc'), ['-b'])
  await step('アプリの画面のビルド（vite build --mode native）', nodeBin('vite', 'vite'), ['build', '--mode', 'native'])
  await step(
    `${platform === 'ios' ? 'iPhone' : 'Android'} のプロジェクトに写す（cap sync ${platform}）`,
    nodeBin('@capacitor/cli', 'cap'),
    ['sync', platform],
  )
}

// ---- Firebase ----

function firebaseCli() {
  return nodeBin('firebase-tools', 'firebase')
}

async function firebase(args) {
  const r = await runNode(firebaseCli(), [...args, '--project', lib.FIREBASE_PROJECT, '--json', '--non-interactive'], {
    cwd: repoDir,
    capture: true,
    quiet: true,
  })
  const json = lib.parseFirebaseJson(r.stdout)
  if (json?.status === 'success') return json.result
  const why = json?.error ?? `${r.stderr}\n${r.stdout}`.trim()
  const problem = lib.firebaseProblem(why)
  if (problem === 'login')
    throw new Stop(
      'Firebase にログインしていません（切れています）。npx firebase login を実行して（ブラウザで Google アカウントを選ぶ）、もう一度試してください。',
    )
  if (problem === 'permission')
    throw new Stop(
      `Firebase のプロジェクト ${lib.FIREBASE_PROJECT} を操作できません。Firebase のプロジェクトを作った Google アカウントでログインしてください（npx firebase login:add）。`,
    )
  throw new Stop(`firebase ${args[0]} に失敗しました: ${String(why).split('\n').slice(-4).join('\n')}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function firebaseAndroid() {
  say('\n■ Android')
  const props = readKeystoreProperties()
  const fp = await fingerprints(props.storeFile, props.storePassword, props.keyAlias)
  ok('署名の鍵を読みました')
  showFingerprints(fp)

  let app = lib.findFirebaseApp(await firebase(['apps:list', 'ANDROID']), 'ANDROID')
  if (app) ok(`Firebase の Android アプリ: ${app.appId}`)
  else {
    app = await firebase(['apps:create', 'ANDROID', lib.APP_DISPLAY_NAME, '--package-name', lib.APP_ID])
    ok(`Firebase に Android アプリを登録しました: ${app.appId}`)
  }

  let certs = await firebase(['apps:android:sha:list', app.appId])
  let added = false
  for (const sha of [fp.sha1, fp.sha256]) {
    if (lib.hasSha(certs, sha)) continue
    await firebase(['apps:android:sha:create', app.appId, sha])
    added = true
  }
  if (added) certs = await firebase(['apps:android:sha:list', app.appId])
  if (!lib.hasSha(certs, fp.sha1) || !lib.hasSha(certs, fp.sha256))
    throw new Stop('鍵の指紋を Firebase に登録できませんでした。docs/MOBILE.md「Firebase の手作業での設定」を見てください。')
  ok('鍵の指紋（SHA-1・SHA-256）を Firebase に登録しました')

  // 指紋を足した直後は、ログインの設定（OAuth クライアント）がまだできていないことがある。少し待って取り直す
  let problems = []
  for (let attempt = 0; attempt < (added ? 5 : 1); attempt++) {
    if (attempt > 0) {
      say('  Firebase の準備を待っています…')
      await sleep(15000)
    }
    const config = await firebase(['apps:sdkconfig', 'ANDROID', app.appId])
    problems = lib.googleServicesProblems(config?.fileContents ?? '', { sha1: fp.sha1 })
    if (problems.length === 0) {
      fs.writeFileSync(files.googleServices, config.fileContents)
      ok(`${rel(files.googleServices)} を書きました（秘密ではありません。リポジトリには入れません）`)
      return true
    }
  }
  for (const p of problems) ng(p)
  say(
    '  Firebase の準備がまだ終わっていないことがあります。1〜2分待ってから、もう一度 npm run mobile:firebase -- --android を実行してください。' +
      '\n  何度やっても同じ時は docs/MOBILE.md「Firebase の手作業での設定」（Google ログインの設定を保存し直す）を見てください。',
  )
  return false
}

async function firebaseIos(opts) {
  say('\n■ iPhone')
  let app = lib.findFirebaseApp(await firebase(['apps:list', 'IOS']), 'IOS')
  if (app) ok(`Firebase の iOS アプリ: ${app.appId}`)
  else {
    app = await firebase(['apps:create', 'IOS', lib.APP_DISPLAY_NAME, '--bundle-id', lib.APP_ID])
    ok(`Firebase に iOS アプリを登録しました: ${app.appId}`)
  }
  const config = await firebase(['apps:sdkconfig', 'IOS', app.appId])
  let plist = String(config?.fileContents ?? '')
  if (opts.iosClientId) {
    if (!/\.apps\.googleusercontent\.com$/.test(opts.iosClientId))
      throw new Stop('--ios-client-id は …apps.googleusercontent.com の形で指定してください。')
    plist = lib.addClientIdToPlist(plist, opts.iosClientId)
  }
  const check = lib.servicePlistCheck(plist)
  if (check.problems.length) {
    for (const p of check.problems) ng(p)
    say(
      '  1〜2分待ってから、もう一度 npm run mobile:firebase -- --ios を実行してください。' +
        '\n  何度やっても同じ時は docs/MOBILE.md「Firebase の手作業での設定」を見てください。',
    )
    return false
  }
  fs.writeFileSync(files.servicePlist, plist)
  ok(`${rel(files.servicePlist)} を書きました（秘密ではありません。リポジトリには入れません）`)

  const before = exists(files.localXcconfig) ? lib.parseXcconfig(fs.readFileSync(files.localXcconfig, 'utf8')) : {}
  let team = String(opts.team || before.DEVELOPMENT_TEAM || '')
    .trim()
    .toUpperCase()
  while (!lib.isTeamId(team)) {
    if (team) ng(`チーム ID は英大文字と数字の 10 文字です: ${team}`)
    if (!process.stdin.isTTY)
      throw new Stop('チーム ID を付けて実行してください: npm run mobile:firebase -- --ios --team <チームID>')
    team = (
      await askText('Apple のチーム ID（developer.apple.com/account の「メンバーシップの詳細」。英大文字と数字の 10 文字）: ')
    ).toUpperCase()
    if (!team) throw new Stop('中止しました。')
  }
  fs.writeFileSync(files.localXcconfig, lib.localXcconfig({ reversedClientId: check.reversedClientId, team }))
  ok(`${rel(files.localXcconfig)} を書きました（Google ログインの戻り先とチーム ID）`)
  return true
}

// ---- 各コマンド ----

async function doctor() {
  say('Novel Studio のアプリの準備（パスワード・ファイルの中身は表示しません）\n')
  const node = lib.nodeMajor()
  ;(node >= 22 ? ok : ng)(
    `Node.js ${process.versions.node}${node >= 22 ? (node < 24 ? '（24 LTS を勧めます）' : '') : '（22 以上が要ります）'}`,
  )
  const capVersion = (pkg) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoDir, 'node_modules', pkg, 'package.json'), 'utf8')).version
    } catch {
      return null
    }
  }
  const cap = capVersion('@capacitor/cli')
  ;(cap ? ok : ng)(cap ? `Capacitor ${cap}` : 'Capacitor が入っていません（npm ci）')

  say('\nAndroid')
  const jbr = findJbr()
  ;(jbr ? ok : ng)(jbr ? `Android Studio の Java: ${jbr}` : 'Android Studio が見つかりません（docs/MOBILE.md「Android」の 1）')
  const sdk = findSdk()
  ;(sdk ? ok : ng)(
    sdk
      ? `Android SDK: ${sdk}`
      : 'Android SDK が見つかりません（Android Studio の最初の画面の Setup Wizard を「Standard」で終える）',
  )
  const adb = sdk && exists(lib.adbIn(ctx.platform, sdk)) ? lib.adbIn(ctx.platform, sdk) : null
  ;(adb ? ok : ng)(adb ? `adb: ${adb}` : 'adb が見つかりません（Android SDK の platform-tools）')
  if (!exists(files.keystoreProperties))
    ng(`署名の鍵の設定（${rel(files.keystoreProperties)}）がありません（npm run mobile:keystore）`)
  else {
    const props = lib.parseProperties(fs.readFileSync(files.keystoreProperties, 'utf8'))
    const missing = lib.keystorePropertiesProblems(props)
    if (missing.length) ng(`${rel(files.keystoreProperties)} に ${missing.join('・')} がありません`)
    else (exists(props.storeFile) ? ok : ng)(`署名の鍵: ${props.storeFile}${exists(props.storeFile) ? '' : '（見つかりません）'}`)
  }
  if (!exists(files.googleServices)) ng(`${rel(files.googleServices)} がありません（npm run mobile:firebase -- --android）`)
  else {
    const problems = lib.googleServicesProblems(fs.readFileSync(files.googleServices, 'utf8'))
    if (problems.length) for (const p of problems) ng(`${rel(files.googleServices)}: ${p}`)
    else ok(`${rel(files.googleServices)}（鍵の指紋は android:install の時に確かめます）`)
  }

  say('\niPhone')
  if (ctx.platform !== 'darwin') say('  （iPhone のアプリは Mac でだけ作れます）')
  else {
    const r = await exec('xcodebuild', ['-version'], { capture: true })
    const v = r.code === 0 ? lib.parseXcodeVersion(r.out) : null
    if (!v) ng('Xcode が見つかりません（App Store から入れて、一度起動する）')
    else
      (v.major >= lib.MIN_XCODE ? ok : ng)(
        `Xcode ${v.text}${v.major >= lib.MIN_XCODE ? '' : `（${lib.MIN_XCODE} 以上が要ります）`}`,
      )
  }
  let reversed = ''
  if (!exists(files.servicePlist)) ng(`${rel(files.servicePlist)} がありません（npm run mobile:firebase -- --ios）`)
  else {
    const check = lib.servicePlistCheck(fs.readFileSync(files.servicePlist, 'utf8'))
    reversed = check.reversedClientId
    if (check.problems.length) for (const p of check.problems) ng(`${rel(files.servicePlist)}: ${p}`)
    else ok(rel(files.servicePlist))
  }
  if (!exists(files.localXcconfig)) ng(`${rel(files.localXcconfig)} がありません（npm run mobile:firebase -- --ios）`)
  else {
    const problems = lib.localXcconfigProblems(fs.readFileSync(files.localXcconfig, 'utf8'), reversed)
    if (problems.length) for (const p of problems) ng(`${rel(files.localXcconfig)}: ${p}`)
    else ok(`${rel(files.localXcconfig)}（Google ログインの戻り先・チーム ID）`)
  }

  say('\n共通')
  ;(exists(files.connectorLocal) ? ok : ng)(
    exists(files.connectorLocal)
      ? 'connector.local.json（Claude 用のコネクタの URL）'
      : 'connector.local.json がありません（Claude 連携を使わないなら不要）',
  )
}

async function keystore(opts) {
  const target = lib.defaultKeystorePath(ctx)
  if (!findJbr() && (await exec('keytool', ['-help'], { capture: true })).code === -1)
    throw new Stop('keytool が見つかりません。Android Studio を入れてください（docs/MOBILE.md「Android」の 1）。')

  if (opts.use) {
    const src = path.resolve(opts.use)
    if (!exists(src)) throw new Stop(`鍵のファイルが見つかりません: ${src}`)
    const password = await askHidden('鍵のパスワード（画面には出ません）: ')
    const fp = await fingerprints(src, password)
    let storeFile = src
    if (path.resolve(src) !== path.resolve(target)) {
      if (exists(target) && !fs.readFileSync(target).equals(fs.readFileSync(src)))
        throw new Stop(
          `${target} に別の鍵があります。どちらが正しい鍵か確かめてください（消すと、その鍵で入れたアプリを上書きできなくなります）。`,
        )
      // 鍵のフォルダは自分だけが入れる形（0700）、鍵は自分だけが読める形（0600）で置く
      copySecret(src, target)
      storeFile = target
      ok(`鍵を ${target} にコピーしました`)
    } else protectSecret(target)
    writeSecret(files.keystoreProperties, lib.keystoreProperties({ storeFile, password }))
    ok(`${rel(files.keystoreProperties)} を書きました（秘密。リポジトリには入りません）`)
    showFingerprints(fp)
    say('\n次は npm run mobile:firebase -- --android（このパソコンでは初めての時だけ）→ npm run android:install')
    return
  }

  if (exists(files.keystoreProperties))
    throw new Stop(
      `署名の鍵の設定はもうあります（${rel(files.keystoreProperties)}）。鍵を作り直すと、入れてあるアプリを上書きできなくなるので作りません。` +
        '\n  別の鍵のファイルに切り替える時は npm run mobile:keystore -- --use <鍵のファイル>',
    )
  if (exists(target))
    throw new Stop(`鍵のファイルがもうあります: ${target}\n  この鍵を使う時は npm run mobile:keystore -- --use "${target}"`)

  say('Android アプリの署名の鍵を作ります。パスワードは画面に出ません（入力しても何も表示されないのが正常です）。')
  say('パスワードは、パスワード管理アプリなどに必ず控えてください。忘れるとアプリを更新できなくなります。\n')
  let password = ''
  for (let tries = 0; !password; tries++) {
    if (tries >= 3) throw new Stop('中止しました。')
    const first = await askHidden('鍵のパスワード（8文字以上、半角の英数字と記号）: ')
    const problem = lib.passwordProblem(first)
    if (problem) {
      ng(problem)
      continue
    }
    if ((await askHidden('もう一度同じパスワード: ')) !== first) {
      ng('2回のパスワードが違います。もう一度入力してください')
      continue
    }
    password = first
  }
  makeSecretDir(path.dirname(target))
  const r = await exec(keytoolPath(), lib.keytoolGenerateArgs(target), {
    capture: true,
    env: { ...process.env, NS_KS_PASS: password },
  })
  if (r.code !== 0 || !exists(target)) throw new Stop(`鍵を作れませんでした:\n${r.out.trim().split('\n').slice(-5).join('\n')}`)
  // keytool は誰でも読める形（0644）で作る
  protectSecret(target)
  writeSecret(files.keystoreProperties, lib.keystoreProperties({ storeFile: target, password }))
  const fp = await fingerprints(target, password)
  ok(`鍵を作りました: ${target}`)
  ok(`${rel(files.keystoreProperties)} を書きました（秘密。リポジトリには入りません）`)
  showFingerprints(fp)
  say(
    [
      '',
      '★ 大事: この鍵のファイルを、USB メモリとクラウド（iCloud Drive・Google ドライブなど）の2か所にコピーしてください。',
      '  パスワードはパスワード管理アプリに入れてください。鍵かパスワードを失うと、アプリを更新できなくなります',
      '  （入れ直すとスマホの中のデータが消えます）。鍵とパスワードはチャットに貼らないでください。',
      '',
      '次は npm run mobile:firebase -- --android',
    ].join('\n'),
  )
}

async function firebaseCommand(opts) {
  say(`Firebase のプロジェクト ${lib.FIREBASE_PROJECT} にアプリを登録して、ログインの設定ファイルを取ってきます。`)
  let allOk = true
  if (opts.android) {
    try {
      allOk = (await firebaseAndroid()) && allOk
    } catch (e) {
      // Mac で両方の時は、Android の準備（鍵）がまだでも iPhone は続ける
      if (!(e instanceof Stop) || !opts.ios || !opts.defaulted) throw e
      ng(e.message)
      allOk = false
    }
  }
  if (opts.ios) allOk = (await firebaseIos(opts)) && allOk
  else if (opts.defaulted) say('\n（iPhone の設定は Mac で npm run mobile:firebase -- --ios --team <チームID>）')
  if (!allOk) process.exitCode = 1
  else
    say(
      `\n完了しました。次は ${opts.android ? 'npm run android:install（Android）' : ''}${opts.android && opts.ios ? '、' : ''}${opts.ios ? 'Mac で npm run ios:open（iPhone）' : ''}`,
    )
}

/** Android のビルドの前の確かめ。Gradle・adb に渡す環境変数を返す */
async function androidPreflight() {
  const props = readKeystoreProperties()
  const jbr = findJbr()
  if (!jbr)
    throw new Stop('Android Studio が見つかりません。入れてから、もう一度試してください（docs/MOBILE.md「Android」の 1）。')
  const sdk = findSdk()
  if (!sdk)
    throw new Stop(
      'Android SDK が見つかりません。Android Studio を開き、最初の画面の Setup Wizard を「Standard」で終えてください。',
    )
  if (!exists(files.googleServices))
    throw new Stop(`${rel(files.googleServices)} がありません。先に npm run mobile:firebase -- --android を実行してください。`)
  const fp = await fingerprints(props.storeFile, props.storePassword, props.keyAlias)
  const problems = lib.googleServicesProblems(fs.readFileSync(files.googleServices, 'utf8'), { sha1: fp.sha1 })
  if (problems.length) {
    for (const p of problems) ng(`${rel(files.googleServices)}: ${p}`)
    throw new Stop('このままではログインできません。npm run mobile:firebase -- --android をもう一度実行してください。')
  }
  ok('署名の鍵・Firebase の設定・Android Studio・SDK がそろっています')
  if (!exists(files.localProperties)) fs.writeFileSync(files.localProperties, lib.localPropertiesText(sdk))
  // Windows の環境変数の名前は Path のことがある（同じ名前を2つ渡さない）
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const PATH = [path.join(jbr, 'bin'), path.join(sdk, 'platform-tools'), process.env[pathKey] ?? ''].join(path.delimiter)
  return { jbr, sdk, env: { ...process.env, JAVA_HOME: jbr, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, [pathKey]: PATH } }
}

async function chooseDevice(adb, env, serial) {
  const r = await exec(adb, ['devices', '-l'], { capture: true, env })
  if (r.code !== 0) throw new Stop(`adb を動かせませんでした:\n${r.out.trim()}`)
  const all = lib.parseAdbDevices(r.out)
  const ready = all.filter((d) => d.state === 'device')
  if (serial) {
    const d = ready.find((x) => x.serial === serial)
    if (!d) throw new Stop(`--serial ${serial} のスマホが見つかりません。`)
    return d
  }
  if (ready.length === 1) return ready[0]
  if (ready.length === 0) {
    if (all.some((d) => d.state === 'unauthorized'))
      throw new Stop(
        'スマホが USB デバッグを許可していません。スマホの画面の「USB デバッグを許可しますか？」で「このパソコンからの接続を常に許可」にチェックして「許可」を押し、もう一度試してください。',
      )
    throw new Stop(
      [
        'スマホが見つかりません。次を確かめてから、もう一度試してください（docs/MOBILE.md「Android」の 4）。',
        '  - USB ケーブルでパソコンとつないでいる（充電だけのケーブルは使えません）',
        '  - スマホの 設定 > システム > 開発者向けオプション > USB デバッグ がオン',
        '  - スマホのロックを外している',
        ...(ctx.platform === 'win32'
          ? ['  - Windows: Google USB Driver を入れた（Android Studio の SDK Manager > SDK Tools）']
          : []),
      ].join('\n'),
    )
  }
  say('\nつないでいるスマホが複数あります。')
  ready.forEach((d, i) => say(`  ${i + 1}. ${d.model || '(機種名なし)'}  ${d.serial}`))
  const n = Number(await askText('入れるスマホの番号: '))
  if (!Number.isInteger(n) || n < 1 || n > ready.length) throw new Stop('中止しました（--serial <端末> でも選べます）。')
  return ready[n - 1]
}

async function androidInstall(opts) {
  const { sdk, env } = await androidPreflight()
  await buildAndSync('android')
  say('\n▶ Android のアプリのビルド（gradlew assembleRelease。初めての時は部品のダウンロードで 5〜15 分かかります）')
  const g = lib.gradleCommand(ctx.platform, ['assembleRelease'])
  const built = await exec(g.command, g.args, { cwd: path.join(repoDir, 'android'), env })
  if (built.code !== 0 || !exists(files.releaseApk))
    throw new Stop(
      'Android のアプリのビルドに失敗しました（上の表示を見てください）。' +
        (ctx.platform === 'win32'
          ? '\n  「パスが長すぎる」「Filename longer than 260 characters」と出た時は、リポジトリを C:\\dev\\app-for-novel のような短い場所に置き直してください（docs/MOBILE.md）。'
          : ''),
    )
  ok(`できました: ${rel(files.releaseApk)}`)
  const adb = lib.adbIn(ctx.platform, sdk)
  const device = await chooseDevice(adb, env, opts.serial)
  say(`\n▶ ${device.model || device.serial} に上書きで入れます（adb install -r。スマホのデータはそのまま）`)
  const r = await exec(adb, ['-s', device.serial, 'install', '-r', files.releaseApk], { capture: true, env })
  process.stdout.write(r.out)
  const problem =
    lib.explainInstallFailure(r.out) ?? (r.code !== 0 ? 'インストールできませんでした（上の表示を見てください）。' : null)
  if (problem) throw new Stop(problem)
  say('\n入れました。スマホで Novel Studio を開いてください。')
}

async function androidOpen() {
  const { jbr } = await androidPreflight()
  await buildAndSync('android')
  const studio = lib.studioFromJbr(ctx.platform, jbr)
  const env = exists(studio) && !process.env.CAPACITOR_ANDROID_STUDIO_PATH ? { CAPACITOR_ANDROID_STUDIO_PATH: studio } : {}
  await step('Android Studio で開く（cap open android）', nodeBin('@capacitor/cli', 'cap'), ['open', 'android'], env)
  say('\nAndroid Studio の ▶ で、つないだスマホに入れられます（同じ鍵で署名します）。')
}

async function iosOpen() {
  if (ctx.platform !== 'darwin') throw new Stop('iPhone のアプリは Mac でだけ作れます（docs/MOBILE.md「iPhone」）。')
  const r = await exec('xcodebuild', ['-version'], { capture: true })
  const v = r.code === 0 ? lib.parseXcodeVersion(r.out) : null
  if (!v) {
    if (/command line tools/i.test(r.out))
      throw new Stop(
        'Xcode ではなく Command Line Tools が選ばれています。ターミナルで sudo xcode-select -s /Applications/Xcode.app を実行してから、もう一度試してください。',
      )
    throw new Stop('Xcode が見つかりません。App Store から入れて、一度起動してください（docs/MOBILE.md「iPhone」の 2）。')
  }
  if (v.major < lib.MIN_XCODE)
    throw new Stop(`Xcode ${v.text} は古すぎます。${lib.MIN_XCODE} 以上に更新してください（App Store）。`)
  ok(`Xcode ${v.text}`)
  if (!exists(files.servicePlist))
    throw new Stop(`${rel(files.servicePlist)} がありません。先に npm run mobile:firebase -- --ios を実行してください。`)
  const check = lib.servicePlistCheck(fs.readFileSync(files.servicePlist, 'utf8'))
  if (check.problems.length) {
    for (const p of check.problems) ng(p)
    throw new Stop('npm run mobile:firebase -- --ios をもう一度実行してください。')
  }
  if (!exists(files.localXcconfig))
    throw new Stop(`${rel(files.localXcconfig)} がありません。先に npm run mobile:firebase -- --ios を実行してください。`)
  const problems = lib.localXcconfigProblems(fs.readFileSync(files.localXcconfig, 'utf8'), check.reversedClientId)
  if (problems.length) {
    for (const p of problems) ng(p)
    throw new Stop('npm run mobile:firebase -- --ios --team <チームID> をもう一度実行してください。')
  }
  ok('Firebase の設定・Google ログインの戻り先・チーム ID がそろっています')
  await buildAndSync('ios')
  await step('Xcode で開く（cap open ios）', nodeBin('@capacitor/cli', 'cap'), ['open', 'ios'])
  say('\nXcode が開いたら、上の送り先を「Any iOS Device (arm64)」にして Product > Archive（docs/MOBILE.md「iPhone」の 6）。')
}

const USAGE = `使い方（docs/MOBILE.md）:
  npm run mobile:doctor
  npm run mobile:keystore [-- --use <鍵のファイル>]
  npm run mobile:firebase [-- --android | --ios] [--team <チームID>]
  npm run android:install [-- --serial <端末>]
  npm run android:open
  npm run ios:open`

export async function main(argv = process.argv.slice(2)) {
  const opts = lib.parseMobileArgs(argv)
  const commands = {
    doctor,
    keystore: () => keystore(opts),
    firebase: () => firebaseCommand(opts),
    'android-install': () => androidInstall(opts),
    'android-open': androidOpen,
    'ios-open': iosOpen,
  }
  if (!commands[opts.command] || opts.unknown.length) {
    if (opts.unknown.length) ng(`分からない指定: ${opts.unknown.join(' ')}`)
    say(USAGE)
    process.exitCode = 2
    return
  }
  try {
    await commands[opts.command]()
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    say('')
    ng(e.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
