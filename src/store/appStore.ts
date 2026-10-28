// アプリ全体の状態（Zustand）と、IndexedDB への自動保存。
import { create } from 'zustand'
import { createPersistence, type Persistence, type SaveOutcome } from '../db/persistence'
import { repairData } from '../domain/repair'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'

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
let persisted: AppData = emptyData()
let timer: ReturnType<typeof setTimeout> | null = null
let pendingSince: number | null = null
let chain: Promise<void> = Promise.resolve()
type AnyRecord = { id: string; updatedAt?: number }
let channel: BroadcastChannel | null = null
const tabId = Math.random().toString(36).slice(2)

export async function initStore(p: Persistence = createPersistence()): Promise<void> {
  persistence = p
  try {
    const data = await p.load()
    persisted = data
    const recovered = applyRecoveryJournal(data)
    // 参照切れなどがあれば直してから使う（直した内容は保存される）
    const repaired = repairData(recovered.data)
    if (repaired.fixes.length) console.warn('データの整合性を修復しました', repaired.fixes)
    useApp.setState({ data: repaired.data, status: 'ready', loadError: null, recoveredCount: recovered.count })
    if (recovered.count > 0 || repaired.fixes.length > 0) {
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
        if (ev.data?.from !== tabId) useApp.setState({ externalChange: true })
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

/** 別タブの変更と合わせて保存した結果を、メモリ上のデータにも反映する */
function reconcile(saved: AppData, outcome: SaveOutcome | void): AppData {
  if (!outcome) return saved
  const touched = Object.keys(outcome.merged).length + Object.keys(outcome.dropped).length
  if (touched === 0) return saved
  const out = { ...saved } as Record<TableName, Record<string, AnyRecord>>
  for (const t of Object.keys(outcome.merged) as TableName[]) {
    out[t] = { ...out[t] }
    for (const r of outcome.merged[t] ?? []) out[t][r.id] = r
  }
  for (const t of Object.keys(outcome.dropped) as TableName[]) {
    out[t] = { ...out[t] }
    for (const id of outcome.dropped[t] ?? []) delete out[t][id]
  }
  return out as unknown as AppData
}

/** saved（保存した内容）から result（実際に書いた内容）への変化を、その後に編集された latest に重ねる */
function rebase(latest: AppData, saved: AppData, result: AppData): AppData {
  if (saved === result) return latest
  const out = { ...latest } as Record<TableName, Record<string, AnyRecord>>
  for (const t of TABLE_NAMES) {
    const s = saved[t] as Record<string, AnyRecord>
    const r = result[t] as Record<string, AnyRecord>
    if (s === r) continue
    let table = out[t]
    for (const id in s) {
      if (r[id] === s[id]) continue
      // その後このタブで編集し直したレコードは、このタブの内容を優先する
      if (table[id] !== s[id]) continue
      if (table === latest[t]) table = { ...table }
      if (id in r) table[id] = r[id]
      else delete table[id]
    }
    out[t] = table
  }
  return out as unknown as AppData
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
  const run = chain.then(async (): Promise<boolean> => {
    if (!persistence) return true
    const next = useApp.getState().data
    if (next === persisted) {
      if (useApp.getState().saveStatus !== 'error') useApp.setState({ saveStatus: 'saved' })
      return useApp.getState().saveStatus !== 'error'
    }
    useApp.setState({ saveStatus: 'saving' })
    try {
      const outcome = await persistence.save(persisted, next)
      const written = reconcile(next, outcome)
      persisted = written
      const latest = useApp.getState().data
      const mergedCount = outcome
        ? Object.values(outcome.merged).reduce((n, a) => n + (a?.length ?? 0), 0) +
          Object.values(outcome.dropped).reduce((n, a) => n + (a?.length ?? 0), 0)
        : 0
      if (latest === next) {
        useApp.setState({ data: written, saveStatus: 'saved', saveError: null, mergedCount })
        clearRecoveryJournal()
      } else {
        useApp.setState({ data: rebase(latest, next, written), saveStatus: 'pending', saveError: null, mergedCount })
        scheduleSave()
      }
      retryCount = 0
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      channel?.postMessage({ from: tabId })
      return true
    } catch (e) {
      useApp.setState({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) })
      scheduleRetry()
      return false
    }
  })
  chain = run.then(() => undefined)
  return run
}

/** バックアップから全データを置き換える */
export async function replaceAllData(input: AppData): Promise<void> {
  await flushNow()
  if (!persistence) throw new Error('保存先が初期化されていません')
  // 表が欠けた古い形のデータや参照切れも、ここで補ってから保存する
  const next = repairData({ ...emptyData(), ...input }).data
  await persistence.replaceAll(next)
  persisted = next
  clearRecoveryJournal()
  useApp.setState({ data: next, saveStatus: 'saved', saveError: null })
  channel?.postMessage({ from: tabId })
}

/**
 * 別タブの変更を読み込み直す。先にこのタブの変更を保存する（別タブが先に変えた項目は上書きせずに合わせる）。
 * このタブの保存に失敗している時は、読み込み直すと未保存の変更が消えるので読み込まない。
 */
export async function reloadFromDisk(): Promise<boolean> {
  if (!persistence) return false
  const saved = await flushNow()
  if (!saved) return false
  const loaded = await persistence.load()
  const data = repairData(loaded).data
  persisted = loaded
  useApp.setState({ data, externalChange: false })
  if (data !== loaded) scheduleSave()
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
  persisted = emptyData()
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
