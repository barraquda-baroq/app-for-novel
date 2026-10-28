// 本編の一覧から呼ぶ、話の操作の確認と実行（行の「…」・右クリック・長押しのメニュー、編集モードの削除ボタン）。
import { actsOf, canDeletePiece, pieceFullLabel } from '../../../domain/structure'
import { trashNotice } from '../../../domain/trash'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify, notifyError } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'
import { versionCountOf } from './storyLogic'

/** 話を削除する（確認つき）。途中の話数は削除できない。幕に分けた話は、幕とその稿もいっしょにゴミ箱へ */
export async function confirmDeletePiece(pieceId: ID): Promise<boolean> {
  const data = getData()
  const piece = data.pieces[pieceId]
  if (!piece) return false
  const perm = canDeletePiece(data, pieceId)
  if (!perm.ok) {
    notifyError(perm.reason ?? '削除できません')
    return false
  }
  const label = pieceFullLabel(data, piece)
  const acts = actsOf(data, piece)
  const versions = versionCountOf(data, piece) + acts.reduce((n, a) => n + versionCountOf(data, a), 0)
  const ok = await confirmDialog({
    title: `「${label}」を削除しますか？`,
    message: trashNotice(
      acts.length > 0
        ? `この話の幕（${acts.length}幕）と、すべての推敲バージョン（${versions}稿）もいっしょに`
        : `この話のすべての推敲バージョン（${versions}稿）もいっしょに`,
    ),
    danger: true,
    confirmLabel: '削除',
  })
  if (!ok) return false
  if (!attempt(() => (actions.deletePiece(pieceId), true))) return false
  notify(`「${label}」をゴミ箱に移しました`)
  return true
}
