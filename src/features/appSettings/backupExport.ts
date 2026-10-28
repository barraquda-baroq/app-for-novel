// バックアップ（JSON）の書き出し。アプリの設定の「バックアップを書き出す」と、ホームのお知らせの「書き出す」から使う。
// 大長編では数十 MB になるので、インデントを付けずにレコードごとに小分けにして作り、間で処理を譲って画面を長く止めない。
import { useEffect, useState } from 'react'
import { toBackup } from '../../domain/backup'
import { getData } from '../../store/appStore'
import { notify, notifyError } from '../../store/uiStore'
import { readLocal, writeLocal } from '../ideas/storage'
import { LOCAL_STATE_CLEARED } from './localState'
import { COMPACT_BACKUP_CHARS, LAST_BACKUP_KEY, backupChunks, backupFileName, backupTextLength } from './settingsLogic'

/** 書き出し終わったら window に送るイベント（表示中の画面が「最後に書き出した日時」を読み直せるように） */
export const BACKUP_EXPORTED = 'novel-studio:backup-exported'

/** 続けて処理する長さの目安（ミリ秒）。これを超えたら一度ブラウザに処理を譲る */
const SLICE_MS = 30
/** 文字列をまとめて Blob にする単位（UTF-8 への変換も小分けにする） */
const BLOB_PART_CHARS = 1_000_000

/** この端末で最後にバックアップを書き出した日時（なければ null） */
export function readLastBackup(): number | null {
  const raw = readLocal(LAST_BACKUP_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

/** 最後に書き出した日時。書き出した時・別のタブで書き出した時・この端末の状態を消した時に読み直す */
export function useLastBackup(): number | null {
  const [lastBackup, setLastBackup] = useState<number | null>(readLastBackup)
  useEffect(() => {
    const reread = () => setLastBackup(readLastBackup())
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LAST_BACKUP_KEY) reread()
    }
    window.addEventListener(BACKUP_EXPORTED, reread)
    window.addEventListener(LOCAL_STATE_CLEARED, reread)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(BACKUP_EXPORTED, reread)
      window.removeEventListener(LOCAL_STATE_CLEARED, reread)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return lastBackup
}

/** 描画を1回済ませてから続ける（「書き出し中…」を先に見せる） */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function buildBlob(chunks: Iterable<string>): Promise<Blob> {
  const blobs: Blob[] = []
  let pending: string[] = []
  let pendingChars = 0
  let sliceStart = performance.now()
  for (const chunk of chunks) {
    pending.push(chunk)
    pendingChars += chunk.length
    if (pendingChars >= BLOB_PART_CHARS) {
      blobs.push(new Blob(pending))
      pending = []
      pendingChars = 0
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToBrowser()
      sliceStart = performance.now()
    }
  }
  if (pending.length > 0) blobs.push(new Blob(pending))
  return new Blob(blobs, { type: 'application/json' })
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 大きいファイルは保存の開始に時間がかかる端末があるので、少し長めに残す
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

let running: Promise<boolean> | null = null

/**
 * いまのデータをバックアップとして書き出す。書き出せたら「最後に書き出した日時」を記録して true。
 * 書き出し中にもう一度呼ばれた時は、同じ書き出しの結果を返す（二重に保存しない）。
 */
export function exportBackup(): Promise<boolean> {
  running ??= runExport().finally(() => {
    running = null
  })
  return running
}

async function runExport(): Promise<boolean> {
  const now = new Date()
  try {
    await afterPaint()
    // データは変更のたびに作り直される（書き換えられない）ので、書き出しの途中で編集されても混ざらない
    const data = getData()
    const pretty = backupTextLength(data) <= COMPACT_BACKUP_CHARS
    const blob = await buildBlob(backupChunks(toBackup(data, now), pretty))
    downloadBlob(backupFileName(now), blob)
  } catch (e) {
    notifyError(`書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
  writeLocal(LAST_BACKUP_KEY, String(now.getTime()))
  window.dispatchEvent(new Event(BACKUP_EXPORTED))
  notify('バックアップを書き出しました')
  return true
}

/** 書き出しボタン用: 書き出し中かどうかと、書き出す関数 */
export function useBackupExport(): { exporting: boolean; run: () => Promise<boolean> } {
  const [exporting, setExporting] = useState(false)
  const run = async () => {
    setExporting(true)
    try {
      return await exportBackup()
    } finally {
      setExporting(false)
    }
  }
  return { exporting, run }
}
