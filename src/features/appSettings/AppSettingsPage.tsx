// アプリの設定: 表示（この端末だけ）・データ（バックアップ）・ホーム画面への追加・危険な操作。
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { useScrollTopOnMount } from '../home/scroll'
import { DangerZone } from './DangerZone'
import { DataSettings } from './DataSettings'
import { DisplaySettings } from './DisplaySettings'
import { InstallHelp } from './InstallHelp'
import './appSettings.css'

export function AppSettingsPage() {
  useDocumentTitle('設定')
  useScrollTopOnMount()
  return (
    <>
      <AppHeader crumbs={[{ label: '設定' }]} />
      <main className="page page-narrow aset-page" data-testid="app-settings">
        <h1 className="aset-title">設定</h1>
        <DisplaySettings />
        <DataSettings />
        <InstallHelp />
        <DangerZone />
      </main>
    </>
  )
}
