// ブラウザ機能のラッパー（クリップボード・ファイル保存・ファイル読み込み）。
// アプリ（iPhone / Android）だけ違うところは src/platform/（ファイルの保存はアプリでは src/platform/saveFile.ts）。
import { Clipboard } from '@capacitor/clipboard'
import { isNative } from '../platform/platform'
import { notify, notifyError } from '../store/uiStore'

export async function copyText(text: string, doneMessage = 'クリップボードにコピーしました'): Promise<boolean> {
  try {
    if (isNative()) {
      // アプリは端末のクリップボードに直接入れる（WebView の navigator.clipboard は許可や操作の直後かどうかで失敗することがある）
      await Clipboard.write({ string: text })
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if (!ok) throw new Error('copy failed')
    }
    notify(doneMessage)
    return true
  } catch {
    notifyError('コピーできませんでした')
    return false
  }
}

export function downloadFile(filename: string, content: string | Blob | BlobPart[], mime = 'text/plain;charset=utf-8'): void {
  const blob = content instanceof Blob ? content : new Blob(Array.isArray(content) ? content : [content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 大きなファイルは保存が始まるまで時間がかかる端末があるので、しばらく残しておく
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** ファイル名に使えない文字を置き換える */
export function safeFileName(name: string): string {
  return (name.trim() || 'untitled').replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 80)
}

/**
 * バックアップ（.json）を選ぶ時の種類。アプリのファイル選択は .json を application/json と見なさないことがある
 * （Google ドライブ・ダウンロードに置いたバックアップが選べない）ので、テキスト・種類の分からないファイルも選べるようにする。
 * 中身はバックアップの読み込み（parseBackup）で確かめる
 */
export function backupAccept(): string {
  return isNative() ? '.json,application/json,text/plain,application/octet-stream' : '.json,application/json'
}

export function pickTextFile(accept = backupAccept()): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    // ファイル選択をキャンセルした時も結果を返す
    input.addEventListener('cancel', () => resolve(null))
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      file
        .text()
        .then(resolve)
        .catch(() => resolve(null))
    }
    input.click()
  })
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatRelative(ts: number, nowTs = Date.now()): string {
  const diff = nowTs - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}時間前`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}日前`
  return formatDateTime(ts).slice(0, 10)
}

/** 「たった今更新」「3分前に更新」のような更新日時の表記 */
export function formatUpdated(ts: number, nowTs = Date.now()): string {
  const rel = formatRelative(ts, nowTs)
  return rel === 'たった今' ? 'たった今更新' : `${rel}に更新`
}
