// 原稿画面の推敲案: 上部バーの「推敲案 n」（この話・幕のチェックしていない推敲案）と、押すと開く横（スマホは下）の一覧。
// 一覧の推敲案を押すと、本文（保存していない編集を含む）の中でその箇所を選ぶ。本文が変わっていれば探し直し
// （幕をつないだ・解除した後は属していた話で）、見つからなければ「本文が変わりました（直した可能性）」。
// 別の幕・話にあれば、そこを開いて選ぶ（?ps=<推敲案の id>。戦略タブから開いた時も同じ）。
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reanchor, type ReanchorResult } from '../../claude/anchor'
import { openProofSuggestionsFor, proofStoryRank, sortProofSuggestions } from '../../claude/order'
import { episodeNumbers } from '../../domain/structure'
import type { AppData, ID, Piece, ProofSuggestion, Version } from '../../domain/types'
import { paths } from '../../routes'
import { getData, useData } from '../../store/appStore'
import { notifyError } from '../../store/uiStore'
import { XIcon } from '../../ui/icons'
import { MarkerIcon } from '../claude/claudeIcons'
import { ProofItem } from '../title/strategy/ProofSuggestions'
import { LOST_LABEL, proofPlace, type ProofPlace } from '../title/strategy/proofLogic'
import '../title/strategy/claudeSections.css'
import { caretLine } from './caret'
import { useSessionValue, type EditorHub } from './editorHub'
import './proofPanel.css'
import { versionField } from './session'

/** 保存していない本文の編集も含めたデータ（本文の中の位置を、画面に出ている本文で探す） */
function liveData(data: AppData, hub: EditorHub, active: Version | null): AppData {
  if (!active) return data
  const live = hub.session.display(versionField(active.id, 'body'), active.body)
  if (live === active.body) return data
  return { ...data, versions: { ...data.versions, [active.id]: { ...active, body: live } } }
}

/** 本文欄で [start, end) を選び、その行が見えるようにする（上から3分の1ほどの所に） */
function selectInEditor(hub: EditorHub, active: Version, start: number, end: number): boolean {
  const key = versionField(active.id, 'body')
  if (!hub.focusField(key)) return false
  const el = document.activeElement
  if (!(el instanceof HTMLTextAreaElement)) return false
  const s = Math.max(0, Math.min(start, el.value.length))
  const e = Math.max(s, Math.min(end, el.value.length))
  el.setSelectionRange(s, e)
  if (el.scrollHeight > el.clientHeight) {
    try {
      const { top } = caretLine(el, s)
      el.scrollTop = Math.max(0, top - el.clientHeight / 3)
    } catch {
      /* 測れない環境（テスト）では動かさない */
    }
  }
  return true
}

export interface ProofJumpResult {
  status: 'selected' | 'opened' | 'lost' | 'missing'
}

/**
 * 推敲案の箇所へ移る関数。この話・幕の本文にあれば選び、別の話・幕にあればそこを開く
 */
export function useProofJump(titleId: ID, piece: Piece, active: Version | null, hub: EditorHub) {
  const navigate = useNavigate()
  return useCallback(
    (s: ProofSuggestion): ProofJumpResult => {
      const data = liveData(getData(), hub, active)
      const r: ReanchorResult = reanchor(data, s)
      if (r.status === 'lost') {
        notifyError(LOST_LABEL)
        return { status: 'lost' }
      }
      if (r.pieceId !== piece.id) {
        if (!data.pieces[r.pieceId]) return { status: 'missing' }
        navigate(paths.pieceProof(titleId, r.pieceId, s.id))
        return { status: 'opened' }
      }
      if (!active || r.versionId !== active.id) {
        notifyError(LOST_LABEL)
        return { status: 'lost' }
      }
      selectInEditor(hub, active, r.offset, r.offset + r.length)
      return { status: 'selected' }
    },
    [titleId, piece.id, active, hub, navigate],
  )
}

