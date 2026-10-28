// 採用原稿（左／上）。アクティブなバージョンだけが章・タイトル・通し読みに反映される。
import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { NO_ACTIVE_MESSAGE } from '../../domain/readthrough'
import type { Version } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt } from '../../store/uiStore'
import { copyText, formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DraftInput, DraftTextarea } from '../../ui/DraftField'
import { CopyIcon, MoreIcon, PlusIcon } from '../../ui/icons'
import { commitVersion, flushEditors, tryRun, useDismiss, useLiveText, useRegisteredDraft } from './editing'
import { formatStats, liveStats } from './logic'
import { ReviseIcon, UnadoptIcon } from './pieceIcons'
import type { WorkspaceApi } from './VersionsPane'

export function ActivePane({ api, active }: { api: WorkspaceApi; active: Version | null }) {
  if (!active) return <NoActive api={api} />
  return <ActiveEditor api={api} active={active} />
}

function ActiveEditor({ api, active }: { api: WorkspaceApi; active: Version }) {
  const [live, onDraftChange] = useLiveText(active.id, active.body)
  const nameRef = useRegisteredDraft()
  const deferred = useDeferredValue(live)
  // 保存済みの本文と同じなら稿ごとにキャッシュした値を使い、書いている間だけ数え直す
  const stats = useMemo(() => formatStats(liveStats(active, deferred)), [active, deferred])
  const updated = formatUpdated(active.updatedAt)

  // 狭いペインでは、使う頻度の低い操作（コピー・採用を解除）を「…」のメニューにしまう
  const [moreOpen, setMoreOpen] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)
  const moreToggleRef = useRef<HTMLButtonElement>(null)
  const moreId = useId()
  const closeMore = () => {
    // 閉じたメニューの中にフォーカスを残さない（確認ダイアログを閉じた後も「…」に戻る）
    if (document.activeElement?.closest('.pw-amore')) moreToggleRef.current?.focus()
    setMoreOpen(false)
  }
  useDismiss(moreOpen, headRef, closeMore)

  const duplicate = () => {
    flushEditors(api.activeEditor, nameRef)
    const id = attempt(() => actions.duplicateVersion(active.id))
    if (id) api.select(id)
  }

  const copy = () => {
    closeMore()
    void copyText(live)
  }

  const unadopt = async () => {
    closeMore()
    const ok = await confirmDialog({
      title: '採用を解除しますか？',
      message: `この話には採用原稿がなくなり、章・タイトルの通し読みでは「${NO_ACTIVE_MESSAGE}」と表示されます。\n\n「${active.name || '無題の稿'}」は削除されず、推敲バージョンの一覧に残ります。あとで「採用する」で戻せます。`,
      confirmLabel: '採用を解除',
    })
    if (!ok) return
    flushEditors(api.activeEditor)
    tryRun(() => actions.setActiveVersion(api.piece.id, null))
  }

  return (
    <div className="pw-pane pw-pane-active" data-testid="active-pane">
      <div className={`pw-head pw-ahead${moreOpen ? ' is-more-open' : ''}`} ref={headRef}>
        <span className="badge badge-active pw-head-badge">採用中</span>
        <DraftInput
          ref={nameRef}
          key={active.id}
          className="input-bare pw-vname"
          value={active.name}
          onCommit={(v) => commitVersion(active.id, { name: v })}
          placeholder="稿の名前"
          aria-label="採用中のバージョン名"
          data-testid="active-version-name"
        />
        <div className="pw-tools" role="group" aria-label="採用原稿の操作">
          <button
            type="button"
            className="btn pw-tbtn"
            onClick={duplicate}
            title="採用原稿を複製して新しい推敲バージョンを作り、並べて編集する"
            data-testid="duplicate-active"
          >
            <ReviseIcon />
            {/* 狭いペインでは「推敲」だけを出す */}
            <span className="pw-tlabel pw-tlabel-keep">
              <span className="pw-tlabel-long">複製して</span>推敲
            </span>
          </button>
          <button
            ref={moreToggleRef}
            type="button"
            className="icon-btn pw-more-toggle"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            aria-label="採用原稿のその他の操作"
            title="採用原稿のその他の操作"
            onClick={() => (moreOpen ? closeMore() : setMoreOpen(true))}
            data-testid="active-more-button"
          >
            <MoreIcon />
          </button>
          {/* 広いペインではヘッダーにそのまま並び、狭いペインでは「…」で開くメニューになる */}
          <div className="pw-amore" id={moreId}>
            {/* 狭いヘッダーに出しきれない原稿用紙換算と更新日時 */}
            <p className="pw-amore-meta">
              <span>
                {stats.chars}・{stats.pages}
              </span>
              <span title={formatDateTime(active.updatedAt)}>{updated}</span>
            </p>
            <button
              type="button"
              className="btn pw-tbtn"
              onClick={copy}
              title="本文をクリップボードにコピー"
              data-testid="copy-active"
            >
              <CopyIcon />
              <span className="pw-tlabel">コピー</span>
            </button>
            <button
              type="button"
              className="btn pw-tbtn"
              onClick={() => void unadopt()}
              title="どのバージョンも採用しない状態にする"
              data-testid="unadopt-button"
            >
              <UnadoptIcon />
              <span className="pw-tlabel">採用を解除</span>
            </button>
          </div>
        </div>
        <span className="pw-break" aria-hidden="true" />
        <div className="pw-meta">
          <span data-testid="active-count">
            {stats.chars}
            <span className="pw-pages">・{stats.pages}</span>
          </span>
          <span className="faint pw-updated" title={formatDateTime(active.updatedAt)}>
            {updated}
          </span>
          <span className="faint pw-meta-hint">通し読みに反映されます</span>
        </div>
      </div>
      <div className="pw-body">
        <DraftTextarea
          ref={api.activeEditor}
          key={active.id}
          className="manuscript"
          value={active.body}
          onCommit={(v) => commitVersion(active.id, { body: v })}
          onDraftChange={onDraftChange}
          placeholder="ここに本文を書きます"
          aria-label="採用原稿の本文"
          spellCheck={false}
          data-testid="active-editor"
          data-scroll-sync="active"
        />
      </div>
    </div>
  )
}

function NoActive({ api }: { api: WorkspaceApi }) {
  const createAndAdopt = () => {
    const id = attempt(() => actions.addVersion(api.piece.id))
    if (!id) return
    if (tryRun(() => actions.setActiveVersion(api.piece.id, id))) {
      setTimeout(() => api.activeEditor.current?.focus(), 0)
    }
  }
  return (
    <div className="pw-pane pw-pane-active is-empty" data-testid="active-pane">
      <div className="pw-head">
        <span className="badge badge-missing pw-head-badge" data-testid="no-active-badge">
          採用原稿なし
        </span>
      </div>
      <div className="pw-body pw-scroll">
        <div className="pw-empty" data-testid="no-active">
          <p className="pw-empty-title">{NO_ACTIVE_MESSAGE}</p>
          <p className="pw-empty-text">推敲バージョンを選んで「採用する」を押すと、ここに表示されます。</p>
          <p className="pw-empty-text small faint">採用原稿がない話は、通し読みでも「{NO_ACTIVE_MESSAGE}」と表示されます。</p>
          <button type="button" className="btn btn-primary" onClick={createAndAdopt} data-testid="create-and-adopt">
            <PlusIcon />
            白紙の稿を作って採用
          </button>
        </div>
      </div>
    </div>
  )
}
