// Claude の依頼を処理する（src/domain/claudeRequests.ts の applyClaudeRequests）: 2.8 のアイデアへの追記の依頼（カードの終わりに
// 足す）を先に、2.7 の「ゴミ箱へ移す依頼」（カードをゴミ箱へ移す）を後に、1回で当てる。何も描かない。
// App の外枠に1つだけ置く（TrashPurge・BenchAutoTags と同じ）。
// - 依頼はクラウドからしか届かないので、同期を受け持つ画面がクラウドと揃っている時だけ動かす（src/sync/controller.ts の
//   cloudSettled）。古い端末内のデータで当てて、ほかの端末で作者が直した・戻した変更と重ならないように
// - 保存していない下書き（入力欄の draftsDirty）がある間と、この画面で依頼の届くカードを直すダイアログ（分析・記録の
//   AnalysisDialog・MaterialNoteDialog と、Claude が作ったアイデアの IdeaEditorModal）を開いている間は動かさない（開いている
//   編集の下でカードが消えたり中身が変わったりしないように。直して保存した後は、作者が直したカードとしてゴミ箱へは移さない。
//   追記は直した後の中身の後ろに足す。何も変えずに保存・キャンセルで閉じれば、どちらも当てる）。見えるのはこの画面（タブ）の
//   中だけで、別のタブ・別の端末で開いている編集は分からない（どの端末でも、その端末の同期を受け持つ画面が依頼を処理する。
//   アイデアの編集の画面は、保存の時に開いている間に足された追記を残す。IdeaCard の rebaseIdeaEdit）
// - 依頼が届いてから少し待ってから当てる（いくつかに分かれて届くのを待つ）。足した・移した・断った時はトーストで知らせる
import { useEffect } from 'react'
import { create } from 'zustand'
import { claudeRequestNotice } from '../../domain/claudeRequests'
import { actions } from '../../store/actions'
import { useApp } from '../../store/appStore'
import { notify } from '../../store/uiStore'
import { cloudSettled, useSync } from '../../sync/controller'

/** 依頼が届いてから処理するまで待つ長さ */
export const CLAUDE_REQUEST_DELAY_MS = 1000

// 依頼の届くカードを直すダイアログを開いている印（この画面の中だけ。追記とゴミ箱へ移す依頼の両方を止める）。
// 下書きの一覧（store/draftRegistry.ts）には入れない: 入れると、別のタブの変更を黙って読み込み直さずに「最新を読み込む」の帯を
// 出すなど、ダイアログの編集には要らない動きが付くため（ダイアログの文字はストアと別に持つので、読み込み直しても消えない）
const holds = new Set<symbol>()
const useHolds = create<{ held: boolean }>(() => ({ held: false }))

function publishHolds(): void {
  const held = holds.size > 0
  if (useHolds.getState().held !== held) useHolds.setState({ held })
}

/**
 * 既にあるカード（相対比較の分析・資料の記録・Claude が作ったアイデア）を直すダイアログを開いている間（open が true の間）、
 * Claude の依頼の処理を止める。開いた後に依頼が届いても、保存・キャンセルするまでカードに足さず・移さない
 */
export function useHoldClaudeRequests(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const key = Symbol('claude-request-hold')
    holds.add(key)
    publishHolds()
    return () => {
      holds.delete(key)
      publishHolds()
    }
  }, [open])
}

const hasRows = (table: Record<string, unknown> | undefined) => Object.keys(table ?? {}).length > 0

export function ClaudeRequests() {
  const ready = useApp((s) => s.status === 'ready')
  const draftsDirty = useApp((s) => s.draftsDirty)
  const held = useHolds((s) => s.held)
  const trashRequests = useApp((s) => s.data.trashRequests)
  const ideaAppends = useApp((s) => s.data.ideaAppends)
  const settled = useSync(cloudSettled)
  const any = hasRows(trashRequests) || hasRows(ideaAppends)

  useEffect(() => {
    if (!ready || !settled || draftsDirty || held || !any) return
    const timer = window.setTimeout(() => {
      try {
        const message = claudeRequestNotice(actions.applyClaudeRequests())
        if (message) notify(message)
      } catch (e) {
        console.warn('Claude の依頼を当てられませんでした', e)
      }
    }, CLAUDE_REQUEST_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [ready, settled, draftsDirty, held, any, trashRequests, ideaAppends])

  return null
}
