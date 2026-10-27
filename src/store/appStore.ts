// アプリ全体の状態（Zustand）と、IndexedDB への自動保存。
import { create } from 'zustand'
import { createPersistence, type Persistence } from '../db/persistence'
import { emptyData, type AppData, type TableName } from '../domain/types'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

export interface AppState {
  data: AppData
  status: 'loading' | 'ready' | 'error'
  loadError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  /** 別のタブ・ウィンドウでデータが変更された */
  externalChange: boolean
}

export const useApp = create<AppState>(() => ({
  data: emptyData(),
  status: 'loading',
  loadError: null,
  saveStatus: 'saved',
  saveError: null,
  externalChange: false,
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
    useApp.setState({ data, status: 'ready', loadError: null })
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
  channel?.close()
  channel = null
  useApp.setState({ data: emptyData(), status: 'loading', loadError: null, saveStatus: 'saved', saveError: null, externalChange: false })
}
