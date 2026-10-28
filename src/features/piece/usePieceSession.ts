// 原稿画面の保存ボタンまわり: 編集セッションの保存・破棄、画面を離れる時の確認、端末内の控えと復元。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker, type Blocker, type BlockerFunction } from 'react-router-dom'
import type { OrphanKeepTarget } from '../../domain/pieceEdits'
import { pieceFullLabel } from '../../domain/structure'
import type { AppData, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { flushNow, getData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { registerEnsureSaved, setUnsavedEdits, useUnsavedEdits, type EnsureSaved } from '../../store/unsavedEdits'
import { conflictVersionName, deviceLabel } from '../../sync/conflicts'
import { formatDateTime } from '../../ui/browser'
import { choiceDialog, confirmDialog } from '../../ui/dialogs'
import {
  editOwnerAlive,
  holdEditOwner,
  readCrashDraft,
  removeCrashDraft,
  resolveCrashDraft,
  writeCrashDraft,
  type CrashDraft,
} from './crashDraft'
import { EditorHub, useSessionDirty } from './editorHub'
import { EditSession, parseFieldKey, versionField, type FieldEdit, type FieldKey } from './session'

/** 編集してから控えを書くまでの待ち時間 */
export const DRAFT_DELAY_MS = 1000
/** 打ち続けていても、この時間ごとには控える */
export const DRAFT_MAX_WAIT_MS = 3000

/** 本文が競合した時（保存先が無くなった時も）の、この端末の本文を残す稿の名前 */
// 名前は同期されてほかの端末でも見えるので、端末の呼び名（Windows・iPhone など）を入れる
export const conflictName = (name: string) => conflictVersionName(name, deviceLabel())

/** 保存先が無くなった編集を残した後の知らせ（targetLabel が null ならゴミ箱に残した） */
export function keptMessage(names: readonly string[], targetLabel: string | null): string {
  const list = names.map((n) => `「${n}」`).join('')
  return targetLabel
    ? `この端末の編集を、「${targetLabel}」の新しい稿${list}として残しました`
    : `残し先がないため、この端末の編集をゴミ箱に${list}として残しました`
}

/** 項目の保存先の値（無くなっていれば undefined） */
export function storedFieldValue(data: AppData, pieceId: ID, key: FieldKey): string | undefined {
  const f = parseFieldKey(key)
  if (!f) return undefined
  if (f.target === 'version') {
    const v = data.versions[f.id]
    if (!v || v.pieceId !== pieceId) return undefined
    return f.field === 'body' ? v.body : f.field === 'name' ? v.name : f.field === 'note' ? v.note : undefined
  }
  const p = data.pieces[f.id]
  if (!p) return undefined
  return f.field === 'subtitle' ? p.subtitle : f.field === 'label' ? p.label : undefined
}

/** 復元の確認に出す、控えの中身（「第2稿の本文・話の題」など） */
export function describeEdits(data: AppData, edits: Record<FieldKey, FieldEdit>): string {
  const parts: string[] = []
  for (const [key, e] of Object.entries(edits)) {
    const f = parseFieldKey(key)
    if (!f) continue
    if (f.target === 'piece') {
      parts.push(f.field === 'subtitle' ? '話の題' : '見出し')
      continue
    }
    // 稿が削除されていたら、控えの稿の名前（名前の編集なら編集前の名前）で呼ぶ
    const name = data.versions[f.id]?.name.trim() || e.label?.trim() || (f.field === 'name' ? e.base.trim() : '') || '無題の稿'
    parts.push(`${name}の${f.field === 'body' ? '本文' : f.field === 'name' ? '名前' : '推敲メモ'}`)
  }
  return parts.join('・')
}

export interface PieceSession {
  session: EditSession
  hub: EditorHub
  dirty: boolean
  /** 保存する（保存できたら true） */
  save: () => Promise<boolean>
  /** 確認してから、保存していない編集を捨てる */
  discard: () => Promise<void>
  /** 話の構成を変える操作（採用・追加・複製・削除など）の前に呼ぶ。保存していない編集があれば保存するか聞く */
  ensureSaved: EnsureSaved
}

/** 確認の文に出す、この画面で編集できる項目 */
const EDITED_FIELDS = '本文・稿の名前・推敲メモ・話の題・見出し'

export interface PieceSessionOptions {
  /** 開いた時に、前回保存されなかった編集の控えを聞くか（話・幕が見つかる時だけ。true になった時に1回だけ聞く） */
  restore?: boolean
  /**
   * 保存先の話・幕が無くなった（話が幕に分けられた）時の、編集の残し先。ふつうに保存できる時は null。
   * これがある間の「保存」（保存して移動・保存して続ける・Ctrl+S も）は、編集を残し先の新しい稿（無ければゴミ箱）として残す
   */
  keepTarget?: () => OrphanKeepTarget | null
}

export function usePieceSession(pieceId: ID, opts: PieceSessionOptions = {}): PieceSession {
  const [session] = useState(() => new EditSession(pieceId))
  const [hub] = useState(() => new EditorHub(session))
  const dirty = useSessionDirty(session)
  const keepTargetRef = useRef(opts.keepTarget)
  keepTargetRef.current = opts.keepTarget

  // ヘッダーの「保存済み」を、保存していない編集がある間は出さない
  useEffect(() => setUnsavedEdits(dirty), [dirty])
  useEffect(() => () => setUnsavedEdits(false), [])

  const forgetDraft = useCallback(() => {
    // 別のタブが書き直した控え（そのタブの編集）は消さない
    removeCrashDraft(session.pieceId, session.owner)
    session.draftOwned = false
  }, [session])

  /** 保存先が無くなった編集を、残し先の新しい稿（無ければゴミ箱）として残す */
  const keep = useCallback(
    async (target: OrphanKeepTarget): Promise<boolean> => {
      const edits = session.pendingEdits()
      let message = '保存しました'
      if (edits.length > 0) {
        const result = attempt(() => actions.keepOrphanedEdits(edits, target, { conflictName }))
        if (!result) return false
        session.discard()
        forgetDraft()
        const into = target.pieceId ? getData().pieces[target.pieceId] : undefined
        if (result.names.length > 0) {
          message = keptMessage(result.names, result.trashEntryId || !into ? null : pieceFullLabel(getData(), into))
        }
        if (result.dropped.length > 0) notifyError('話がなくなっていたため、保存できなかった話の題・見出しの編集があります。')
      }
      const ok = await flushNow()
      if (!ok) notifyError('端末に保存できませんでした。端末の空き容量を確認してください。')
      else notify(message)
      return ok
    },
    [session, forgetDraft],
  )

  const save = useCallback(async (): Promise<boolean> => {
    // 保存先が無くなっていれば（幕がつながれた・話が幕に分けられた等）、残し先へ
    const target = keepTargetRef.current?.() ?? null
    if (target) return keep(target)
    const edits = session.pendingEdits()
    let dropped = 0
    if (edits.length > 0) {
      const result = attempt(() => actions.savePieceEdits(session.pieceId, edits, { conflictName }))
      if (!result) return false
      // 競合した本文（保存先の値を表示し直す）・削除されていた稿の項目は、履歴も捨てる
      const resetHistory = new Set<FieldKey>()
      for (const c of result.conflicts) {
        resetHistory.add(versionField(c.versionId, 'body'))
        if (c.reason === 'deleted') {
          resetHistory.add(versionField(c.versionId, 'name'))
          resetHistory.add(versionField(c.versionId, 'note'))
        }
      }
      // 書き込めなかった編集は保存したことにしない（控えも残す）
      const droppedSet = new Set(result.dropped)
      session.markSaved(
        edits.filter((e) => !droppedSet.has(e)),
        resetHistory,
      )
      if (!session.isDirty()) forgetDraft()
      for (const c of result.conflicts) {
        const name = c.originalName.trim() || '無題の稿'
        notify(
          c.reason === 'changed'
            ? `別の端末で「${name}」が書き換えられていたため、この端末の本文を「${c.name}」として残しました`
            : `「${name}」が削除されていたため、この端末の編集を「${c.name}」として残しました`,
        )
      }
      dropped = result.dropped.length
    }
    const ok = await flushNow()
    if (!ok) notifyError('端末に保存できませんでした。端末の空き容量を確認してください。')
    else if (dropped > 0)
      notifyError('保存先が無くなっていたため、保存できなかった編集があります。要らなければ「破棄」で取り消してください。')
    else notify('保存しました')
    return dropped === 0
  }, [session, forgetDraft])

  const discard = useCallback(async () => {
    if (!session.isDirty()) return
    const ok = await confirmDialog({
      title: '保存していない編集を破棄しますか？',
      message: `この話で保存していない編集（${EDITED_FIELDS}）をすべて取り消し、保存した時の内容に戻します。元には戻せません。`,
      confirmLabel: '破棄',
      danger: true,
    })
    if (!ok) return
    session.discard()
    forgetDraft()
    notify('保存していない編集を破棄しました')
  }, [session, forgetDraft])

  const ensureSaved = useCallback<EnsureSaved>(
    async (opts) => {
      if (!session.isDirty()) return true
      const ok = await confirmDialog({
        title: '保存していない編集があります。保存してから続けますか？',
        message: opts?.message ?? `この操作の前に、この話の編集（${EDITED_FIELDS}）を保存します。`,
        confirmLabel: opts?.confirmLabel ?? '保存して続ける',
      })
      if (!ok) return false
      return save()
    },
    [session, save],
  )

  // アプリの更新の前にも、保存していない編集を保存するか聞けるようにする（src/ui/Layout.tsx の UpdateBanner）
  useEffect(() => {
    registerEnsureSaved(ensureSaved)
    return () => {
      if (useUnsavedEdits.getState().ensureSaved === ensureSaved) registerEnsureSaved(null)
    }
  }, [ensureSaved])

  // このセッションが開いている間は、控えの持ち主として名乗る（別のタブで開いても「復元しますか？」と聞かない）
  useEffect(() => holdEditOwner(session.owner), [session])

  useCrashDraftWriter(session)
  useRestorePrompt(session, opts.restore ?? true)
  useLeaveGuard(session, dirty, save, forgetDraft)

  // Ctrl/Cmd+S で保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  return { session, hub, dirty, save, discard, ensureSaved }
}

/** 保存していない編集を、少し待ってから（と、裏に回る・閉じる時に）端末内に控える */
function useCrashDraftWriter(session: EditSession): void {
  useEffect(() => {
    const { pieceId } = session
    let timer: ReturnType<typeof setTimeout> | null = null
    let since = 0
    const write = () => {
      if (timer) clearTimeout(timer)
      timer = null
      since = 0
      if (session.isDirty()) {
        if (writeCrashDraft(pieceId, session.edits(), session.owner, Date.now(), session.context)) session.draftOwned = true
      } else if (session.draftOwned) {
        // 巻き戻して編集が無くなった: 自分で書いた控えは消す（前回の控えにはまだ答えていなければ触らない）
        removeCrashDraft(pieceId, session.owner)
        session.draftOwned = false
      }
    }
    const schedule = () => {
      const t = Date.now()
      if (!since) since = t
      if (timer) clearTimeout(timer)
      timer = setTimeout(write, Math.max(0, Math.min(DRAFT_DELAY_MS, since + DRAFT_MAX_WAIT_MS - t)))
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') write()
    }
    const unsubscribe = session.subscribe(schedule)
    window.addEventListener('pagehide', write)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsubscribe()
      window.removeEventListener('pagehide', write)
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer) write()
    }
  }, [session])
}

