// 保存先が無くなった、保存していない編集（2.2 セパレート）。
// 原稿画面を開いている間に、別の画面・端末で幕がつながれた・セパレートを解除された（幕が無くなった）、話が幕に分けられた
// （話自身の稿を変えられなくなった）、話・幕が削除された時に、画面の中の編集をどこへ残すか決める。
// アプリが落ちて控え（crashDraft.ts）だけが残った幕の編集も、残った幕・話を開いた時に同じように残せるようにする。
import type { OrphanKeepTarget, PieceEdit } from '../../domain/pieceEdits'
import { actNumber, actsOf, isSplit, pieceFullLabel } from '../../domain/structure'
import type { AppData, ID, Piece } from '../../domain/types'
import { actions } from '../../store/actions'
import { flushNow, getData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { formatDateTime } from '../../ui/browser'
import { choiceDialog } from '../../ui/dialogs'
import { editOwnerAlive, findOrphanDrafts, removeCrashDraft, resolveCrashDraft, type CrashDraft } from './crashDraft'
import { toPieceEdits } from './session'
import { conflictName, describeEdits, keptMessage, storedFieldValue } from './usePieceSession'

/** 最後に見えていた話・幕（幕が無くなった後に、残し先を決めるのに使う） */
export interface LastSeen {
  titleId: ID
  /** 幕なら属する話 */
  parentId: ID | null
  /** 幕なら、話の幕の並びの中の位置 */
  index: number
  /** 幕なら、前の幕（先頭なら null） */
  prevId: ID | null
  /** 「第3話　題　第2幕」 */
  label: string
}

/**
 * 何が起きたか。joined = 幕が前の幕とつながれた（無くなった）、unseparated = セパレートを解除した（幕が無くなった）、
 * split = 話が幕に分けられた、deleted = 話・幕が削除された（または属する話ごと無くなった）
 */
export type OrphanReason = 'joined' | 'unseparated' | 'split' | 'deleted'

export interface OrphanTargetOption {
  id: ID
  label: string
}

export interface OrphanState {
  reason: OrphanReason
  /** 残し先の候補（幕に分けた話なら幕。空ならゴミ箱へ） */
  options: OrphanTargetOption[]
  /** 選んでいなければここへ残す（null ならゴミ箱） */
  defaultTarget: ID | null
  /** 選んだ残し先（choice。候補に無ければ defaultTarget）で、残し方を作る */
  keep: (choice: ID | null) => OrphanKeepTarget
  /** 選んだ残し先の表記（ゴミ箱なら null） */
  targetLabel: (choice: ID | null) => string | null
}

/** 話・幕の表記（幕は「第3話　題　第2幕」） */
function optionOf(data: AppData, p: Piece): OrphanTargetOption {
  return { id: p.id, label: pieceFullLabel(data, p) }
}

/**
 * 原稿画面の話・幕（pieceId）に、ふつうに保存できない時の状態。ふつうに保存できれば null。
 * last は最後に見えていた場所（無くなった幕の、属していた話と位置）。
 */
export function orphanState(data: AppData, titleId: ID, pieceId: ID, last: LastSeen | null): OrphanState | null {
  const title = data.titles[titleId]
  const found = data.pieces[pieceId]
  const piece = title && found && found.titleId === title.id ? found : undefined
  // 幕は、属する話の幕の並びに載っている間だけふつうに保存する
  if (piece && !isSplit(piece) && (piece.kind !== 'act' || actNumber(data, piece) !== null)) return null

  let reason: OrphanReason = 'deleted'
  let options: OrphanTargetOption[] = []
  let defaultTarget: ID | null = null
  if (piece && isSplit(piece)) {
    // 話が幕に分けられた: 話自身の稿は変えられないので、幕の新しい稿にする（どの幕にするかは選べる。既定は第1幕）
    reason = 'split'
    options = actsOf(data, piece).map((a) => optionOf(data, a))
    defaultTarget = options[0]?.id ?? null
  } else {
    const parentId = last?.parentId ?? (piece?.kind === 'act' && typeof piece.parentId === 'string' ? piece.parentId : null)
    const parent = parentId ? data.pieces[parentId] : undefined
    if (parent && parent.kind === 'episode' && parent.titleId === titleId) {
      if (isSplit(parent)) {
        // 前の幕とつながれた: つないだ前の幕が本文を引き継いでいる
        reason = 'joined'
        const acts = actsOf(data, parent)
        options = acts.map((a) => optionOf(data, a))
        const prev = last?.prevId ? acts.find((a) => a.id === last.prevId) : undefined
        const at = Math.max(0, Math.min((last?.index ?? 0) - 1, acts.length - 1))
        defaultTarget = prev?.id ?? acts[at]?.id ?? null
      } else {
        // セパレートを解除した: 話の稿にする
        reason = 'unseparated'
        options = [optionOf(data, parent)]
        defaultTarget = parent.id
      }
    }
  }
  const resolve = (choice: ID | null) => (choice && options.some((o) => o.id === choice) ? choice : defaultTarget)
  return {
    reason,
    options,
    defaultTarget,
    keep: (choice) => ({
      pieceId: resolve(choice),
      origin: {
        titleId: last?.titleId ?? titleId,
        pieceId,
        ...(last?.parentId ? { parentId: last.parentId } : {}),
      },
      parentLabel: last?.label ?? '',
    }),
    targetLabel: (choice) => {
      const id = resolve(choice)
      return options.find((o) => o.id === id)?.label ?? null
    },
  }
}

/** 控えの、まだ保存先と違う編集（無くなった稿の編集も残る） */
function draftEdits(data: AppData, draft: CrashDraft) {
  return resolveCrashDraft(draft, (k) => storedFieldValue(data, draft.pieceId, k))
}

/**
 * 話 parentId の幕だった控えのうち、幕がもう無いもの（つないだ・セパレートを解除した幕の、保存されなかった編集）を1つずつ聞き、
 * 「残す」なら targetFor の話・幕の新しい稿として残す（「破棄」なら控えを消す。閉じたら次に開いた時にまた聞く）。
 * 別のタブ・ウィンドウで今も編集している控えは聞かない（そのタブが自分で残す）。asked には聞いた控えの幕を入れる。
 */
export async function askOrphanDrafts(
  parentId: ID,
  targetFor: (draft: CrashDraft) => Piece | undefined,
  asked: Set<ID>,
  isMounted: () => boolean,
): Promise<void> {
  for (const draft of findOrphanDrafts(getData().pieces, parentId)) {
    if (asked.has(draft.pieceId)) continue
    asked.add(draft.pieceId)
    if (draft.owner && (await editOwnerAlive(draft.owner))) continue
    if (!isMounted()) return
    const resolved = draftEdits(getData(), draft)
    if (Object.keys(resolved).length === 0) {
      removeCrashDraft(draft.pieceId, draft.owner)
      continue
    }
    const target = targetFor(draft)
    const targetLabel = target ? pieceFullLabel(getData(), target) : null
    const choice = await choiceDialog({
      title: `なくなった幕で保存されなかった編集があります（${formatDateTime(draft.at)}）`,
      message:
        `${describeEdits(getData(), resolved)}\n\nこの編集をした幕は、つないだかセパレートを解除したため、なくなりました。` +
        (targetLabel
          ? `「残す」を押すと、「${targetLabel}」の新しい稿として残します（採用はしません）。`
          : '「残す」を押すと、ゴミ箱に残します。') +
        '「破棄」を押すと、この控えを消します。',
      choices: [
        { value: 'discard', label: '破棄', danger: true, testId: 'orphan-draft-discard' },
        { value: 'keep', label: '残す', primary: true, testId: 'orphan-draft-keep' },
      ],
    })
    if (!isMounted()) return
    if (choice === 'discard') {
      removeCrashDraft(draft.pieceId, draft.owner)
      notify('なくなった幕の編集の控えを破棄しました')
      continue
    }
    // 何も選ばずに閉じた: 控えはそのまま残し、次に開いた時にまた聞く
    if (choice !== 'keep') continue
    const edits: PieceEdit[] = toPieceEdits(draftEdits(getData(), draft))
    const keepTarget: OrphanKeepTarget = {
      pieceId: target?.id ?? null,
      origin: {
        titleId: target?.titleId ?? getData().pieces[parentId]?.titleId ?? '',
        pieceId: draft.pieceId,
        parentId,
      },
      parentLabel: getData().pieces[parentId] ? pieceFullLabel(getData(), getData().pieces[parentId]) : '',
    }
    const r = attempt(() => actions.keepOrphanedEdits(edits, keepTarget, { conflictName }))
    if (!r) continue
    removeCrashDraft(draft.pieceId, draft.owner)
    const ok = await flushNow()
    if (!ok) notifyError('端末に保存できませんでした。端末の空き容量を確認してください。')
    else notify(keptMessage(r.names, r.trashEntryId ? null : targetLabel))
  }
}
