// 推敲比較の差分を、入力を止めずに計算する。
// 採用原稿は自動保存のたびに変わるので、描画の中では計算しない。少し待ってから（debounce）
// Web Worker で計算し、その間は前回の結果を「計算中」として表示する。
import { useEffect, useRef, useState } from 'react'
import { diffTexts, type DiffSegment } from '../../domain/diff'

/** 本文が変わってから差分を計算し直すまでの待ち時間 */
export const DIFF_DEBOUNCE_MS = 300

interface Job {
  base: string
  target: string
  resolve: (segments: DiffSegment[]) => void
}

/** undefined = まだ作っていない、null = 使えない（メインスレッドで計算する） */
let worker: Worker | null | undefined
let nextId = 0
const jobs = new Map<number, Job>()

/** Worker が使えない環境ではメインスレッドで計算する（描画とは別のタスクで） */
function computeHere(job: Job): void {
  setTimeout(() => job.resolve(diffTexts(job.base, job.target)), 0)
}

function giveUpWorker(): void {
  worker?.terminate()
  worker = null
  for (const job of jobs.values()) computeHere(job)
  jobs.clear()
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    if (typeof Worker === 'undefined') throw new Error('Worker を使えません')
    const w = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; segments: DiffSegment[] | null }>) => {
      const job = jobs.get(e.data.id)
      if (!job) return
      jobs.delete(e.data.id)
      if (e.data.segments) job.resolve(e.data.segments)
      else computeHere(job)
    }
    w.onerror = () => giveUpWorker()
    worker = w
  } catch {
    worker = null
  }
  return worker
}

/** 差分を非同期に計算する */
export function computeDiff(base: string, target: string): Promise<DiffSegment[]> {
  return new Promise((resolve) => {
    const job: Job = { base, target, resolve }
    const w = getWorker()
    if (!w) {
      computeHere(job)
      return
    }
    const id = ++nextId
    jobs.set(id, job)
    w.postMessage({ id, base, target })
  })
}

export interface DiffState {
  /** 表示する差分（このバージョンについてまだ一度も計算できていなければ null） */
  segments: DiffSegment[] | null
  /** 表示中の差分が今の本文より古い（計算し直している） */
  stale: boolean
}

interface DiffResult {
  key: string
  base: string
  target: string
  segments: DiffSegment[]
  seq: number
}

/**
 * base（採用原稿）→ target（推敲バージョン）の差分。保存済みの本文どうしを比べる。
 * key（比較するバージョンの id）が変わったら、前のバージョンの結果は出さない。
 * enabled が false、または base が null（採用原稿なし）なら計算しない。
 */
export function useDiff(key: string, base: string | null, target: string, enabled: boolean): DiffState {
  const [result, setResult] = useState<DiffResult | null>(null)
  const seq = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const usable = enabled && base !== null && result !== null && result.key === key ? result : null
  const hasUsable = usable !== null
  const upToDate = usable !== null && usable.base === base && usable.target === target

  useEffect(() => {
    if (!enabled || base === null || upToDate) return
    // 初回はすぐ、表示中の差分があるときは本文が落ち着くまで待ってから
    const timer = setTimeout(
      () => {
        const mine = ++seq.current
        void computeDiff(base, target).then((segments) => {
          if (!alive.current) return
          // 後から頼んだ計算の結果が先に届いていたら、古い結果では上書きしない
          setResult((prev) => (prev && prev.seq > mine ? prev : { key, base, target, segments, seq: mine }))
        })
      },
      hasUsable ? DIFF_DEBOUNCE_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [enabled, key, base, target, upToDate, hasUsable])

  return { segments: usable?.segments ?? null, stale: usable !== null && !upToDate }
}
