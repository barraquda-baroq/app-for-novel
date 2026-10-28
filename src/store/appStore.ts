// アプリ全体の状態（Zustand）と、IndexedDB への自動保存・クラウドから届いた変更の反映。
//
// データは3層で持つ:
// - raw:       端末内（IndexedDB）の内容そのもの（このタブが知っている範囲）
// - persisted: raw を整合性の修復（repairData）に通した表示用の内容。保存の差分の基準
// - data:      persisted に、まだ保存していないこのタブの編集を重ねたもの（画面が見る内容）
// 修復は表示用の内容にだけ当て、端末内やクラウドには書き戻さない（利用者が触ったレコードだけ書く）。
// 同期では別の端末の変更が少しずつ届くので、途中の状態（話より先に稿が届いた等）を「直して」書き戻すと、
// 後から届いたものと食い違ってしまうため。
import { create } from 'zustand'
import {
  createPersistence,
  type ActsNoteDetail,
  type AnyRecord,
  type Change,
  type ConflictHooks,
  type ConflictNote,
  type Persistence,
  type SaveOutcome,
} from '../db/persistence'
import { repairData } from '../domain/repair'
import { pieceFullLabel } from '../domain/structure'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'
import { newId } from '../domain/util'
import { createConflictHooks, deviceLabel } from '../sync/conflicts'
import { mergeRemote, TEXT_TABLES } from '../sync/merge'
import { notify } from './uiStore'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

export interface AppState {
  data: AppData
  status: 'loading' | 'ready' | 'error'
  loadError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  /** 別のタブ・ウィンドウでデータが変更された */
  externalChange: boolean
  /** 入力欄にまだストアへ反映していない下書きがある */
  draftsDirty: boolean
  /** 前回の終了時に保存しきれなかった変更を起動時に復元した件数 */
  recoveredCount: number
  /** 別タブの変更と合わせて保存したレコードの数（直近の保存） */
  mergedCount: number
}

export const useApp = create<AppState>(() => ({
  data: emptyData(),
  status: 'loading',
  loadError: null,
  saveStatus: 'saved',
  saveError: null,
  externalChange: false,
  draftsDirty: false,
  recoveredCount: 0,
  mergedCount: 0,
}))

const SAVE_DELAY_MS = 400
/** 操作が続いても、最初の未保存の変更からこの時間以内には必ず保存する */
const SAVE_MAX_WAIT_MS = 2000
const CHANNEL_NAME = 'novel-studio-sync'

let persistence: Persistence | null = null
let raw: AppData = emptyData()
let persisted: AppData = emptyData()
let timer: ReturnType<typeof setTimeout> | null = null
let pendingSince: number | null = null
let chain: Promise<void> = Promise.resolve()
let channel: BroadcastChannel | null = null
const tabId = Math.random().toString(36).slice(2)

type Listener = () => void
const savedListeners = new Set<Listener>()
const externalListeners = new Set<Listener>()

/** 端末内に何か書いた時（同期の送信のきっかけ） */
export function onLocalSave(fn: Listener): () => void {
  savedListeners.add(fn)
  return () => savedListeners.delete(fn)
}

/** 別のタブが端末内に書いた時 */
export function onExternalSave(fn: Listener): () => void {
  externalListeners.add(fn)
  return () => externalListeners.delete(fn)
}

const emit = (set: Set<Listener>) => {
  for (const fn of [...set]) {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  }
}

export function getPersistence(): Persistence | null {
  return persistence
}

