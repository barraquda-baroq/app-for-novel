// アプリの設定: 同期（ログイン）・Claude 連携・表示（この端末だけ）・データ（バックアップ）・ゴミ箱・ホーム画面への追加・危険な操作。
// iPhone / Android のアプリでは「ホーム画面に追加」の代わりに「このアプリについて」を出す。
import { useState } from 'react'
import { nativePlatform } from '../../platform/platform'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { ClaudeSettings } from '../claude/ClaudeSettings'
import { DangerZone } from './DangerZone'
import { DataSettings } from './DataSettings'
import { DisplaySettings } from './DisplaySettings'
import { AboutApp } from './AboutApp'
import { InstallHelp } from './InstallHelp'
import { SyncSettings } from './SyncSettings'
import { TrashSettings } from './TrashSettings'
import './appSettings.css'

export function AppSettingsPage() {
  useDocumentTitle('アプリの設定')
  const [platform] = useState(nativePlatform)
  return (
    <>
      <AppHeader crumbs={[{ label: 'アプリの設定' }]} />
      <main className="page page-narrow aset-page" data-testid="app-settings">
        <h1 className="aset-title">アプリの設定</h1>
        <SyncSettings />
        <ClaudeSettings />
        <DisplaySettings />
        <DataSettings />
        <TrashSettings />
        {platform ? <AboutApp platform={platform} /> : <InstallHelp />}
        <DangerZone />
      </main>
    </>
  )
}