/** 上部バーの「推敲案 n」 */
export function ProofChip({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`btn pw-proof-btn${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-label={`推敲案 ${count}件（チェックしていないもの）`}
      title="この話・幕の推敲案（チェックしていないもの）"
      onClick={onToggle}
      data-testid="proof-chip"
    >
      <MarkerIcon />
      <span className="pw-proof-text">推敲案</span>
      <span className="pw-proof-count" data-testid="proof-chip-count">
        {count}
      </span>
    </button>
  )
}

export interface ProofPanelProps {
  titleId: ID
  piece: Piece
  active: Version | null
  hub: EditorHub
  /** 開いた時に選ぶ推敲案（?ps=） */
  focusId: ID | null
  onClose: () => void
  jump: (s: ProofSuggestion) => ProofJumpResult
}

/** 横（スマホは下）に開く推敲案の一覧。チェックしたものも、開いている間は斜線で残す */
export function ProofPanel({ titleId, piece, active, hub, focusId, onClose, jump }: ProofPanelProps) {
  const data = useData()
  const open = useMemo(
    () => openProofSuggestionsFor(data, piece.id),
    // 幕は本文で探し直す（reanchor）ので、稿の本文が変わった時も数え直す
    [data.proofSuggestions, data.pieces, data.versions, piece.id], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 開いている間にチェックしたものも残す（チェックを外し直せるように）
  const seen = useRef(new Set<ID>())
  for (const s of open) seen.current.add(s.id)
  const list = useMemo(
    () =>
      sortProofSuggestions(
        [...seen.current].map((id) => data.proofSuggestions[id]).filter((s): s is ProofSuggestion => Boolean(s)),
        proofStoryRank(data, titleId),
      ),
    [open, data.proofSuggestions, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const numbers = useMemo(
    () => episodeNumbers(data, titleId),
    [data.titles, data.chapters, data.pieces, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 保存していない本文の編集も含めて場所を探す（打っている間は少し遅らせて）
  const live = useDeferredValue(useSessionValue(hub.session, active ? versionField(active.id, 'body') : null, active?.body ?? ''))
  const places = useMemo(() => {
    const d = liveData(data, hub, active)
    return new Map<ID, ProofPlace>(list.map((s) => [s.id, proofPlace(d, s, numbers)]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, data, hub, active, numbers, live])
  const [selected, setSelected] = useState<ID | null>(focusId)
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current?.contains(document.activeElement)) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!focusId) return
    setSelected(focusId)
    const items = ref.current?.querySelectorAll<HTMLElement>('[data-proof-id]') ?? []
    for (const el of items) if (el.dataset.proofId === focusId) el.scrollIntoView?.({ block: 'nearest' })
  }, [focusId])

  const onJump = useCallback(
    (s: ProofSuggestion) => {
      setSelected(s.id)
      const r = jump(s)
      // 狭い画面では一覧を閉じて本文を見せる
      if (r.status === 'selected' && window.matchMedia?.('(max-width: 720px)').matches) onClose()
    },
    [jump, onClose],
  )

  return (
    <aside ref={ref} className="pw-proof-panel" aria-labelledby="pw-proof-title" data-testid="proof-panel">
      <div className="pw-proof-head">
        <h2 id="pw-proof-title">
          推敲案<span className="sx-count">{open.length}</span>
        </h2>
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="推敲案の一覧を閉じる"
          data-testid="proof-panel-close"
          // Android の「戻る」で押す（src/platform/nativeInit.ts の closeTopLayer）
          data-back-close="click"
        >
          <XIcon />
        </button>
      </div>
      {list.length === 0 ? (
        <p className="small muted pw-proof-empty">
          この{piece.kind === 'act' ? '幕' : '話'}のチェックしていない推敲案はありません。
        </p>
      ) : (
        <ul className="ps-list pw-proof-list">
          {list.map((s) => (
            <ProofItem key={s.id} s={s} place={places.get(s.id)!} onJump={onJump} compact selected={selected === s.id} />
          ))}
        </ul>
      )}
      <p className="tiny faint pw-proof-foot">押すと本文のその箇所を選びます。直したらチェックしてください。</p>
    </aside>
  )
}
