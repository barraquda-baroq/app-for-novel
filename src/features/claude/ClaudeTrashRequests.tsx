// Claude の「ゴミ箱へ移す依頼」（2.7）を処理する（src/domain/claudeTrash.ts の applyTrashRequests）。何も描かない。
// App の外枠に1つだけ置く（TrashPurge・BenchAutoTags と同じ）。
// - 依頼はクラウドからしか届かないので、同期を受け持つ画面がクラウドと揃っている時だけ動かす（src/sync/controller.ts の
//   cloudSettled）。古い端末内のデータで移して、ほかの端末で作者が直した・戻した変更と重ならないように
// - 保存していない下書き（入力欄の draftsDirty）がある間と、この画面で分析・記録を直すダイアログ（AnalysisDialog・
//   MaterialNoteDialog）を開いている間は動かさない（開いている編集の下でカードが消えないように。直して保存した後は、
//   作者が直したカードとして断る。何も変えずに保存・キャンセルで閉じれば移す）。見えるのはこの画面（タブ）の中だけで、
//   別のタブ・別の端末で開いている編集は分からない（どの端末でも、その端末の同期を受け持つ画面が依頼を処理する）
// - 依頼が届いてから少し待ってから当てる（いくつかに分かれて届くのを待つ）。移した・断った時はトーストで知らせる
import { useEffect } from 'react'
import { create } from 'zustand'
import { trashRequestNotice } from '../../domain/claudeTrash'
import { actions } from '../../store/actions'
import { useApp } from '../../store/appStore'
import { notify } from '../../store/uiStore'
import { cloudSettled, useSync } from '../../sync/controller'

/** 依頼が届いてから処理するまで待つ長さ */
export const TRASH_REQUEST_DELAY_MS = 1000

// 分析・記録を直すダイアログを開いている印（この画面の中だけ）。下書きの一覧（store/draftRegistry.ts）には入れない:
// 入れると、別のタブの変更を黙って読み込み直さずに「最新を読み込む」の帯を出すなど、ダイアログの編集には要らない動きが付くため
// （ダイアログの文字はストアと別に持つので、読み込み直しても消えない）
const holds = new Set<symbol>()
const useHolds = create<{ held: boolean }>(() => ({ held: false }))

function publishHolds(): void {
  const held = holds.size > 0
  if (useHolds.getState().held !== held) useHolds.setState({ held })
}

/**
 * 既にあるカード（相対比較の分析・資料の記録）を直すダイアログを開いている間（open が true の間）、依頼の処理を止める。
 * 開いた後に依頼が届いても、保存・キャンセルするまでカードを移さない
 */
export function useHoldTrashRequests(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const key = Symbol('trash-hold')
    holds.add(key)
    publishHolds()
    return () => {
      holds.delete(key)
      publishHolds()
    }
  }, [open])
}

export function ClaudeTrashRequests() {
  const ready = useApp((s) => s.status === 'ready')
  const draftsDirty = useApp((s) => s.draftsDirty)
  const held = useHolds((s) => s.held)
  const requests = useApp((s) => s.data.trashRequests)
  const settled = useSync(cloudSettled)
  const any = Object.keys(requests ?? {}).length > 0

  useEffect(() => {
    if (!ready || !settled || draftsDirty || held || !any) return
    const timer = window.setTimeout(() => {
      try {
        const message = trashRequestNotice(actions.applyClaudeTrashRequests())
        if (message) notify(message)
      } catch (e) {
        console.warn('Claude の依頼のカードをゴミ箱へ移せませんでした', e)
      }
    }, TRASH_REQUEST_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [ready, settled, draftsDirty, held, any, requests])

  return null
}
