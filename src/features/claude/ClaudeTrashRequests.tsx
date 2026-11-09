// Claude の「ゴミ箱へ移す依頼」（2.7）を処理する（src/domain/claudeTrash.ts の applyTrashRequests）。何も描かない。
// App の外枠に1つだけ置く（TrashPurge・BenchAutoTags と同じ）。
// - 依頼はクラウドからしか届かないので、同期を受け持つ画面がクラウドと揃っている時だけ動かす（src/sync/controller.ts の
//   cloudSettled）。古い端末内のデータで移して、ほかの端末で作者が直した・戻した変更と重ならないように
// - 保存していない下書き（開いている分析・記録の編集など）がある間は動かさない（下書きの下でカードが消えないように。
//   下書きを保存した後は、作者が直したカードとして断る）
// - 依頼が届いてから少し待ってから当てる（いくつかに分かれて届くのを待つ）。移した・断った時はトーストで知らせる
import { useEffect } from 'react'
import { trashRequestNotice } from '../../domain/claudeTrash'
import { actions } from '../../store/actions'
import { useApp } from '../../store/appStore'
import { notify } from '../../store/uiStore'
import { cloudSettled, useSync } from '../../sync/controller'

/** 依頼が届いてから処理するまで待つ長さ */
export const TRASH_REQUEST_DELAY_MS = 1000

export function ClaudeTrashRequests() {
  const ready = useApp((s) => s.status === 'ready')
  const draftsDirty = useApp((s) => s.draftsDirty)
  const requests = useApp((s) => s.data.trashRequests)
  const settled = useSync(cloudSettled)
  const any = Object.keys(requests ?? {}).length > 0

  useEffect(() => {
    if (!ready || !settled || draftsDirty || !any) return
    const timer = window.setTimeout(() => {
      try {
        const message = trashRequestNotice(actions.applyClaudeTrashRequests())
        if (message) notify(message)
      } catch (e) {
        console.warn('Claude の依頼のカードをゴミ箱へ移せませんでした', e)
      }
    }, TRASH_REQUEST_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [ready, settled, draftsDirty, any, requests])

  return null
}