export async function initStore(p: Persistence = createPersistence()): Promise<void> {
  persistence = p
  try {
    const loaded = await p.load()
    raw = loaded
    const view = repairData(loaded)
    if (view.fixes.length) console.warn('データの整合性を修復しました（表示用）', view.fixes)
    persisted = view.data
    const recovered = applyRecoveryJournal(view.data)
    // 控えを重ねた結果にも参照切れなどがあれば直す（直した内容は控えと一緒に保存される）
    const data = recovered.count > 0 ? repairData(recovered.data).data : view.data
    useApp.setState({ data, status: 'ready', loadError: null, recoveredCount: recovered.count })
    if (recovered.count > 0) {
      // 取り込んだ控えは、このタブの控えとして1つにまとめ直してから古いものを消す
      // （保存に失敗し続けても、起動のたびに控えが増えていかないように）
      writeRecoveryJournal()
      removeAdoptedJournals()
      useApp.setState({ saveStatus: 'pending' })
      scheduleSave()
    } else {
      clearRecoveryJournal()
    }
  } catch (e) {
    useApp.setState({ status: 'error', loadError: e instanceof Error ? e.message : String(e) })
    return
  }
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
    if (channel) {
      channel.onmessage = (ev: MessageEvent<{ from: string }>) => {
        if (ev.data?.from === tabId) return
        emit(externalListeners)
        const s = useApp.getState()
        // このタブに未保存の編集が無ければ、黙って読み込み直す
        if (s.data === persisted && !s.draftsDirty && s.saveStatus === 'saved') void reloadFromDisk()
        else useApp.setState({ externalChange: true })
      }
    }
  } catch {
    channel = null
  }
}

/** 新しいデータを反映し、少し待ってから保存する */
export function commit(next: AppData): void {
  const { data } = useApp.getState()
  if (next === data) return
  useApp.setState({ data: next, saveStatus: 'pending' })
  scheduleSave()
}

function scheduleSave(): void {
  const t = Date.now()
  if (pendingSince === null) pendingSince = t
  if (timer) clearTimeout(timer)
  const delay = Math.max(0, Math.min(SAVE_DELAY_MS, pendingSince + SAVE_MAX_WAIT_MS - t))
  timer = setTimeout(() => {
    timer = null
    void flushNow()
  }, delay)
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000]

function scheduleRetry(): void {
  if (retryTimer) return
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
  retryCount += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushNow()
  }, delay)
}

type Tables = Record<TableName, Record<string, AnyRecord>>

/** 変化をデータに当てる（変わった表だけ複製する） */
export function applyChanges(base: AppData, changes: readonly Change[]): AppData {
  if (!changes.length) return base
  const out = { ...base } as unknown as Tables
  const copied = new Set<TableName>()
  for (const ch of changes) {
    if (!(ch.table in out)) continue
    if (!copied.has(ch.table)) {
      out[ch.table] = { ...out[ch.table] }
      copied.add(ch.table)
    }
    if (ch.record) out[ch.table][ch.id] = ch.record
    else delete out[ch.table][ch.id]
  }
  return out as unknown as AppData
}

/** 別タブの変更と合わせて保存した結果（と競合の控え）を、メモリ上のデータにも反映する */
function reconcile(saved: AppData, outcome: SaveOutcome): AppData {
  const changes: Change[] = []
  for (const t of Object.keys(outcome.merged) as TableName[])
    for (const r of outcome.merged[t] ?? []) changes.push({ table: t, id: r.id, record: r })
  for (const t of Object.keys(outcome.dropped) as TableName[])
    for (const id of outcome.dropped[t] ?? []) changes.push({ table: t, id, record: null })
  changes.push(...outcome.extra)
  return applyChanges(saved, changes)
}

// ---------- 競合の控え（どちらの文章も消さない） ----------

/** 競合の控え方。report で集めたものは、保存・反映が終わってからまとめて知らせる */
function conflictHooks(notes: ConflictNote[]): ConflictHooks {
  // 控えの表記（話の番号・名前）は、保存・反映する前の表示用の内容で作る
  return createConflictHooks({ device: deviceLabel(), data: () => persisted, newId, report: (n) => notes.push(n) })
}

/** 幕の知らせを、同じ話に重なった時に1つだけ出す順（前ほど優先） */
const ACTS_NOTE_ORDER: ActsNoteDetail[] = [
  'lost',
  'won',
  'deletedHere',
  'deletedThere',
  'mineDropped',
  'theirsDropped',
  'stale',
  'source',
]

