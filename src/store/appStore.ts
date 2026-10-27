// アプリ全体の状態（Zustand）と、IndexedDB への自動保存。
import { create } from 'zustand'
import { createPersistence, type Persistence } from '../db/persistence'
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
let channel: BroadcastChannel | null = null
const tabId = Math.random().toString(36).slice(2)

export async function initStore(p: Persistence = createPersistence()): Promise<void> {
  persistence = p
  try {
    const data = await p.load()
    persisted = data
    const recovered = applyRecoveryJournal(data)
    useApp.setState({ data: recovered.data, status: 'ready', loadError: null, recoveredCount: recovered.count })
    if (recovered.count > 0) {
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

/** 保留中の変更をすぐに保存する（画面を離れる時など） */
export function flushNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pendingSince = null
  chain = chain.then(async () => {
    if (!persistence) return
    const next = useApp.getState().data
    if (next === persisted) {
      if (useApp.getState().saveStatus !== 'error') useApp.setState({ saveStatus: 'saved' })
      return
    }
    useApp.setState({ saveStatus: 'saving' })
    try {
      await persistence.save(persisted, next)
      persisted = next
      const latest = useApp.getState().data
      useApp.setState({ saveStatus: latest === next ? 'saved' : 'pending', saveError: null })
      if (latest !== next) scheduleSave()
      else clearRecoveryJournal()
      channel?.postMessage({ from: tabId })
    } catch (e) {
      useApp.setState({ saveStatus: 'error', saveError: e instanceof Error ? e.message : String(e) })
    }
  })
  return chain
}

/** バックアップから全データを置き換える */
export async function replaceAllData(next: AppData): Promise<void> {
  await flushNow()
  if (!persistence) throw new Error('保存先が初期化されていません')
  await persistence.replaceAll(next)
  persisted = next
  clearRecoveryJournal()
  useApp.setState({ data: next, saveStatus: 'saved', saveError: null })
  channel?.postMessage({ from: tabId })
}

/** 別タブの変更を読み込み直す */
export async function reloadFromDisk(): Promise<void> {
  if (!persistence) return
  await flushNow()
  const data = await persistence.load()
  persisted = data
  useApp.setState({ data, externalChange: false })
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

type AnyRecord = { id: string; updatedAt?: number }

interface RecoveryJournal {
  at: number
  puts: Partial<Record<TableName, AnyRecord[]>>
  dels: Partial<Record<TableName, string[]>>
}

function diffTables(prev: AppData, next: AppData): Omit<RecoveryJournal, 'at'> | null {
  const puts: RecoveryJournal['puts'] = {}
  const dels: RecoveryJournal['dels'] = {}
  let any = false
  for (const t of TABLE_NAMES) {
    const a = prev[t] as Record<string, AnyRecord>
    const b = next[t] as Record<string, AnyRecord>
    if (a === b) continue
    const p: AnyRecord[] = []
    const d: string[] = []
    for (const id in b) if (a[id] !== b[id]) p.push(b[id])
    for (const id in a) if (!(id in b)) d.push(id)
    if (p.length) puts[t] = p
    if (d.length) dels[t] = d
    if (p.length || d.length) any = true
  }
  return any ? { puts, dels } : null
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
    localStorage.setItem(ownJournalKey(), JSON.stringify(journal))
  } catch {
    /* 容量不足などで控えられなくても、通常の保存は続ける */
  }
}

function clearRecoveryJournal(): void {
  try {
    localStorage.removeItem(ownJournalKey())
    for (const k of adoptedJournalKeys) localStorage.removeItem(k)
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
        if (j && typeof j.at === 'number' && typeof j.puts === 'object' && typeof j.dels === 'object') out.push({ key, journal: j })
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
    for (const r of puts) {
      if (!r || typeof r.id !== 'string') continue
      const cur = table[r.id]
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
  })
}
