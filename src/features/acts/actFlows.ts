// セパレート（幕）の操作の確認と実行（一覧の右クリック・長押しメニュー、話・幕の画面から呼ぶ）。
// 原稿画面から呼ぶ時は、先に保存していない編集を保存するか聞いてから（ensureSaved）呼ぶこと。
// 操作する話・幕に、端末内の控え（前回保存されなかった編集・別のタブで編集中の編集）があれば、先にそれを伝える
// （操作は保存した本文で行うので、控えの編集は入らない。続けても控えは残り、あとで残った幕・話を開いた時に新しい稿として残せる）。
import { JOINED_VERSION_SUFFIX, joinError, UNSEPARATED_VERSION_SUFFIX, unseparateError } from '../../domain/acts'
import { actLabel, actParts, actsOf, isSplit, parentOf, pieceFullLabel } from '../../domain/structure'
import { trashNotice } from '../../domain/trash'
import type { AppData, ID } from '../../domain/types'
import { nextVersionName } from '../../domain/versionNumber'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { formatDateTime } from '../../ui/browser'
import { choiceDialog, confirmDialog } from '../../ui/dialogs'
import { editOwnerAlive, readCrashDraft, removeCrashDraft, resolveCrashDraft, type CrashDraft } from '../piece/crashDraft'
import type { FieldEdit, FieldKey } from '../piece/session'
import { describeEdits, storedFieldValue } from '../piece/usePieceSession'

/** 消える幕の推敲メモを引き継ぐことの説明（確認文に入れる） */
export const NOTE_CARRY_NOTICE = '消える幕の採用稿の推敲メモは、稿の名前とともに新しい稿の推敲メモに引き継ぎます。'

export interface ActFlowOptions {
  /** 控えのある話・幕を開く（「開く」を押した時。無ければ「開く」を出さない） */
  open?: (pieceId: ID) => void
}

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

export interface PendingDraft {
  pieceId: ID
  draft: CrashDraft
  /** 控えのうち、まだ保存先と違う編集 */
  edits: Record<FieldKey, FieldEdit>
  /** 別のタブ・ウィンドウでいま編集している */
  alive: boolean
}

/** 話・幕 ids の、まだ保存されていない控え（保存先と同じになっていた古い控えは消す） */
export async function pendingDrafts(ids: readonly ID[]): Promise<PendingDraft[]> {
  const out: PendingDraft[] = []
  for (const pieceId of ids) {
    const draft = readCrashDraft(pieceId)
    if (!draft) continue
    const alive = draft.owner ? await editOwnerAlive(draft.owner) : false
    const edits = resolveCrashDraft(draft, (k) => storedFieldValue(getData(), pieceId, k))
    if (Object.keys(edits).length === 0) {
      if (!alive) removeCrashDraft(pieceId, draft.owner)
      continue
    }
    out.push({ pieceId, draft, edits, alive })
  }
  return out
}

/**
 * 操作する話・幕 ids に保存されていない編集の控えがあれば、そのことを伝えて続けるか聞く（無ければ聞かずに true）。
 * 「開く」を選んだ時は控えのある画面を開き（そこで復元するか聞かれる）、false を返す。
 */
export async function confirmPendingDrafts(ids: readonly ID[], opts: ActFlowOptions = {}): Promise<boolean> {
  const pending = await pendingDrafts(ids)
  if (pending.length === 0) return true
  const data = getData()
  const name = (id: ID) => (data.pieces[id] ? pieceFullLabel(data, data.pieces[id]) : 'なくなった幕')
  const lines = pending.map(
    (p) =>
      `・${name(p.pieceId)}: ${describeEdits(data, p.edits)}（${p.alive ? '別のタブ・ウィンドウで編集中' : `${formatDateTime(p.draft.at)}の控え`}）`,
  )
  const openable = opts.open ? pending.find((p) => !p.alive) : undefined
  const choice = await choiceDialog({
    title: `${pending.map((p) => name(p.pieceId)).join('・')}に保存されていない編集があります`,
    message:
      `${lines.join('\n')}\n\nこの操作は保存した本文で行うので、その編集は入りません。先にその画面を開いて、保存するか破棄してください。` +
      '\n\nこのまま続けても編集は消えません（あとでその話・幕を開いた時に、なくなった幕の編集はつないだ先の幕や話を開いた時に、新しい稿として残せます）。',
    choices: [
      { value: 'cancel', label: 'キャンセル', testId: 'pending-draft-cancel' },
      { value: 'continue', label: 'このまま続ける', testId: 'pending-draft-continue' },
      ...(openable ? [{ value: 'open', label: '開く', primary: true, testId: 'pending-draft-open' }] : []),
    ],
  })
  if (choice === 'open' && openable && opts.open) {
    opts.open(openable.pieceId)
    return false
  }
  return choice === 'continue'
}

/** セパレートを解除する（確認つき）。解除したら true */
export async function confirmUnseparate(pieceId: ID, opts: ActFlowOptions = {}): Promise<boolean> {
  const data = getData()
  const piece = data.pieces[pieceId]
  if (!piece || !isSplit(piece)) return false
  const err = unseparateError(data, pieceId)
  if (err) {
    notifyError(err)
    return false
  }
  const acts = actsOf(data, piece)
  if (
    !(await confirmPendingDrafts(
      acts.map((a) => a.id),
      opts,
    ))
  ) {
    return false
  }
  const now = getData()
  const current = now.pieces[pieceId] ?? piece
  const label = pieceFullLabel(now, current)
  const leftovers = leftoverCount(
    now,
    acts.map((a) => a.id),
  )
  const ok = await confirmDialog({
    title: `「${label}」のセパレートを解除しますか？`,
    message:
      `各幕（${acts.length}幕）の採用稿を順につないだ本文を、この話の新しい稿「${nextVersionName(now, current, UNSEPARATED_VERSION_SUFFIX)}」として採用し、幕を1つの話に戻します。${NOTE_CARRY_NOTICE}` +
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
export async function confirmJoin(actId: ID, opts: ActFlowOptions = {}): Promise<boolean> {
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
  if (!(await confirmPendingDrafts([actId, parts[i + 1].act.id], opts))) return false
  const here = actLabel(i + 1)
  const next = actLabel(i + 2)
  const now = getData()
  const leftovers = leftoverCount(now, [parts[i + 1].act.id])
  const ok = await confirmDialog({
    title: `${here}と${next}をつなぎますか？`,
    message:
      `${here}に、${here}と${next}の採用稿をつないだ新しい稿「${nextVersionName(now, now.pieces[actId] ?? act, JOINED_VERSION_SUFFIX)}」を作って採用します。${next}はなくなり、後ろの幕の番号が1つずつ繰り上がります。${NOTE_CARRY_NOTICE}` +
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