/** 幕（2.2）の構成が別の端末と重なった時の知らせの文。label は「第3話　題」 */
export function actsNoteMessage(detail: ActsNoteDetail, label: string, kept?: { versions: number; trash: number }): string {
  const where = !kept
    ? ''
    : kept.versions && kept.trash
      ? '稿の一覧とゴミ箱'
      : kept.versions
        ? '稿の一覧'
        : kept.trash
          ? 'ゴミ箱'
          : ''
  switch (detail) {
    case 'lost':
      return `${label}の幕の分け方が別の端末と同時に変わりました。別の端末の分け方に合わせ、この端末での幕の操作は取り消しました${where ? `（この端末で作った稿は${where}に残しています）` : ''}`
    case 'won':
      return `${label}の幕の分け方が別の端末と同時に変わりました。この端末のセパレート解除を優先し${where ? `、別の端末で分けた・つないだ幕の稿は${where}に残しました` : 'ました'}`
    case 'deletedHere':
      return `${label}を削除したため、別の端末で同時に分けた・つないだ幕の稿はゴミ箱に残しました`
    case 'deletedThere':
      return `${label}は別の端末で削除されていました。この端末で分けた・つないだ幕の稿はゴミ箱に残しました（話をゴミ箱から戻すと、幕の稿も戻せます）`
    case 'mineDropped':
      return `${label}の幕が別の端末で分けられた・つながれたため、この端末での編集・採用の一部が採用原稿に入っていません${where ? `（${where}に残しています）` : ''}`
    case 'theirsDropped':
      return `${label}の幕の操作と同時に別の端末で書き換えられた・採用された稿は、採用原稿に入れていません${where ? `（${where}に残しました）` : ''}`
    case 'stale':
      return `${label}の幕は、書き換えられる前の稿から分けられた・つながれた（セパレート解除で話の稿にまとめられた時も）ため、その書き換えが採用原稿に入っていません（書き換えた稿は稿の一覧に残っています）`
    case 'source':
      return `${label}の分ける前の採用稿が別の端末で書き換えられていました。書き換えた本文は幕に入っていません（分ける前の稿に残っています）`
  }
}

/**
 * 競合を控えたことを知らせる文（知らせるものが無ければ null）。
 * 幕の知らせは話ごとに1つ（重なったら ACTS_NOTE_ORDER の前のもの）。話の表記は views（反映する前・後の表示用の内容）の順に探す
 */
export function conflictMessage(notes: readonly ConflictNote[], views: readonly AppData[] = []): string | null {
  if (!notes.length) return null
  const best = new Map<string, Extract<ConflictNote, { kind: 'acts' }>>()
  for (const n of notes) {
    if (n.kind !== 'acts') continue
    const cur = best.get(n.id)
    if (!cur || ACTS_NOTE_ORDER.indexOf(n.detail) < ACTS_NOTE_ORDER.indexOf(cur.detail)) best.set(n.id, n)
  }
  const labelOf = (id: string) => {
    for (const v of views) {
      const p = v.pieces[id]
      if (p) return pieceFullLabel(v, p)
    }
    return '幕に分けた話'
  }
  const parts: string[] = [...best.values()].map((n) => actsNoteMessage(n.detail, labelOf(n.id), n.kept))
  const copies = notes.filter((n) => n.kind === 'versionCopy').length
  const trashed = notes.filter((n) => n.kind === 'trash').length
  const joined = notes.filter((n) => n.kind === 'joined').length
  if (copies) parts.push(`本文が両方で書き換えられた稿 ${copies} 件を、この端末の本文を別の稿として残しました`)
  if (trashed) parts.push(`削除と編集が重なった内容など ${trashed} 件をゴミ箱に残しました`)
  if (joined) parts.push(`両方で書き換えられた文章 ${joined} 件は、両方の文章をつないで残しました`)
  if (!parts.length) return null
  return `ほかの端末と同時に編集されていました。${parts.join('。')}。`
}

/** 競合を控えたことを知らせる */
function announceConflicts(notes: ConflictNote[], views: readonly AppData[] = []): void {
  const message = conflictMessage(notes, views)
  if (message) notify(message)
}

