// ホームのバックアップのお知らせ。データはこの端末にしかないので、原稿があるのにしばらく書き出していない時に勧める。
// 「書き出す」はアプリの設定と同じ書き出し。「後で」を押すと、この端末ではしばらく出さない。
import { useMemo, useState } from 'react'
import { useData } from '../../store/appStore'
import { formatDateTime } from '../../ui/browser'
import { DownloadIcon } from '../../ui/icons'
import { useBackupExport, useLastBackup } from '../appSettings/backupExport'
import { readLocal, writeLocal } from '../ideas/storage'
import { BACKUP_SNOOZE_KEY, backupReminderDue, hasManuscriptText, parseTimestamp } from './homeLogic'

/** onDone: お知らせを閉じた時（押したボタンが消えるので、フォーカスの移し先を決める） */
export function BackupReminder({ onDone }: { onDone?: () => void }) {
  const versions = useData().versions
  const hasManuscript = useMemo(() => hasManuscriptText({ versions }), [versions])
  const lastBackup = useLastBackup()
  const [snoozedAt, setSnoozedAt] = useState(() => parseTimestamp(readLocal(BACKUP_SNOOZE_KEY)))
  const [now] = useState(Date.now)
  const { exporting, run } = useBackupExport()

  if (!backupReminderDue({ hasManuscript, lastBackup, snoozedAt, now })) return null

  const snooze = () => {
    const at = Date.now()
    writeLocal(BACKUP_SNOOZE_KEY, String(at))
    setSnoozedAt(at)
    onDone?.()
  }

  const exportNow = async () => {
    if (await run()) onDone?.()
  }

  return (
    <aside className="home-backup" aria-label="バックアップのお知らせ" data-testid="backup-reminder">
      <DownloadIcon className="icon home-backup-icon" />
      <p className="home-backup-text">
        <span className="home-backup-message">この端末にだけ保存されています。バックアップを書き出しておきましょう</span>
        <span className="home-backup-last" data-testid="backup-reminder-last">
          {lastBackup ? `最後の書き出し: ${formatDateTime(lastBackup).slice(0, 10)}` : 'まだ一度も書き出していません'}
        </span>
      </p>
      <div className="home-backup-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={snooze} data-testid="backup-reminder-later">
          後で
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void exportNow()}
          aria-disabled={exporting || undefined}
          aria-busy={exporting || undefined}
          data-testid="backup-reminder-export"
        >
          <DownloadIcon />
          {exporting ? '書き出し中…' : '書き出す'}
        </button>
      </div>
    </aside>
  )
}
