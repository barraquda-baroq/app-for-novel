// アプリの版がそろっていること（docs/SPEC-2.md「版の区切り」）。
// 元は package.json の version。Android は app/build.gradle がそこから versionCode / versionName を作り、
// iPhone は ios/App/novelstudio.xcconfig の MARKETING_VERSION / CURRENT_PROJECT_VERSION を使う
import { describe, expect, it } from 'vitest'
import packageJson from '../../package.json?raw'
import { APP_VERSION } from '../sync/appModel'

const version = (JSON.parse(packageJson) as { version: string }).version
// iPhone のプロジェクト（ios/）が無い間は、xcconfig も無い
const xcconfigs = import.meta.glob<string>('../../ios/App/novelstudio.xcconfig', { query: '?raw', import: 'default', eager: true })
const pbxprojs = import.meta.glob('../../ios/App/App.xcodeproj/project.pbxproj', { query: '?raw', import: 'default', eager: true })
const xcconfig = Object.values(xcconfigs)[0]

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
  })

  it('iPhone のプロジェクトがあれば、xcconfig も同じ版', () => {
    if (Object.keys(pbxprojs).length > 0) expect(xcconfig, 'ios/App/novelstudio.xcconfig が要る').toBeTypeOf('string')
    if (!xcconfig) return
    expect(setting(xcconfig, 'MARKETING_VERSION')).toBe(version)
    expect(setting(xcconfig, 'CURRENT_PROJECT_VERSION')).toBe(String(buildNumber(version)))
  })

  it('ビルド番号の作り方', () => {
    expect(buildNumber('2.4.0')).toBe(20400)
    expect(buildNumber('2.10.3')).toBe(21003)
  })
})
