// 危険な操作: すべてのデータを削除する（確認ダイアログ＋「削除」の入力で二重に確認する）。
import { useId, useState } from 'react'
import { emptyData } from '../../domain/types'
import { getData, replaceAllData } from '../../store/appStore'
import { notify, notifyError } from '../../store/uiStore'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { TrashIcon } from '../../ui/icons'
import { DELETE_ALL_WORD, confirmsDeleteAll, countsSummary, dataCounts, isEmptyData } from './settingsLogic'

export function DangerZone() {
  const id = useId()
  const [busy, setBusy] = useState(false)

  const deleteAll = async () => {
    const current = getData()
    const ok = await confirmDialog({
      title: 'すべてのデータを削除しますか？',
      message: [
        'この端末に保存されているタイトル・原稿・推敲バージョン・設定・戦略・メモ・アイデアをすべて削除します。元に戻すことはできません。',
        '必要なら、先に「バックアップを書き出す」で保存してください。',
        '',
        isEmptyData(current) ? '（いまは保存されているデータがありません）' : `削除される内容: ${countsSummary(dataCounts(current))}`,
      ].join('\n'),
      danger: true,
      confirmLabel: '削除へ進む',
    })
    if (!ok) return
    const typed = await promptDialog({
      title: '最終確認',
      label: `確認のため「${DELETE_ALL_WORD}」と入力してください`,
      placeholder: DELETE_ALL_WORD,
      confirmLabel: 'すべて削除',
    })
    if (typed === null) return
    if (!confirmsDeleteAll(typed)) {
      notifyError(`「${DELETE_ALL_WORD}」と入力されなかったため、削除を中止しました`)
      return
    }
    setBusy(true)
    try {
      await replaceAllData(emptyData())
      notify('すべてのデータを削除しました')
    } catch (e) {
      notifyError(`削除できませんでした: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card aset-card aset-danger" aria-labelledby={`${id}-title`} data-testid="danger-zone">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>危険な操作</h2>
      </div>
      <div className="aset-row aset-danger-row">
        <div className="aset-row-label">
          <span>すべてのデータを削除</span>
          <span className="aset-row-desc">
            この端末のタイトル・原稿・アイデアなどをすべて削除して、最初の状態に戻します。表示の設定は残ります。
          </span>
        </div>
        <div className="aset-row-control">
          <button type="button" className="btn btn-danger" onClick={() => void deleteAll()} disabled={busy} data-testid="delete-all">
            <TrashIcon />
            すべてのデータを削除
          </button>
        </div>
      </div>
    </section>
  )
}
