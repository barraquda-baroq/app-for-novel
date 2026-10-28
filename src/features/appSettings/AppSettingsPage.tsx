// アプリの設定: 同期（ログイン）・表示（この端末だけ）・データ（バックアップ）・ゴミ箱・ホーム画面への追加・危険な操作。
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { DangerZone } from './DangerZone'
import { DataSettings } from './DataSettings'
import { DisplaySettings } from './DisplaySettings'
import { InstallHelp } from './InstallHelp'
import { SyncSettings } from './SyncSettings'
import { TrashSettings } from './TrashSettings'
import './appSettings.css'

export function AppSettingsPage() {
  useDocumentTitle('アプリの設定')
  return (
    <>
      <AppHeader crumbs={[{ label: 'アプリの設定' }]} />
      <main className="page page-narrow aset-page" data-testid="app-settings">
        <h1 className="aset-title">アプリの設定</h1>
        <SyncSettings />
        <DisplaySettings />
        <DataSettings />
        <TrashSettings />
        <InstallHelp />
        <DangerZone />
      </main>
    </>
  )
}
