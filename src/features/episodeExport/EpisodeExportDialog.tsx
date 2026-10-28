// 各話テキスト書き出しのダイアログ（タイトル画面の本編タブ・通し読みから開く）。
// タイトル全体の採用原稿を1話1ファイルのテキスト（UTF-8）にする。採用原稿のない話は飛ばす。
// フォルダを選べる環境（Edge・Chrome のデスクトップ）では選んだフォルダに直接、それ以外は1つの ZIP にまとめて保存する。
import { useMemo, useRef, useState } from 'react'
import type { ID } from '../../domain/types'
import { useData } from '../../store/appStore'
import { notify, notifyError } from '../../store/uiStore'
import { downloadFile } from '../../ui/browser'
import { Modal } from '../../ui/Modal'
import { useStoryData } from '../title/story/useStoryData'
import {
  buildZip,
  canPickDirectory,
  DirectoryWriteError,
  exportErrorKind,
  exportErrorMessage,
  exportPreview,
  outFiles,
  pickDirectory,
  skippedNotice,
  writeFilesToDirectory,
} from './exportLogic'
import './episodeExport.css'

/** 読み上げる進み具合（1割ずつ。話が多くても読み上げが続かないように） */
export function progressAnnouncement(done: number, total: number): string {
  const tenths = total > 0 ? Math.floor((done / total) * 10) : 0
  return `書き出し中（${tenths * 10}%）`
}

export function EpisodeExportDialog({
  titleId,
  scopedToChapter = false,
  onClose,
}: {
  titleId: ID
  /** 通し読みで章を選んでいる（それでもタイトル全体を書き出すことを知らせる） */
  scopedToChapter?: boolean
  onClose: () => void
}) {
  const data = useData()
  const story = useStoryData(titleId)
  const title = data.titles[titleId]
  const titleName = title?.name ?? ''
  // ファイル名の日付は開いた日（書き出している途中で日付が変わっても、一覧と同じ名前で書く）
  const [date] = useState(() => new Date())
  const [direct] = useState(() => canPickDirectory())
  const [withHeading, setWithHeading] = useState(true)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  /** 書き出している間の二度押しを止める（描き直しを待たずに分かるように） */
  const running = useRef(false)
  // 一覧は本編かタイトル名が変わった時だけ作り直す（data はその時の最新。本文はまだテキストにしないので長編でも軽い）
  const preview = useMemo(
    () => exportPreview(data, titleId, date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [story, titleName, titleId, date],
  )
  const { entries, zipName } = preview
  const skipped = skippedNotice(preview.skippedEpisodes, preview.skippedSpecials, preview.skippedActs)
  const displayName = titleName.trim() || '無題のタイトル'

  const run = async () => {
    if (running.current || entries.length === 0) return
    running.current = true
    const total = entries.length
    const progress = (done: number) => setBusy({ done, total })
    progress(0)
    try {
      if (direct) {
        const dir = await pickDirectory()
        const n = await writeFilesToDirectory(dir, outFiles(entries, withHeading), progress)
        notify(`${n}件のファイルを${dir.name ? `「${dir.name}」に` : ''}書き出しました`)
      } else {
        const chunks = await buildZip(outFiles(entries, withHeading), { onProgress: progress })
        downloadFile(zipName, new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' }))
        notify(`${zipName} を保存しました（${total}件のファイル）`)
      }
      onClose()
    } catch (e) {
      const kind = exportErrorKind(e)
      // フォルダを選ばずに閉じたのは失敗ではないので、ふつうのお知らせにする
      if (kind === 'cancel' && !(e instanceof DirectoryWriteError)) notify(exportErrorMessage(e))
      else notifyError(exportErrorMessage(e))
      if (kind === 'error') console.error(e)
      running.current = false
      setBusy(null)
    }
  }

  return (
    <Modal
      title="各話テキスト書き出し"
      // 書き出している間は閉じない（続けてもう一度書き出さないように）
      onClose={busy ? () => {} : onClose}
      closeDisabled={busy !== null}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void run()}
            // 書き出している間も disabled にはしない（フォーカスが外れて、やめた後に Enter で書き出し直せなくなるため。
            // 二度押しは run() で止める）
            disabled={entries.length === 0}
            aria-disabled={busy !== null || undefined}
            data-testid="export-submit"
          >
            {busy ? `書き出し中…（${busy.done}/${busy.total}）` : '書き出す'}
          </button>
        </>
      }
    >
      <div className="ex-dialog" data-testid="episode-export-dialog" data-method={direct ? 'directory' : 'zip'}>
        {/* 進み具合を読み上げる（ボタンの文字だけでは読み上げられないため） */}
        <p className="visually-hidden" role="status" aria-live="polite" data-testid="export-progress-status">
          {busy ? progressAnnouncement(busy.done, busy.total) : ''}
        </p>
        <p className="ex-lead">
          「{displayName}
          」全体の採用原稿を、1話1ファイルのテキスト（UTF-8）で書き出します。ルビ・傍点は記法（｜漢字《かんじ》）のまま入ります。
        </p>
        {scopedToChapter ? (
          <p className="ex-scope-note" data-testid="export-scope-note">
            通し読みの範囲で章を選んでいても、タイトル全体の各話を書き出します。
          </p>
        ) : null}

        <label className="check ex-option">
          <input
            type="checkbox"
            checked={withHeading}
            onChange={(e) => setWithHeading(e.target.checked)}
            disabled={busy !== null}
            data-testid="export-heading"
          />
          <span>本文の先頭に見出し（第n話・題）を入れる</span>
        </label>

        <p className="ex-method" data-testid="export-method">
          {direct ? (
            <>
              「書き出す」を押して保存先のフォルダを選ぶと、1話ずつ .txt ファイルを作ります。
              <strong>選んだフォルダに同じ名前のファイルがあると、上書きされます。</strong>
            </>
          ) : (
            <>
              1つの ZIP ファイル（
              <span className="ex-zip-name" data-testid="export-zip-name">
                {zipName}
              </span>
              ）にまとめて保存します。ZIP を開くと、1話ずつの .txt ファイルが入っています。
            </>
          )}
        </p>

        {skipped ? (
          <p className="ex-skipped" data-testid="export-skipped">
            {skipped}
          </p>
        ) : null}

        <div className="ex-files-head">
          <span>書き出すファイル</span>
          <span className="ex-count" data-testid="export-count">
            {entries.length}件
          </span>
        </div>
        {entries.length === 0 ? (
          <p className="empty ex-empty" data-testid="export-empty">
            採用原稿のある話がないので、書き出すファイルがありません。
          </p>
        ) : (
          <ol className="ex-files" data-testid="export-files">
            {entries.map((e) => (
              <li key={e.pieceId} data-testid="export-file">
                {e.name}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  )
}
