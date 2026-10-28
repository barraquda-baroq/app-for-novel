// 推敲バージョン（右／下）。一覧から選ぶと、採用原稿と並べて比較・編集できる。
import { memo, useCallback, useDeferredValue, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { diffSummary } from '../../domain/diff'
import { submissionsReferencingVersion } from '../../domain/entityOps'
import { bodyMetrics, formatCount } from '../../domain/text'
import type { ID, Piece, Version } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { copyText, formatDateTime, formatRelative, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DraftInput, DraftTextarea, type DraftHandle } from '../../ui/DraftField'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, MoreIcon, NoteIcon, PlusIcon, TrashIcon } from '../../ui/icons'
import { DiffView } from './DiffView'
import { commitVersion, flushEditors, versionBodyGuard, tryRun, useDismiss, useLiveText, useRegisteredDraft } from './editing'
import {
  firstLine,
  formatCharDelta,
  formatStats,
  liveStats,
  selectionAfterAdopt,
  versionDeleteMessage,
  versionDisplayName,
  versionRows,
  versionsNewestFirst,
} from './logic'
import { ReviseIcon } from './pieceIcons'
import { useDiff } from './useDiff'

/** 原稿画面の各ペインが共有するもの */
export interface WorkspaceApi {
  piece: Piece
  titleId: ID
  orientation: 'horizontal' | 'vertical'
  activeEditor: RefObject<DraftHandle | null>
  compareEditor: RefObject<DraftHandle | null>
  noteEditor: RefObject<DraftHandle | null>
  /** 比較する推敲バージョンを選ぶ（null で一覧に戻る） */
  select: (versionId: ID | null) => void
}

interface PaneProps {
  api: WorkspaceApi
  active: Version | null
  selected: Version | null
  showDiff: boolean
}

export function VersionsPane({ api, active, selected, showDiff }: PaneProps) {
  if (selected) return <CompareView api={api} active={active} selected={selected} showDiff={showDiff} />
  return <VersionList api={api} active={active} />
}

function deltaClass(delta: number): string {
  return delta > 0 ? 'pw-delta plus' : delta < 0 ? 'pw-delta minus' : 'pw-delta'
}

// ---------- 一覧 ----------

