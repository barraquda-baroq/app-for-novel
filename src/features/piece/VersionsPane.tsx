// 推敲バージョン（右／下）。一覧から選ぶと、採用原稿と並べて比較・編集できる。
import { useDeferredValue, useMemo, useState, type RefObject } from 'react'
import { diffSummary, diffTexts } from '../../domain/diff'
import { NO_ACTIVE_MESSAGE } from '../../domain/readthrough'
import { countChars, formatCount } from '../../domain/text'
import type { ID, Piece, Version } from '../../domain/types'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { copyText, formatDateTime, formatRelative } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DraftInput, DraftTextarea, type DraftHandle } from '../../ui/DraftField'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, NoteIcon, PlusIcon, TrashIcon } from '../../ui/icons'
import { DiffView } from './DiffView'
import { commitVersion, flushEditors, tryRun, useLiveText, useRegisteredDraft } from './editing'
import { firstLine, formatCharDelta, selectionAfterAdopt, statsLabel, versionDisplayName, versionRows, versionsNewestFirst } from './logic'
import { ReviseIcon } from './pieceIcons'

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

  const adopt = (v: Version) => {
    flushEditors(api.activeEditor)
    if (tryRun(() => actions.setActiveVersion(piece.id, v.id))) notify(`${versionDisplayName(v)}を採用しました`)
  }

  return (
    <div className="pw-pane pw-pane-versions" data-testid="versions-pane">
      <div className="pw-head">
        <h2 className="pw-head-title" data-testid="versions-heading">
          推敲バージョン（{rows.length}）
        </h2>
        <div className="pw-tools" role="group" aria-label="推敲バージョンの追加">
          <button type="button" className="btn pw-tbtn" onClick={addBlank} title="白紙の推敲バージョンを追加する" data-testid="add-blank-version">
            <PlusIcon />
            <span className="pw-tlabel">白紙の稿</span>
          </button>
          <button
            type="button"
            className="btn pw-tbtn"
            onClick={duplicateActive}
            disabled={!active}
            title={active ? '採用原稿を複製して新しい推敲バージョンを作る' : '採用原稿がありません'}
            data-testid="duplicate-active-list"
          >
            <ReviseIcon />
            <span className="pw-tlabel">採用原稿を複製</span>
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
                <li key={r.version.id} className={`pw-vrow${r.isActive ? ' is-active' : ''}`} data-testid="version-row">
                  <button
                    type="button"
                    className="pw-vrow-main"
                    onClick={() => api.select(r.version.id)}
                    aria-label={`${versionDisplayName(r.version)}${r.isActive ? '（採用中）' : ''}を開いて比較する`}
                  >
                    <span className="pw-vrow-top">
                      <span className="pw-vrow-name">{versionDisplayName(r.version)}</span>
                      {r.isActive ? <span className="badge badge-active">採用中</span> : null}
                    </span>
                    <span className="pw-vrow-meta">
                      <span title={formatDateTime(r.version.updatedAt)}>{formatRelative(r.version.updatedAt)}</span>
                      <span aria-hidden="true">・</span>
                      <span>{formatCount(r.chars)}字</span>
                      {r.delta !== null ? (
                        <span className={deltaClass(r.delta)} title="採用原稿との文字数の差">
                          {formatCharDelta(r.delta)}
                        </span>
                      ) : null}
                    </span>
                    {r.note ? (
                      <span className="pw-vrow-note">
                        <NoteIcon />
                        <span className="ellipsis">{r.note}</span>
                      </span>
                    ) : null}
                  </button>
                  <span className="pw-vrow-side">
                    {r.isActive ? null : (
                      <button
                        type="button"
                        className="btn pw-tbtn pw-row-adopt"
                        onClick={() => adopt(r.version)}
                        aria-label={`${versionDisplayName(r.version)}を採用する`}
                        data-testid="row-adopt-button"
                      >
                        <CheckIcon />
                        <span className="pw-tlabel">採用する</span>
                      </button>
                    )}
                    <ChevronRightIcon className="icon pw-vrow-chev" />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 比較 ----------

function CompareView({ api, active, selected, showDiff }: PaneProps & { selected: Version }) {
  const data = useData()
  const { piece } = api
  const isActive = active?.id === selected.id
  const versions = useMemo(() => versionsNewestFirst(data, piece), [data, piece])
  const [live, onDraftChange] = useLiveText(selected.id, selected.body)
  const deferred = useDeferredValue(live)
  const stats = useMemo(() => statsLabel(deferred), [deferred])
  const activeChars = useMemo(() => (active ? countChars(active.body) : 0), [active])
  const delta = active && !isActive ? countChars(deferred) - activeChars : null
  const [noteOpen, setNoteOpen] = useState(false)
  const nameRef = useRegisteredDraft()

  const diffMode = showDiff && !isActive
  const segments = useMemo(
    () => (diffMode && active ? diffTexts(active.body, selected.body) : null),
    [diffMode, active, selected.body],
  )
  const summary = useMemo(() => (segments ? diffSummary(segments) : null), [segments])

  const side = api.orientation === 'horizontal' ? '左' : '上'

  const adopt = () => {
    flushEditors(api.compareEditor, api.noteEditor, api.activeEditor, nameRef)
    const previous = active?.id ?? null
    if (!tryRun(() => actions.setActiveVersion(piece.id, selected.id))) return
    notify(`${versionDisplayName(selected)}を採用しました`)
    api.select(selectionAfterAdopt(previous, selected.id, piece.versionIds))
  }

  const duplicate = () => {
    flushEditors(api.compareEditor, api.activeEditor, nameRef)
    const id = attempt(() => actions.duplicateVersion(selected.id))
    if (id) api.select(id)
  }

  const remove = async () => {
    const name = versionDisplayName(selected)
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: isActive
        ? `このバージョンは採用中です。削除すると、この話には採用原稿がなくなり、通し読みでは「${NO_ACTIVE_MESSAGE}」と表示されます。\n\nこの操作は取り消せません。`
        : 'この推敲バージョンの本文と推敲メモを削除します。この操作は取り消せません。',
      confirmLabel: '削除',
      danger: true,
    })
    if (!ok) return
    // 保留中の下書きを先に書き込んでおく（削除後に保存が走らないように）
    flushEditors(api.compareEditor, api.noteEditor, nameRef)
    if (tryRun(() => actions.deleteVersion(selected.id))) {
      notify(`${name}を削除しました`)
      api.select(null)
    }
  }

  return (
    <div className={`pw-pane pw-pane-compare${isActive ? ' is-active-selected' : ''}`} data-testid="compare-pane">
      <div className="pw-head pw-chead">
        <button type="button" className="btn btn-ghost pw-tbtn pw-back" onClick={() => api.select(null)} data-testid="back-to-list">
          <ChevronLeftIcon />
          <span>一覧</span>
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
          <span>{isActive ? '採用中' : '採用する'}</span>
        </button>
        <div className="pw-tools" role="group" aria-label="推敲バージョンの操作">
          <button type="button" className="btn pw-tbtn" onClick={duplicate} title="このバージョンを複製する" data-testid="duplicate-selected">
            <ReviseIcon />
            <span className="pw-tlabel">複製</span>
          </button>
          <button type="button" className="btn pw-tbtn" onClick={() => void copyText(live)} title="本文をクリップボードにコピー">
            <CopyIcon />
            <span className="pw-tlabel">コピー</span>
          </button>
          <button type="button" className="btn btn-danger pw-tbtn" onClick={() => void remove()} title="このバージョンを削除する" data-testid="delete-version">
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
          <span data-testid="compare-count">{stats}</span>
          {delta !== null ? (
            <span className={deltaClass(delta)} title="採用原稿との文字数の差">
              採用原稿より{formatCharDelta(delta)}
            </span>
          ) : null}
          <span className="faint" title={formatDateTime(selected.updatedAt)}>
            {formatRelative(selected.updatedAt)}に更新
          </span>
        </span>
      </div>

      {isActive ? (
        <div className="pw-notice" role="note">
          このバージョンは採用中です（{side}の採用原稿で編集できます）
        </div>
      ) : diffMode ? (
        <div className="pw-notice pw-notice-diff" role="note" data-testid="diff-summary">
          {summary ? (
            <>
              <span className="pw-legend add">追加 +{formatCount(summary.added)}字</span>
              <span className="pw-legend del">削除 −{formatCount(summary.removed)}字</span>
              <span className="faint">差分表示中は編集できません</span>
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
        ) : segments ? (
          <DiffView segments={segments} />
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
          {!noteOpen && selected.note.trim() ? <span className="pw-note-preview ellipsis">{firstLine(selected.note)}</span> : null}
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
