// 採用原稿（左／上）。アクティブなバージョンだけが章・タイトル・通し読みに反映される。
import { useDeferredValue, useMemo } from 'react'
import { NO_ACTIVE_MESSAGE } from '../../domain/readthrough'
import type { Version } from '../../domain/types'
import { actions } from '../../store/actions'
import { attempt } from '../../store/uiStore'
import { copyText, formatDateTime, formatRelative } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DraftInput, DraftTextarea } from '../../ui/DraftField'
import { CopyIcon, PlusIcon } from '../../ui/icons'
import { commitVersion, flushEditors, tryRun, useLiveText, useRegisteredDraft } from './editing'
import { statsLabel } from './logic'
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
  const stats = useMemo(() => statsLabel(deferred), [deferred])

  const duplicate = () => {
    flushEditors(api.activeEditor, nameRef)
    const id = attempt(() => actions.duplicateVersion(active.id))
    if (id) api.select(id)
  }

  const unadopt = async () => {
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
      <div className="pw-head pw-ahead">
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
          <button type="button" className="btn pw-tbtn" onClick={() => void copyText(live)} title="本文をクリップボードにコピー">
            <CopyIcon />
            <span className="pw-tlabel">コピー</span>
          </button>
          <button
            type="button"
            className="btn pw-tbtn"
            onClick={duplicate}
            title="採用原稿を複製して新しい推敲バージョンを作り、並べて編集する"
            data-testid="duplicate-active"
          >
            <ReviseIcon />
            <span className="pw-tlabel">複製して推敲</span>
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
        <span className="pw-break" aria-hidden="true" />
        <div className="pw-meta">
          <span data-testid="active-count">{stats}</span>
          <span className="faint" title={formatDateTime(active.updatedAt)}>
            {formatRelative(active.updatedAt)}に更新
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
        <span className="badge badge-missing pw-head-badge">未採用</span>
        <span className="pw-head-title">採用原稿</span>
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