/** 画面を開いた時（enabled になった時）、前回保存されなかった編集の控えがあれば復元するか聞く */
function useRestorePrompt(session: EditSession, enabled: boolean): void {
  const asked = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!enabled || asked.current) return
    asked.current = true
    const draft = readCrashDraft(session.pieceId)
    if (draft) void askRestore(session, draft, () => mounted.current)
  }, [session, enabled])
}

async function askRestore(session: EditSession, draft: CrashDraft, isMounted: () => boolean): Promise<void> {
  const { pieceId } = session
  // 別のタブ・ウィンドウでいま編集している控え（そのタブが開いている）なら、聞かずにそのままにする
  if (draft.owner && draft.owner !== session.owner && (await editOwnerAlive(draft.owner))) return
  if (!isMounted()) return
  const read = (key: FieldKey) => storedFieldValue(getData(), pieceId, key)
  const first = resolveCrashDraft(draft, read)
  if (Object.keys(first).length === 0) {
    // 控えの内容はもう保存されている（別のタブで保存した等）
    removeCrashDraft(pieceId, draft.owner)
    return
  }
  const choice = await choiceDialog({
    title: `前回保存されなかった編集があります（${formatDateTime(draft.at)}）。復元しますか？`,
    message: `${describeEdits(getData(), first)}\n\n「復元」を押すと、保存していない編集として戻します（「保存」を押すまで保存されません）。「破棄」を押すと、この控えを消します。`,
    choices: [
      { value: 'discard', label: '破棄', danger: true, testId: 'restore-discard' },
      { value: 'restore', label: '復元', primary: true, testId: 'restore-accept' },
    ],
  })
  // 答える前に画面を離れた: 控えはそのまま残し、次に開いた時にまた聞く
  if (!isMounted()) return
  if (choice === 'discard') {
    removeCrashDraft(pieceId, draft.owner)
    notify('前回の編集の控えを破棄しました')
    return
  }
  // 「復元」と、何も選ばずに閉じた時（控えを失わないよう復元しておく。要らなければ「破棄」で消せる）
  if (session.isDirty()) return
  const edits = resolveCrashDraft(draft, read)
  session.restore(edits)
  // 控えはこのタブのものとして書き直す（落ちた前のタブの持ち主のままにしない）
  if (writeCrashDraft(pieceId, session.edits(), session.owner, Date.now(), session.context)) session.draftOwned = true
  notify('前回の編集を復元しました。「保存」を押すと保存されます')
}