function VersionList({ api, active }: { api: WorkspaceApi; active: Version | null }) {
  const data = useData()
  const { piece } = api
  const rows = useMemo(() => versionRows(data, piece), [data, piece])
  const minute = Math.floor(Date.now() / 60_000)

  const addBlank = () => {
    const id = attempt(() => actions.addVersion(piece.id))
    if (id) api.select(id)
  }

  const duplicateActive = () => {
    if (!active) return
    flushEditors(api.activeEditor)
    const id = attempt(() => actions.duplicateVersion(active.id))
    if (id) api.select(id)
  }

  const { activeEditor } = api
  const pieceId = piece.id
  const adopt = useCallback(
    (v: Version) => {
      flushEditors(activeEditor)
      if (tryRun(() => actions.setActiveVersion(pieceId, v.id))) notify(`${versionDisplayName(v)}を採用しました`)
    },
    [activeEditor, pieceId],
  )

  return (
    <div className="pw-pane pw-pane-versions" data-testid="versions-pane">
      <div className="pw-head">
        <h2 className="pw-head-title" data-testid="versions-heading">
          推敲バージョン（{rows.length}）
        </h2>
        {/* 狭いペインでは「＋白紙」「推敲」と短く出す（指で操作する端末ではツールチップが出ないので文字は消さない） */}
        <div className="pw-tools" role="group" aria-label="推敲バージョンの追加">
          <button
            type="button"
            className="btn pw-tbtn"
            onClick={addBlank}
            title="白紙の推敲バージョンを追加する"
            data-testid="add-blank-version"
          >
            <PlusIcon />
            <span className="pw-tlabel pw-tlabel-keep">
              白紙<span className="pw-tlabel-long">の稿</span>
            </span>
          </button>
          <button
            type="button"
            className="btn pw-tbtn"
            onClick={duplicateActive}
            disabled={!active}
            title={active ? '採用原稿を複製して新しい推敲バージョンを作り、並べて編集する' : '採用原稿がありません'}
            data-testid="duplicate-active-list"
          >
            <ReviseIcon />
            <span className="pw-tlabel pw-tlabel-keep">
              <span className="pw-tlabel-long">複製して</span>推敲
            </span>
          </button>
        </div>
      </div>
      <div className="pw-body pw-scroll">
        {rows.length === 0 ? (
          <div className="empty pw-list-empty">
            推敲バージョンがありません。
            <br />
            「白紙の稿」で新しいバージョンを作れます。
          </div>
        ) : (
          <>
            <p className="pw-hint">バージョンを選ぶと、採用原稿と並べて比較できます。</p>
            <ul className="pw-vlist">
              {rows.map((r) => (
                <VersionRow
                  key={r.version.id}
                  version={r.version}
                  isActive={r.isActive}
                  chars={r.chars}
                  delta={r.delta}
                  note={r.note}
                  minute={minute}
                  onOpen={api.select}
                  onAdopt={adopt}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

interface VersionRowProps {
  version: Version
  isActive: boolean
  chars: number
  delta: number | null
  note: string
  /** 「3分前」などの表記を描き直すきっかけ（分が変わった後に一覧を描き直す時だけ行も描き直す） */
  minute: number
  onOpen: (versionId: ID) => void
  onAdopt: (version: Version) => void
}

/** 一覧の1行。自動保存で描き直す時は、変わった稿の行だけを描き直す */
const VersionRow = memo(function VersionRow({ version, isActive, chars, delta, note, onOpen, onAdopt }: VersionRowProps) {
  const name = versionDisplayName(version)
  return (
    <li className={`pw-vrow${isActive ? ' is-active' : ''}`} data-testid="version-row">
      <button
        type="button"
        className="pw-vrow-main"
        onClick={() => onOpen(version.id)}
        aria-label={`${name}${isActive ? '（採用中）' : ''}を開いて比較する`}
      >
        <span className="pw-vrow-top">
          <span className="pw-vrow-name">{name}</span>
          {isActive ? <span className="badge badge-active">採用中</span> : null}
        </span>
        <span className="pw-vrow-meta">
          <span title={formatDateTime(version.updatedAt)}>{formatRelative(version.updatedAt)}</span>
          <span aria-hidden="true">・</span>
          <span>{formatCount(chars)}字</span>
          {delta !== null ? (
            <span className={deltaClass(delta)} title="採用原稿との文字数の差">
              {formatCharDelta(delta)}
            </span>
          ) : null}
        </span>
        {note ? (
          <span className="pw-vrow-note">
            <NoteIcon />
            <span className="ellipsis">{note}</span>
          </span>
        ) : null}
      </button>
      <span className="pw-vrow-side">
        {isActive ? null : (
          <button
            type="button"
            className="btn pw-tbtn pw-row-adopt"
            onClick={() => onAdopt(version)}
            aria-label={`${name}を採用する`}
            data-testid="row-adopt-button"
          >
            <CheckIcon />
            <span className="pw-tlabel">採用する</span>
          </button>
        )}
        <ChevronRightIcon className="icon pw-vrow-chev" />
      </span>
    </li>
  )
})

// ---------- 比較 ----------

function CompareView({ api, active, selected, showDiff }: PaneProps & { selected: Version }) {
  const data = useData()
  const { piece } = api
  const isActive = active?.id === selected.id
  const versions = useMemo(() => versionsNewestFirst(data, piece), [data, piece])
  const [live, onDraftChange] = useLiveText(selected.id, selected.body)
  const deferred = useDeferredValue(live)
  // 保存済みの本文と同じなら稿ごとにキャッシュした値を使い、書いている間だけ数え直す（入力のたびには数えない）
  const counts = useMemo(() => liveStats(selected, deferred), [selected, deferred])
  const stats = useMemo(() => formatStats(counts), [counts])
  const activeBody = active?.body ?? null
  const delta = active && !isActive ? counts.chars - bodyMetrics(active).chars : null
  const deltaLabel = useMemo(() => (delta === null ? null : formatCharDelta(delta)), [delta])
  const [noteOpen, setNoteOpen] = useState(false)
  // 狭いペインでは稿の名前・文字数・操作を「…」の中にしまう
  const [moreFor, setMoreFor] = useState<ID | null>(null)
  const moreOpen = moreFor === selected.id
  const headRef = useRef<HTMLDivElement>(null)
  const moreToggleRef = useRef<HTMLButtonElement>(null)
  const moreId = useId()
  const closeMore = () => {
    // 閉じたパネルの中にフォーカスを残さない（稿の名前の入力はここで確定する）
    if (document.activeElement?.closest('.pw-cmore')) moreToggleRef.current?.focus()
    setMoreFor(null)
  }
  useDismiss(moreOpen, headRef, closeMore)
  const nameRef = useRegisteredDraft()

  const diffMode = showDiff && !isActive
  // 保存済みの本文どうしを、描画とは別に（少し待ってから別スレッドで）比べる
  const diff = useDiff(selected.id, activeBody, selected.body, diffMode)
  const summary = useMemo(() => (diff.segments ? diffSummary(diff.segments) : null), [diff.segments])

  const side = api.orientation === 'horizontal' ? '左' : '上'

  const adopt = () => {
    flushEditors(api.compareEditor, api.noteEditor, api.activeEditor, nameRef)
    const previous = active?.id ?? null
    if (!tryRun(() => actions.setActiveVersion(piece.id, selected.id))) return
    notify(`${versionDisplayName(selected)}を採用しました`)
    api.select(selectionAfterAdopt(previous, selected.id, piece.versionIds))
  }

  const duplicate = () => {
    closeMore()
    flushEditors(api.compareEditor, api.activeEditor, nameRef)
    const id = attempt(() => actions.duplicateVersion(selected.id))
    if (id) api.select(id)
  }

  const copy = () => {
    closeMore()
    void copyText(live)
  }

  const remove = async () => {
    closeMore()
    const name = versionDisplayName(selected)
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: versionDeleteMessage(selected, isActive, submissionsReferencingVersion(data, selected.id)),
      confirmLabel: '削除',
      danger: true,
    })
    if (!ok) return
    // 保留中の下書きを先に書き込んでおく（削除後に保存が走らないように）
    flushEditors(api.compareEditor, api.noteEditor, nameRef)
    if (tryRun(() => actions.deleteVersion(selected.id))) {
      notify(`${name}をゴミ箱に移しました`)
      api.select(null)
    }
  }

  return (
    <div className={`pw-pane pw-pane-compare${isActive ? ' is-active-selected' : ''}`} data-testid="compare-pane">
      <div className={`pw-head pw-chead${moreOpen ? ' is-more-open' : ''}`} ref={headRef}>
        <button
          type="button"
          className="btn btn-ghost pw-tbtn pw-back"
          onClick={() => api.select(null)}
          title="推敲バージョンの一覧に戻る"
          data-testid="back-to-list"
        >
          <ChevronLeftIcon />
          <span className="pw-back-label">一覧</span>
        </button>
        <select
          className="select pw-vselect"
          value={selected.id}
          onChange={(e) => api.select(e.target.value)}
          aria-label="比較するバージョン"
          data-testid="version-select"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {`${versionDisplayName(v)}${v.id === active?.id ? '（採用中）' : ''}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-active pw-tbtn pw-adopt"
          onClick={adopt}
          disabled={isActive}
          title={isActive ? 'このバージョンは採用中です' : 'このバージョンを採用原稿にする'}
          data-testid="adopt-button"
        >
          <CheckIcon />
          <span className="pw-adopt-label">{isActive ? '採用中' : '採用する'}</span>
        </button>
        <button
          ref={moreToggleRef}
          type="button"
          className="icon-btn pw-more-toggle"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          aria-label="稿の名前・文字数・操作"
          title="稿の名前・文字数・操作"
          onClick={() => (moreOpen ? closeMore() : setMoreFor(selected.id))}
          data-testid="compare-more-button"
        >
          <MoreIcon />
        </button>
        {/* 広いペインではヘッダーにそのまま並び、狭いペインでは「…」で開くパネルになる */}
        <div className="pw-cmore" id={moreId}>
          <div className="pw-tools" role="group" aria-label="推敲バージョンの操作">
            <button
              type="button"
              className="btn pw-tbtn"
              onClick={duplicate}
              title="このバージョンを複製する"
              data-testid="duplicate-selected"
            >
              <ReviseIcon />
              <span className="pw-tlabel">複製</span>
            </button>
            <button type="button" className="btn pw-tbtn" onClick={copy} title="本文をクリップボードにコピー">
              <CopyIcon />
              <span className="pw-tlabel">コピー</span>
            </button>
            <button
              type="button"
              className="btn btn-danger pw-tbtn"
              onClick={() => void remove()}
              title="このバージョンを削除する"
              data-testid="delete-version"
            >
              <TrashIcon />
              <span className="pw-tlabel">削除</span>
            </button>
          </div>
          <span className="pw-break pw-break-a" aria-hidden="true" />
          {isActive ? (
            <span className="pw-vname pw-vname-static">
              <span className="badge badge-active">採用中</span>
              <span className="ellipsis">{versionDisplayName(selected)}</span>
            </span>
          ) : (
            <DraftInput
              ref={nameRef}
              key={selected.id}
              className="input-bare pw-vname"
              value={selected.name}
              onCommit={(v) => commitVersion(selected.id, { name: v })}
              placeholder="稿の名前"
              aria-label="バージョン名"
              data-testid="selected-version-name"
            />
          )}
          <span className="pw-break pw-break-b" aria-hidden="true" />
          <span className="pw-meta">
            <span data-testid="compare-count">
              {stats.chars}
              <span className="pw-pages">・{stats.pages}</span>
            </span>
            {delta !== null ? (
              <span className={deltaClass(delta)} title="採用原稿との文字数の差">
                採用原稿より{deltaLabel}
              </span>
            ) : null}
            <span className="faint pw-updated" title={formatDateTime(selected.updatedAt)}>
              {formatUpdated(selected.updatedAt)}
            </span>
          </span>
        </div>
      </div>

      {isActive ? (
        <div className="pw-notice" role="note">
          このバージョンは採用中です（{side}の採用原稿で編集できます）
        </div>
      ) : diffMode ? (
        <div className="pw-notice pw-notice-diff" role="note" data-testid="diff-summary">
          {active ? (
            <>
              {summary ? (
                <>
                  <span className="pw-legend add">追加 +{formatCount(summary.added)}字</span>
                  <span className="pw-legend del">削除 −{formatCount(summary.removed)}字</span>
                </>
              ) : null}
              <span className="faint pw-diff-hint">差分表示中は編集できません</span>
              {/* 採用原稿を書いている間は前回の差分を出しておき、少し待ってから計算し直す */}
              <span className={`faint pw-diff-stale${diff.stale ? ' is-on' : ''}`} data-testid="diff-stale">
                {diff.stale ? '差分を計算中…' : ''}
              </span>
            </>
          ) : (
            <span>差分を表示するには採用原稿が必要です。いまは本文だけを表示しています。</span>
          )}
        </div>
      ) : null}

      <div className="pw-body">
        {isActive ? (
          <textarea
            key={selected.id}
            className="manuscript"
            value={selected.body}
            readOnly
            aria-label="採用中のバージョンの本文（読み取り専用）"
            data-testid="compare-readonly"
            data-scroll-sync="compare"
          />
        ) : diffMode && active ? (
          <DiffView segments={diff.segments} />
        ) : diffMode ? (
          <textarea
            key={selected.id}
            className="manuscript"
            value={selected.body}
            readOnly
            aria-label="推敲バージョンの本文（読み取り専用）"
            data-testid="compare-readonly"
            data-scroll-sync="compare"
          />
        ) : (
          <DraftTextarea
            ref={api.compareEditor}
            key={selected.id}
            className="manuscript"
            value={selected.body}
            onCommit={(v) => commitVersion(selected.id, { body: v })}
            conflictGuard={versionBodyGuard(selected.id)}
            onDraftChange={onDraftChange}
            placeholder="推敲中の本文"
            aria-label="推敲バージョンの本文"
            spellCheck={false}
            data-testid="compare-editor"
            data-scroll-sync="compare"
          />
        )}
      </div>

      <details className="pw-note" open={noteOpen} onToggle={(e) => setNoteOpen(e.currentTarget.open)}>
        <summary data-testid="note-toggle">
          <NoteIcon />
          <span className="pw-note-label">推敲メモ</span>
          {!noteOpen && selected.note.trim() ? (
            <span className="pw-note-preview ellipsis">{firstLine(selected.note)}</span>
          ) : null}
          {/* 狭いペインではヘッダーに文字数を出さないので、ここに出す */}
          <span className="pw-note-count" aria-hidden="true">
            {stats.chars}
            {delta !== null ? <span className={deltaClass(delta)}>{deltaLabel}</span> : null}
          </span>
        </summary>
        <DraftTextarea
          ref={api.noteEditor}
          key={selected.id}
          className="textarea pw-note-input"
          value={selected.note}
          onCommit={(v) => commitVersion(selected.id, { note: v })}
          placeholder="この稿で変えたこと・狙い・気になる点など"
          aria-label="推敲メモ"
          rows={4}
          data-testid="version-note"
        />
      </details>
    </div>
  )
}
