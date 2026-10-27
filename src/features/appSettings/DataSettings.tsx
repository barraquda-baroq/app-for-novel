// データ: 端末内にだけ保存されていることの説明、バックアップの書き出し・復元、保存領域の情報。
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { parseBackup, toBackup } from '../../domain/backup'
import { DomainError, type AppData } from '../../domain/types'
import { getData, replaceAllData, useData } from '../../store/appStore'
import { notify, notifyError } from '../../store/uiStore'
import { downloadFile, formatDateTime, pickTextFile } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DownloadIcon, UploadIcon } from '../../ui/icons'
import { readLocal, writeLocal } from '../ideas/storage'
import { backupFileName, countsSummary, dataCounts, formatBytes, readExportedAt } from './settingsLogic'

const LAST_BACKUP_KEY = 'novel-studio:last-backup'

interface StorageInfo {
  usage?: number
  quota?: number
  /** null = 確認できない */
  persisted: boolean | null
  canPersist: boolean
}

function useStorageInfo(): [StorageInfo, () => void] {
  const [info, setInfo] = useState<StorageInfo>({ persisted: null, canPersist: false })
  const refresh = useCallback(() => {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    setInfo((prev) => ({ ...prev, canPersist: typeof storage?.persist === 'function' }))
    try {
      storage
        ?.estimate?.()
        .then((r) => setInfo((prev) => ({ ...prev, usage: r.usage, quota: r.quota })))
        .catch(() => undefined)
      storage
        ?.persisted?.()
        .then((p) => setInfo((prev) => ({ ...prev, persisted: p })))
        .catch(() => undefined)
    } catch {
      /* 対応していないブラウザ */
    }
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  return [info, refresh]
}

function readLastBackup(): number | null {
  const raw = readLocal(LAST_BACKUP_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

export function DataSettings() {
  const id = useId()
  const data = useData()
  const counts = useMemo(() => dataCounts(data), [data])
  const [storage, refreshStorage] = useStorageInfo()
  const [lastBackup, setLastBackup] = useState<number | null>(readLastBackup)
  const [busy, setBusy] = useState(false)

  const exportBackup = () => {
    const now = new Date()
    try {
      downloadFile(backupFileName(now), JSON.stringify(toBackup(getData(), now), null, 2), 'application/json')
    } catch (e) {
      notifyError(`書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    writeLocal(LAST_BACKUP_KEY, String(now.getTime()))
    setLastBackup(now.getTime())
    notify('バックアップを書き出しました')
  }

  const restore = async () => {
    const text = await pickTextFile()
    if (text === null) return
    let next: AppData
    try {
      next = parseBackup(text)
    } catch (e) {
      notifyError(e instanceof DomainError ? e.message : 'バックアップファイルを読み込めませんでした')
      return
    }
    const exportedAt = readExportedAt(text)
    const lines = [
      'この端末の現在のデータは、すべてバックアップの内容に置き換えられます。現在のデータは元に戻せません。必要なら先に「バックアップを書き出す」で保存してください。',
      '',
      exportedAt ? `書き出し日時: ${formatDateTime(exportedAt)}` : null,
      `バックアップの内容: ${countsSummary(dataCounts(next))}`,
    ].filter((l): l is string => l !== null)
    const ok = await confirmDialog({
      title: 'バックアップから復元しますか？',
      message: lines.join('\n'),
      danger: true,
      confirmLabel: '置き換えて復元',
    })
    if (!ok) return
    setBusy(true)
    try {
      await replaceAllData(next)
      notify('バックアップから復元しました')
    } catch (e) {
      notifyError(`復元できませんでした: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      refreshStorage()
    }
  }

  const requestPersist = async () => {
    try {
      const ok = await navigator.storage?.persist?.()
      if (ok) notify('ブラウザがデータを自動で削除しないように設定しました')
      else notifyError('ブラウザに許可されませんでした。ホーム画面に追加すると許可されやすくなります。')
    } catch {
      notifyError('この端末では設定できませんでした')
    }
    refreshStorage()
  }

  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="data-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>データ</h2>
        <p className="aset-card-lead">
          データはこの端末のブラウザの中（IndexedDB）にだけ保存され、サーバーには送られません。機種変更やブラウザのデータ削除に備えて、ときどきバックアップを書き出しておきましょう。別の端末へは、バックアップを書き出して、その端末で復元すると移せます。
        </p>
      </div>

      <dl className="aset-counts" data-testid="data-counts">
        {counts.map((c) => (
          <div key={c.table} className="aset-count">
            <dt>{c.label}</dt>
            <dd>{c.count.toLocaleString('ja-JP')}</dd>
          </div>
        ))}
      </dl>

      <div className="aset-actions">
        <button type="button" className="btn btn-primary" onClick={exportBackup} data-testid="export-backup">
          <DownloadIcon />
          バックアップを書き出す
        </button>
        <button type="button" className="btn" onClick={() => void restore()} disabled={busy} data-testid="restore-backup">
          <UploadIcon />
          {busy ? '復元しています…' : 'バックアップから復元'}
        </button>
      </div>
      <p className="aset-note" data-testid="last-backup">
        {lastBackup ? `この端末で最後に書き出した日時: ${formatDateTime(lastBackup)}` : 'この端末ではまだバックアップを書き出していません。'}
      </p>

      <div className="aset-storage" data-testid="storage-info">
        <h3 className="aset-subhead">保存領域</h3>
        <dl className="aset-storage-list">
          <div>
            <dt>使用量</dt>
            <dd data-testid="storage-usage">
              {storage.usage !== undefined
                ? `${formatBytes(storage.usage)}${storage.quota !== undefined ? `（上限の目安 ${formatBytes(storage.quota)}）` : ''}`
                : '確認できません'}
            </dd>
          </div>
          <div>
            <dt>自動削除の防止</dt>
            <dd data-testid="storage-persisted">
              {storage.persisted === null ? (
                '確認できません'
              ) : storage.persisted ? (
                <span className="aset-ok">有効（ブラウザが自動でデータを削除しません）</span>
              ) : (
                <span className="aset-warn">無効（空き容量が少なくなると、ブラウザにデータを削除されることがあります）</span>
              )}
            </dd>
          </div>
        </dl>
        {storage.persisted === false && storage.canPersist ? (
          <button type="button" className="btn btn-sm" onClick={() => void requestPersist()} data-testid="request-persist">
            自動で削除されないようにする
          </button>
        ) : null}
      </div>
    </section>
  )
}