/** 保存していない編集があるまま画面を離れようとしたら確かめる（アプリ内の移動・ブラウザの戻る・タブを閉じる） */
function useLeaveGuard(session: EditSession, dirty: boolean, save: () => Promise<boolean>, forgetDraft: () => void): void {
  // 同じ話の中で比較する稿を選び直す（?v= だけが変わる）時は確かめない
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => session.isDirty() && currentLocation.pathname !== nextLocation.pathname,
    [session],
  )
  const blocker = useBlocker(shouldBlock)
  // 確かめている間にもう一度「戻る」が押されると blocker が新しくなる。答えは最新の blocker に返す
  const latest = useRef<Blocker>(blocker)
  latest.current = blocker
  const asking = useRef(false)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    // 確かめている間の「戻る」や StrictMode で、同じ確認を2つ出さない
    if (asking.current) return
    asking.current = true
    const proceed = () => {
      const b = latest.current
      if (b.state === 'blocked') b.proceed()
    }
    const reset = () => {
      const b = latest.current
      if (b.state === 'blocked') b.reset()
    }
    void choiceDialog({
      title: '保存していない編集があります',
      message: `保存しないで移動すると、この話で書いた内容（${EDITED_FIELDS}）のうち保存していないものは消えます。`,
      choices: [
        { value: 'cancel', label: 'キャンセル', testId: 'leave-cancel' },
        { value: 'discard', label: '保存せずに移動', danger: true, testId: 'leave-discard' },
        { value: 'save', label: '保存して移動', primary: true, testId: 'leave-save' },
      ],
    })
      .then(async (choice) => {
        if (choice === 'save') {
          if (await save()) proceed()
          else reset()
        } else if (choice === 'discard') {
          session.discard()
          forgetDraft()
          proceed()
        } else reset()
      })
      .finally(() => {
        asking.current = false
      })
  }, [blocker, session, save, forgetDraft])

  // タブ・アプリを閉じる、再読み込みする時はブラウザの確認を出す（編集は端末内の控えにも残る）。
  // 保存した直後（描き直す前）に閉じても確認を出さないよう、その時のセッションを見る
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!session.isDirty()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, session])
}
