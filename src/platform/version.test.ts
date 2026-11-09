// アプリの版がそろっていること（docs/SPEC-2.md「版の区切り」）。
// 元は package.json の version。Android は app/build.gradle がそこから versionCode / versionName を作り、
// iPhone は ios/App/novelstudio.xcconfig の MARKETING_VERSION / CURRENT_PROJECT_VERSION を使う
import { describe, expect, it } from 'vitest'
import deployDoc from '../../docs/DEPLOY.md?raw'
import spec2Doc from '../../docs/SPEC-2.md?raw'
import packageLock from '../../package-lock.json?raw'
import packageJson from '../../package.json?raw'
import { DATA_MODEL, APP_VERSION as MODEL_APP_VERSION } from '../sync/appModel'
import { APP_VERSION } from '../sync/appVersion'

const version = (JSON.parse(packageJson) as { version: string }).version
// iPhone のプロジェクト（ios/）が無い間は、xcconfig も無い
const xcconfigs = import.meta.glob<string>('../../ios/App/novelstudio.xcconfig', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const pbxprojs = import.meta.glob('../../ios/App/App.xcodeproj/project.pbxproj', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const xcconfig = Object.values(xcconfigs)[0]
const pbxproj = Object.values(pbxprojs)[0] as string | undefined

/** Android の versionCode と iPhone の CURRENT_PROJECT_VERSION（2.4.0 → 20400） */
const buildNumber = (v: string) => {
  const [major, minor, patch] = v.split('.').map(Number)
  return major * 10000 + minor * 100 + patch
}

const setting = (text: string, key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm'))?.[1]

describe('アプリの版', () => {
  it('package.json の version は x.y.z', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('同期の記録に添える版（APP_VERSION）は package.json の x.y', () => {
    expect(APP_VERSION).toBe(version.split('.').slice(0, 2).join('.'))
    expect(MODEL_APP_VERSION).toBe(APP_VERSION)
  })

  it('iPhone のプロジェクトがあれば、xcconfig も同じ版', () => {
    if (Object.keys(pbxprojs).length > 0) expect(xcconfig, 'ios/App/novelstudio.xcconfig が要る').toBeTypeOf('string')
    if (!xcconfig) return
    expect(setting(xcconfig, 'MARKETING_VERSION')).toBe(version)
    expect(setting(xcconfig, 'CURRENT_PROJECT_VERSION')).toBe(String(buildNumber(version)))
  })

  it('iPhone のプロジェクトは版を xcconfig だけに書き、最低の iOS は xcconfig と同じ', () => {
    if (!pbxproj || !xcconfig) return
    // ターゲットに書くと xcconfig より強くなり、版を上げても変わらなくなる
    expect(pbxproj).not.toMatch(/MARKETING_VERSION|CURRENT_PROJECT_VERSION|DEVELOPMENT_TEAM/)
    // Capacitor の cap sync は pbxproj の最初の IPHONEOS_DEPLOYMENT_TARGET を Package.swift に使う
    const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(t).toBe(setting(xcconfig, 'IPHONEOS_DEPLOYMENT_TARGET'))
  })

  it('package-lock.json の版も package.json と同じ（npm ci で版が戻らない）', () => {
    const lock = JSON.parse(packageLock) as { version: string; packages: Record<string, { version?: string }> }
    expect(lock.version).toBe(version)
    expect(lock.packages[''].version).toBe(version)
  })

  it('文書の版の一覧に、今の版とデータの形の版がある（docs/SPEC-2.md の 4・docs/DEPLOY.md の 4）', () => {
    // SPEC-2 の「版の区切り」の表に、今の版の行
    const table = spec2Doc.slice(spec2Doc.indexOf('## 4. 版の区切り'), spec2Doc.indexOf('## 5.'))
    expect(table).toMatch(new RegExp(`^\\| ${APP_VERSION.replace('.', '\\.')} +\\|`, 'm'))
    // データの形の版の説明（SPEC-2 の 3）と、上げた版の一覧（DEPLOY）に、今のデータの形の版
    expect(spec2Doc).toContain(`は ${DATA_MODEL}（§`)
    const deployList = deployDoc.split('\n').find((line) => line.startsWith('データの形の版を上げた版は'))
    expect(deployList).toContain(`（${DATA_MODEL}。`)
  })

  it('ビルド番号の作り方', () => {
    expect(buildNumber('2.4.0')).toBe(20400)
    expect(buildNumber('2.10.3')).toBe(21003)
  })
})