/**
 * oldBase から newBase への変化を、その後に編集された latest に重ねる。
 * このタブでも編集し直したレコードは、項目ごとに合わせる（同期と同じ規則。稿の本文が両方で変わっていたら
 * newBase 側を採り、このタブの稿を別の稿として残す）。
 */
export function rebaseView(latest: AppData, oldBase: AppData, newBase: AppData): AppData {
  if (latest === oldBase) return newBase
  const out = { ...latest } as unknown as Tables
  const extras: Change[] = []
  const hooks = conflictHooks([])
  for (const t of TABLE_NAMES) {
    const o = oldBase[t] as Record<string, AnyRecord>
    const n = newBase[t] as Record<string, AnyRecord>
    if (o === n) continue
    const l = latest[t] as Record<string, AnyRecord>
    let table = l
    const write = (id: string, rec: AnyRecord | null) => {
      if (table === l) table = { ...l }
      if (rec) table[id] = rec
      else delete table[id]
    }
    const ids = new Set([...Object.keys(o), ...Object.keys(n)])
    for (const id of ids) {
      if (o[id] === n[id]) continue
      const mine = l[id]
      if (mine === o[id]) {
        write(id, n[id] ?? null)
        continue
      }
      // このタブでも編集していた
      const r = mergeRemote(t, o[id] ?? null, mine ?? null, n[id] ?? null, { device: deviceLabel() })
      if (r.record !== mine) write(id, r.record)
      if (r.bodyConflict) extras.push({ table: 'versions', id: '', record: hooks.versionCopy(r.bodyConflict) })
      for (const kept of [r.deletedEdit, r.keptCopy]) if (kept && TEXT_TABLES.has(t)) extras.push(...hooks.trashCopy(t, kept))
    }
    out[t] = table
  }
  let result = out as unknown as AppData
  for (const ex of extras) {
    if (!ex.record) continue
    result = applyChanges(result, [{ table: ex.table, id: ex.record.id, record: ex.record }])
    const pieceId = (ex.record as { pieceId?: string }).pieceId
    const piece = ex.table === 'versions' && pieceId ? result.pieces[pieceId] : undefined
    if (piece && !piece.versionIds.includes(ex.record.id)) {
      result = applyChanges(result, [
        {
          table: 'pieces',
          id: piece.id,
          record: { ...piece, versionIds: [...piece.versionIds, ex.record.id], updatedAt: Date.now() } as AnyRecord,
        },
      ])
    }
  }
  return result
}

/** 保留中の変更を保存する（chain の中で呼ぶ） */
async function saveOnce(): Promise<boolean> {
  if (!persistence) return true
  const next = useApp.getState().data
  if (next === persisted) {
    if (useApp.getState().saveStatus !== 'error') useApp.setState({ saveStatus: 'saved' })
    return useApp.getState().saveStatus !== 'error'
  }
  useApp.setState({ saveStatus: 'saving' })
  try {
    const notes: ConflictNote[] = []
    const outcome = await persistence.save(persisted, next, conflictHooks(notes))
    const dropped: Change[] = []
    for (const t of Object.keys(outcome.dropped) as TableName[])
      for (const id of outcome.dropped[t] ?? []) dropped.push({ table: t, id, record: null })
    raw = applyChanges(raw, [...outcome.written, ...dropped])
    const mergedCount = Object.values(outcome.merged).reduce((n, a) => n + (a?.length ?? 0), 0) + dropped.length
    // 別タブの変更と合わせたレコードは、修復した表示用の内容にしてから使う
    const written = mergedCount > 0 ? repairData(reconcile(next, outcome)).data : next
    persisted = written
    const latest = useApp.getState().data
    if (latest === next) {
      useApp.setState({ data: written, saveStatus: 'saved', saveError: null, mergedCount })
      clearRecoveryJournal()
    } else {
      useApp.setState({ data: rebaseView(latest, next, written), saveStatus: 'pending', saveError: null, mergedCount })
      scheduleSave()
    }
    retryCount = 0
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (outcome.written.length) {
      channel?.postMessage({ from: tabId })
      emit(savedListeners)
    }
    announceConflicts(notes)
    return true
  } catch (e) {
    useApp.setState({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) })
    scheduleRetry()
    return false
  }
}

