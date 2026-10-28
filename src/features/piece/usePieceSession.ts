// 原稿画面の保存ボタンまわり: 編集セッションの保存・破棄、画面を離れる時の確認、端末内の控えと復元。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router-dom'
import type { AppData, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { flushNow, getData } from '../../store/appStore'
import { attempt, notify, notifyError } from '../../store/uiStore'
import { setUnsavedEdits } from '../../store/unsavedEdits'
import { conflictVersionName } from '../../sync/conflicts'
import { formatDateTime } from '../../ui/browser'
import { choiceDialog, confirmDialog } from '../../ui/dialogs'
import { readCrashDraft, removeCrashDraft, resolveCrashDraft, writeCrashDraft, type CrashDraft } from './crashDraft'
import { EditorHub, useSessionDirty } from './editorHub'
import { EditSession, parseFieldKey, versionField, type FieldEdit, type FieldKey } from './session'

/** 編集してから控えを書くまでの待ち時間 */
export const DRAFT_DELAY_MS = 1000
/** 打ち続けていても、この時間ごとには控える */
export const DRAFT_MAX_WAIT_MS = 3000

/** 本文が競合した時の、この端末の本文を残す稿の名前 */
const conflictName = (name: string) => conflictVersionName(name, 'この端末')

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
    const name = data.versions[f.id]?.name.trim() || e.label?.trim() || '無題の稿'
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
  ensureSaved: () => Promise<boolean>
}

export function usePieceSession(pieceId: ID): PieceSession {
  const [session] = useState(() => new EditSession(pieceId))
  const [hub] = useState(() => new EditorHub(session))
  const dirty = useSessionDirty(session)

  // ヘッダーの「保存済み」を、保存していない編集がある間は出さない
  useEffect(() => setUnsavedEdits(dirty), [dirty])
  useEffect(() => () => setUnsavedEdits(false), [])

  const forgetDraft = useCallback(() => {
    removeCrashDraft(session.pieceId)
    session.draftOwned = false
  }, [session])

  const save = useCallback(async (): Promise<boolean> => {
    const edits = session.pendingEdits()
    if (edits.length > 0) {
      const result = attempt(() => actions.savePieceEdits(session.pieceId, edits, { conflictName }))
      if (!result) return false
      const conflicted = new Set(result.conflicts.map((c) => versionField(c.versionId, 'body')))
      session.markSaved(edits, conflicted)
      if (!session.isDirty()) forgetDraft()
      for (const c of result.conflicts) {
        const name = c.originalName.trim() || '無題の稿'
        notify(
          c.reason === 'changed'
            ? `別の端末で「${name}」が書き換えられていたため、この端末の本文を「${c.name}」として残しました`
            : `「${name}」が削除されていたため、この端末の本文を「${c.name}」として残しました`,
        )
      }
    }
    const ok = await flushNow()
    if (ok) notify('保存しました')
    else notifyError('端末に保存できませんでした。端末の空き容量を確認してください。')
    return true
  }, [session, forgetDraft])

  const discard = useCallback(async () => {
    if (!session.isDirty()) return
    const ok = await confirmDialog({
      title: '保存していない編集を破棄しますか？',
      message:
        'この話で保存していない編集（本文・稿の名前・推敲メモ・話の題）をすべて取り消し、保存した時の内容に戻します。元には戻せません。',
      confirmLabel: '破棄',
      danger: true,
    })
    if (!ok) return
    session.discard()
    forgetDraft()
    notify('保存していない編集を破棄しました')
  }, [session, forgetDraft])

  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (!session.isDirty()) return true
    const ok = await confirmDialog({
      title: '保存していない編集があります。保存してから続けますか？',
      message: 'この操作の前に、この話の編集（本文・稿の名前・推敲メモ・話の題）を保存します。',
      confirmLabel: '保存して続ける',
    })
    if (!ok) return false
    return save()
  }, [session, save])

  useCrashDraftWriter(session)
  useRestorePrompt(session)
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
        if (writeCrashDraft(pieceId, session.edits())) session.draftOwned = true
      } else if (session.draftOwned) {
        // 巻き戻して編集が無くなった: 自分で書いた控えは消す（前回の控えにはまだ答えていなければ触らない）
        removeCrashDraft(pieceId)
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

/** 画面を開いた時、前回保存されなかった編集の控えがあれば復元するか聞く */
function useRestorePrompt(session: EditSession): void {
  const asked = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (!asked.current) {
      asked.current = true
      const draft = readCrashDraft(session.pieceId)
      if (draft) void askRestore(session, draft, () => mounted.current)
    }
    return () => {
      mounted.current = false
    }
  }, [session])
}

async function askRestore(session: EditSession, draft: CrashDraft, isMounted: () => boolean): Promise<void> {
  const { pieceId } = session
  const read = (key: FieldKey) => storedFieldValue(getData(), pieceId, key)
  const first = resolveCrashDraft(draft, read)
  if (Object.keys(first).length === 0) {
    // 控えの内容はもう保存されている（別のタブで保存した等）
    removeCrashDraft(pieceId)
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
    removeCrashDraft(pieceId)
    notify('前回の編集の控えを破棄しました')
    return
  }
  // 「復元」と、何も選ばずに閉じた時（控えを失わないよう復元しておく。要らなければ「破棄」で消せる）
  if (session.isDirty()) return
  const edits = resolveCrashDraft(draft, read)
  session.restore(edits)
  session.draftOwned = true
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
  const handled = useRef<unknown>(null)

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      handled.current = null
      return
    }
    // StrictMode などで同じ確認を2回出さない
    if (handled.current === blocker.location) return
    handled.current = blocker.location
    const b = blocker
    void choiceDialog({
      title: '保存していない編集があります',
      message:
        '保存しないで移動すると、この話で書いた内容（本文・稿の名前・推敲メモ・話の題）のうち保存していないものは消えます。',
      choices: [
        { value: 'cancel', label: 'キャンセル', testId: 'leave-cancel' },
        { value: 'discard', label: '保存せずに移動', danger: true, testId: 'leave-discard' },
        { value: 'save', label: '保存して移動', primary: true, testId: 'leave-save' },
      ],
    }).then(async (choice) => {
      if (choice === 'save') {
        if (await save()) b.proceed?.()
        else b.reset?.()
      } else if (choice === 'discard') {
        session.discard()
        forgetDraft()
        b.proceed?.()
      } else b.reset?.()
    })
  }, [blocker, session, save, forgetDraft])

  // タブ・アプリを閉じる、再読み込みする時はブラウザの確認を出す（編集は端末内の控えにも残る）
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
