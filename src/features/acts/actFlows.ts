// セパレート（幕）の操作の確認と実行（一覧の右クリック・長押しメニュー、話・幕の画面から呼ぶ）。
// 原稿画面から呼ぶ時は、先に保存していない編集を保存するか聞いてから（ensureSaved）呼ぶこと。
import { joinError, unseparateError } from '../../domain/acts'
import { actLabel, actParts, actsOf, isSplit, parentOf, pieceFullLabel } from '../../domain/structure'
import { trashNotice } from '../../domain/trash'
import type { AppData, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { confirmDialog } from '../../ui/dialogs'

/** 幕の採用していない稿の数（versionIds の数から採用中の1つを除く） */
function leftoverCount(data: AppData, actIds: readonly ID[]): number {
  let n = 0
  for (const id of actIds) {
    const act = data.pieces[id]
    if (!act) continue
    for (const vid of act.versionIds) if (data.versions[vid] && vid !== act.activeVersionId) n += 1
  }
  return n
}

/** セパレートを解除する（確認つき）。解除したら true */
export async function confirmUnseparate(pieceId: ID): Promise<boolean> {
  const data = getData()
  const piece = data.pieces[pieceId]
  if (!piece || !isSplit(piece)) return false
  const err = unseparateError(data, pieceId)
  if (err) {
    notifyError(err)
    return false
  }
  const label = pieceFullLabel(data, piece)
  const acts = actsOf(data, piece)
  const leftovers = leftoverCount(
    data,
    acts.map((a) => a.id),
  )
  const ok = await confirmDialog({
    title: `「${label}」のセパレートを解除しますか？`,
    message:
      `各幕（${acts.length}幕）の採用稿を順につないだ本文を、この話の新しい稿「第${piece.versionSeq + 1}稿（幕をつないだ稿）」として採用し、幕を1つの話に戻します。` +
      (leftovers > 0
        ? `\n\n各幕の採用していない稿（${leftovers}稿）は${trashNotice('')}ゴミ箱から戻すと、この話の稿として戻ります。`
        : ''),
    confirmLabel: 'セパレート解除',
  })
  if (!ok) return false
  const done = attempt(() => actions.unseparatePiece(pieceId))
  if (!done) return false
  notify(`「${label}」のセパレートを解除しました`)
  return true
}

/** 幕を次の幕とつなぐ（確認つき）。つないだら true */
export async function confirmJoin(actId: ID): Promise<boolean> {
  const data = getData()
  const act = data.pieces[actId]
  const parent = act ? parentOf(data, act) : undefined
  if (!act || !parent) return false
  const err = joinError(data, actId)
  if (err) {
    notifyError(err)
    return false
  }
  const parts = actParts(data, parent)
  const i = parts.findIndex((x) => x.act.id === actId)
  const here = actLabel(i + 1)
  const next = actLabel(i + 2)
  const leftovers = leftoverCount(data, [parts[i + 1].act.id])
  const ok = await confirmDialog({
    title: `${here}と${next}をつなぎますか？`,
    message:
      `${here}に、${here}と${next}の採用稿をつないだ新しい稿「第${act.versionSeq + 1}稿（つないだ稿）」を作って採用します。${next}はなくなり、後ろの幕の番号が1つずつ繰り上がります。` +
      (leftovers > 0
        ? `\n\n${next}の採用していない稿（${leftovers}稿）は${trashNotice('')}ゴミ箱から戻すと、${here}の稿として戻ります。`
        : ''),
    confirmLabel: 'つなぐ',
  })
  if (!ok) return false
  const done = attempt(() => actions.joinActWithNext(actId))
  if (!done) return false
  notify(`${here}と${next}をつなぎました`)
  return true
}