/**
 * 保留中の変更をすぐに保存する（画面を離れる時など）。
 * 保存できたら true、失敗したら false で終わる（失敗時は少し待って自動で再試行する）。
 */
export function flushNow(): Promise<boolean> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pendingSince = null
  const run = chain.then(saveOnce)
  chain = run.then(() => undefined)
  return run
}

/**
 * クラウドから届いた変更を反映する（同期を受け持つタブだけが呼ぶ）。
 * 先にこのタブの未保存の変更を保存し、端末内で送信待ちと3者マージしてから、画面の内容にも重ねる。
 * 実際に端末内に書いた内容を返す。
 */
export function applyRemoteChanges(
  changes: Change[],
  cursor?: unknown,
  opts: { direct?: boolean } = {},
): Promise<Change[] | null> {
  const run = chain.then(async (): Promise<Change[] | null> => {
    if (!persistence) throw new Error('保存先が初期化されていません')
    if (!(await saveOnce())) throw new Error('この端末の変更を保存できないため、クラウドの変更を反映できません')
    const notes: ConflictNote[] = []
    const before = persisted
    const written = await persistence.applyRemote(changes, { cursor, ...opts, ...conflictHooks(notes) })
    if (!written || !written.length) {
      announceConflicts(notes, [before])
      return written
    }
    raw = applyChanges(raw, written)
    const view = repairData(raw).data
    // 知らせる話の表記（第n話　題）は、反映する前の表示用の内容（無ければ反映した後）で作る
    announceConflicts(notes, [before, view])
    const oldBase = persisted
    persisted = view
    const latest = useApp.getState().data
    const next = rebaseView(latest, oldBase, view)
    if (next === view) useApp.setState({ data: next })
    else {
      useApp.setState({ data: next, saveStatus: 'pending' })
      scheduleSave()
    }
    // 端末内に新しく積んだ送信待ち（競合の控え）があれば送ってもらう
    emit(savedListeners)
    channel?.postMessage({ from: tabId })
    return written
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** バックアップから全データを置き換える */
export async function replaceAllData(input: AppData): Promise<void> {
  await flushNow()
  if (!persistence) throw new Error('保存先が初期化されていません')
  const p = persistence
  const run = chain.then(async () => {
    // 表が欠けた古い形のデータや参照切れも、ここで補ってから保存する（読み込んだ内容そのものを正とする）
    const next = repairData({ ...emptyData(), ...input }).data
    await p.replaceAll(next)
    raw = next
    persisted = next
    clearRecoveryJournal()
    useApp.setState({ data: next, saveStatus: 'saved', saveError: null })
    channel?.postMessage({ from: tabId })
    emit(savedListeners)
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  await run
}

/**
 * 別タブの変更を読み込み直す。先にこのタブの変更を保存する（別タブが先に変えた項目は上書きせずに合わせる）。
 * このタブの保存に失敗している時は、読み込み直すと未保存の変更が消えるので読み込まない。
 */
export async function reloadFromDisk(): Promise<boolean> {
  if (!persistence) return false
  const p = persistence
  const saved = await flushNow()
  if (!saved) return false
  const run = chain.then(async () => {
    const loaded = await p.load()
    raw = loaded
    const view = repairData(loaded).data
    const oldBase = persisted
    persisted = view
    const latest = useApp.getState().data
    const next = rebaseView(latest, oldBase, view)
    useApp.setState({ data: next, externalChange: false })
    if (next !== view) scheduleSave()
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  await run
  return true
}

// ---------- 復旧用の控え（localStorage） ----------
// IndexedDB への書き込みは非同期なので、画面を閉じる直前に始めた保存は完了する保証がない。
// そこで閉じる・裏に回る時に「まだ保存できていない変更」を localStorage に同期的に控えておき、
// 次回起動時に IndexedDB の内容より新しいものだけを書き戻す。

// タブごとに別のキーに控える（別タブの保存完了で、このタブの控えが消えないように）
const JOURNAL_PREFIX = 'novel-studio:recovery:'
const ownJournalKey = () => JOURNAL_PREFIX + tabId
/** 起動時に適用した（他のタブや前回の）控え。保存が終わったら消す */
let adoptedJournalKeys: string[] = []

interface RecoveryJournal {
  at: number
  puts: Partial<Record<TableName, AnyRecord[]>>
  dels: Partial<Record<TableName, string[]>>
  /** このタブで新しく作ったレコード（保存先に無くても書き戻してよいもの） */
  created?: Partial<Record<TableName, string[]>>
}

/** 控えの大きさの上限（localStorage は 5MB 程度。UTF-16 で数えた文字数） */
const JOURNAL_BUDGET = 2_000_000
/** 控えきれない時に先に諦める順（後ろほど大事） */
const JOURNAL_DROP_ORDER: TableName[] = [
  'trashRecords',
  'trashEntries',
  'snapshotTexts',
  'submissions',
  'settingCategories',
  'settingEntries',
  'ideas',
  'memos',
  'titles',
  'chapters',
  'pieces',
  'versions',
]

function diffTables(prev: AppData, next: AppData): Omit<RecoveryJournal, 'at'> | null {
  const puts: RecoveryJournal['puts'] = {}
  const dels: RecoveryJournal['dels'] = {}
  const created: NonNullable<RecoveryJournal['created']> = {}
  let any = false
  for (const t of TABLE_NAMES) {
    const a = prev[t] as Record<string, AnyRecord>
    const b = next[t] as Record<string, AnyRecord>
    if (a === b) continue
    const p: AnyRecord[] = []
    const d: string[] = []
    const c: string[] = []
    for (const id in b) {
      if (a[id] === b[id]) continue
      p.push(b[id])
      if (!(id in a)) c.push(id)
    }
    for (const id in a) if (!(id in b)) d.push(id)
    if (p.length) puts[t] = p
    if (d.length) dels[t] = d
    if (c.length) created[t] = c
    if (p.length || d.length) any = true
  }
  return any ? { puts, dels, created } : null
}

/** 上限に収まるよう、大事でない表から順に控えを諦める */
function fitJournal(journal: RecoveryJournal): string | null {
  let json = JSON.stringify(journal)
  for (const t of JOURNAL_DROP_ORDER) {
    if (json.length <= JOURNAL_BUDGET) return json
    if (!journal.puts[t]) continue
    delete journal.puts[t]
    if (journal.created) delete journal.created[t]
    json = JSON.stringify(journal)
  }
  return json.length <= JOURNAL_BUDGET ? json : null
}

/** まだ保存できていない変更を localStorage に控える。保存済みなら控えを消す */
export function writeRecoveryJournal(): void {
  const next = useApp.getState().data
  if (!persistence || useApp.getState().status !== 'ready') return
  const diff = diffTables(persisted, next)
  try {
    if (!diff) {
      localStorage.removeItem(ownJournalKey())
      return
    }
    const journal: RecoveryJournal = { at: Date.now(), ...diff }
    const json = fitJournal(journal)
    if (json === null) {
      localStorage.removeItem(ownJournalKey())
      return
    }
    try {
      localStorage.setItem(ownJournalKey(), json)
    } catch {
      // 容量不足: 古い控えを消し、原稿（推敲バージョン）だけでも控える
      localStorage.removeItem(ownJournalKey())
      const minimal: RecoveryJournal = {
        at: journal.at,
        puts: { versions: journal.puts.versions },
        dels: {},
        created: { versions: journal.created?.versions },
      }
      if (minimal.puts.versions?.length) localStorage.setItem(ownJournalKey(), JSON.stringify(minimal))
    }
  } catch (e) {
    /* 控えられなくても、通常の保存は続ける */
    console.warn('復旧用の控えを書けませんでした', e)
  }
}

function clearRecoveryJournal(): void {
  try {
    localStorage.removeItem(ownJournalKey())
  } catch {
    /* noop */
  }
  removeAdoptedJournals()
}

function removeAdoptedJournals(): void {
  try {
    for (const k of adoptedJournalKeys) if (k !== ownJournalKey()) localStorage.removeItem(k)
  } catch {
    /* noop */
  }
  adoptedJournalKeys = []
}

function readRecoveryJournals(): { key: string; journal: RecoveryJournal }[] {
  const out: { key: string; journal: RecoveryJournal }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(JOURNAL_PREFIX)) continue
      try {
        const j = JSON.parse(localStorage.getItem(key) ?? '') as RecoveryJournal
        if (j && typeof j.at === 'number' && typeof j.puts === 'object' && typeof j.dels === 'object')
          out.push({ key, journal: j })
        else localStorage.removeItem(key)
      } catch {
        localStorage.removeItem(key)
      }
    }
  } catch {
    return []
  }
  return out.sort((a, b) => a.journal.at - b.journal.at)
}

/** 控え（古い順）のうち、読み込んだデータより新しい変更だけを適用する */
export function applyRecoveryJournal(base: AppData): { data: AppData; count: number } {
  const journals = readRecoveryJournals()
  adoptedJournalKeys = journals.map((j) => j.key)
  let data = base
  let count = 0
  for (const { journal } of journals) {
    const r = applyOneJournal(data, journal)
    data = r.data
    count += r.count
  }
  return { data, count }
}

function applyOneJournal(base: AppData, j: RecoveryJournal): { data: AppData; count: number } {
  const data = { ...base } as Record<TableName, Record<string, AnyRecord>>
  let count = 0
  for (const t of TABLE_NAMES) {
    const puts = j.puts[t] ?? []
    const dels = j.dels[t] ?? []
    if (!puts.length && !dels.length) continue
    let table = data[t]
    const ensure = () => {
      if (table === base[t]) table = { ...table }
    }
    const created = new Set(j.created?.[t] ?? [])
    for (const r of puts) {
      if (!r || typeof r.id !== 'string') continue
      const cur = table[r.id]
      // 保存先に無いのに、このタブで新しく作ったものでない = 後で別タブが削除した。復活させない
      // （古い形式の控えには created が無いので、従来どおり書き戻す）
      if (!cur && j.created && !created.has(r.id)) continue
      if (cur && (cur.updatedAt ?? 0) > (r.updatedAt ?? 0)) continue
      if (cur && JSON.stringify(cur) === JSON.stringify(r)) continue
      ensure()
      table[r.id] = r
      count += 1
    }
    for (const id of dels) {
      const cur = table[id]
      if (!cur || (cur.updatedAt ?? 0) > j.at) continue
      ensure()
      delete table[id]
      count += 1
    }
    data[t] = table
  }
  return { data: data as unknown as AppData, count }
}

export function getData(): AppData {
  return useApp.getState().data
}

// ---------- React 用の小さなセレクタ ----------

export function useData(): AppData {
  return useApp((s) => s.data)
}

export function useRecord<T extends TableName>(table: T, id: string | null | undefined): AppData[T][string] | undefined {
  return useApp((s) => (id ? (s.data[table][id] as AppData[T][string] | undefined) : undefined))
}

/** テスト用: 状態とタイマーを初期化する */
export function resetStoreForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pendingSince = null
  chain = Promise.resolve()
  persistence = null
  raw = emptyData()
  persisted = emptyData()
  savedListeners.clear()
  externalListeners.clear()
  adoptedJournalKeys = []
  retryCount = 0
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  channel?.close()
  channel = null
  useApp.setState({
    data: emptyData(),
    status: 'loading',
    loadError: null,
    saveStatus: 'saved',
    saveError: null,
    externalChange: false,
    draftsDirty: false,
    recoveredCount: 0,
    mergedCount: 0,
  })
}
