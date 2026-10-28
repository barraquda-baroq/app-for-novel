// 保存先が無くなった、保存していない編集を残す画面（2.2 セパレート）。
// 原稿画面を開いている間に、別の画面・端末で幕がつながれた・セパレートを解除された（幕が無くなった）、話が幕に分けられた、
// 話・幕が削除された時に、編集を黙って捨てずにここに出す。編集は読み取り専用で見せ（コピーできる）、
// 「新しい稿として残す」で残し先（つないだ前の幕・解除した話・選んだ幕。無ければゴミ箱）の新しい稿にする。
// 画面を離れる時の確認・端末内の控えは、原稿画面と同じ編集セッション（usePieceSession.ts）がそのまま受け持つ。
import { useMemo } from 'react'
import type { ID, Title } from '../../domain/types'
import { paths } from '../../routes'
import { useData } from '../../store/appStore'
import { copyText } from '../../ui/browser'
import { useDocumentTitle } from '../../ui/hooks'
import { CopyIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import type { LastSeen, OrphanReason, OrphanState } from './orphan'
import { describeEdits, type PieceSession } from './usePieceSession'

const HEADLINES: Record<OrphanReason, string> = {
  joined: 'この幕は、別の画面・端末で前の幕とつながれたため、なくなりました',
  unseparated: 'この幕は、別の画面・端末でセパレートを解除したため、なくなりました',
  split: 'この話は、別の画面・端末で幕に分けられました',
  deleted: 'この話（幕）は、別の画面・端末で削除されました',
}

const EXPLAIN: Record<OrphanReason, string> = {
  joined: '保存していない編集は、まだこの画面の中にあります。つないだ幕の新しい稿として残すか、コピーしてください。',
  unseparated: '保存していない編集は、まだこの画面の中にあります。話の新しい稿として残すか、コピーしてください。',
  split:
    '幕に分けている間、この話自身の稿は変えられません。保存していない編集は、まだこの画面の中にあります。幕の新しい稿として残すか、コピーしてください。',
  deleted:
    '保存していない編集は、まだこの画面の中にあります。ゴミ箱に残す（話・幕をゴミ箱から戻すと、その稿として戻せます）か、コピーしてください。',
}

export function OrphanEdits({
  title,
  state,
  last,
  ps,
  choice,
  onChoice,
}: {
  title: Title | undefined
  state: OrphanState
  last: LastSeen | null
  ps: PieceSession
  choice: ID | null
  onChoice: (id: ID) => void
}) {
  const data = useData()
  const { session } = ps
  // 編集はこの画面では変わらない（編集欄が無い）ので、開いた時のものを出す
  const edits = useMemo(() => Object.entries(session.edits()), [session])
  const hasVersionEdits = edits.some(([key]) => key.startsWith('version:'))
  const selected = choice && state.options.some((o) => o.id === choice) ? choice : state.defaultTarget
  const targetLabel = state.targetLabel(choice)
  useDocumentTitle(`保存していない編集 — ${title?.name ?? 'Novel Studio'}`)

  const crumbs: Crumb[] = title ? [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }] : []
  crumbs.push({ label: last?.label || '保存していない編集' })

  const keepLabel = !hasVersionEdits
    ? '保存する'
    : targetLabel
      ? state.reason === 'split'
        ? '選んだ幕の新しい稿として残す'
        : `「${targetLabel}」の新しい稿として残す`
      : 'ゴミ箱に残す'

  return (
    <>
      <AppHeader crumbs={crumbs} />
      <main className="page page-narrow" data-testid="orphan-edits" data-reason={state.reason}>
        <div className="card card-pad stack orphan-card" role="alert">
          <h1 className="orphan-title">{HEADLINES[state.reason]}</h1>
          <p className="orphan-help">{EXPLAIN[state.reason]}</p>
          <ul className="orphan-list" aria-label="保存していない編集">
            {edits.map(([key, edit]) => {
              const name = describeEdits(data, { [key]: edit })
              return (
                <li key={key} className="orphan-item" data-testid="orphan-item">
                  <div className="orphan-item-head">
                    <span className="orphan-item-name">{name}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void copyText(edit.value)}
                      aria-label={`${name}をコピー`}
                      data-testid="orphan-copy"
                    >
                      <CopyIcon />
                      コピー
                    </button>
                  </div>
                  <textarea
                    className="textarea orphan-value"
                    value={edit.value}
                    readOnly
                    rows={Math.min(8, Math.max(2, edit.value.split('\n').length))}
                    aria-label={`${name}（読み取り専用）`}
                    data-testid="orphan-value"
                  />
                </li>
              )
            })}
          </ul>
          {hasVersionEdits && state.options.length > 1 ? (
            <label className="field orphan-target">
              <span>残す幕</span>
              <select
                className="select"
                value={selected ?? ''}
                onChange={(e) => onChoice(e.target.value)}
                data-testid="orphan-target"
              >
                {state.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="orphan-actions">
            <button type="button" className="btn btn-danger" onClick={() => void ps.discard()} data-testid="orphan-discard">
              破棄
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void ps.save()} data-testid="orphan-keep">
              {keepLabel}
            </button>
          </div>
        </div>
      </main>
    </>
  )
}
