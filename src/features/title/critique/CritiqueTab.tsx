// 作品批評タブ: 採用原稿でタイトル全体を、書き手が望む形で Claude に批評してもらうためのプロンプトの一覧
// （このタイトルのものと、どのタイトルでも使う共通のもの）と、実行したプロンプトと批評結果（Markdown・アーティファクトの URL）の
// 日付ごとの記録。結果は Claude（コネクタ）から書き込まれるほか、「Claude に頼む（手動）」と「結果を貼り付け」でも残せる。
// 「相対比較する作品」（2.5。内部名は bench）: ホームの「相対比較」から作品を選ぶと、Claude がその分析を読んで比べる（結果に「比べた作品」が残る）。
import { memo, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { critiquePromptsOf, critiqueResultsOf } from '../../../claude/order'
import { critiqueConnectorPrompt } from '../../../claude/prompts'
import { isHttpsUrl } from '../../../claude/records'
import { manuscriptLabel, manuscriptOf } from '../../../claude/snapshot'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../../claude/visibility'
import { benchWorkName, benchWorksOfTitle, sortedBenchWorks } from '../../../domain/benchOps'
import { trashNotice } from '../../../domain/trash'
import type { BenchWork, CritiqueManuscript, CritiquePrompt, CritiqueResult, ID, Title } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { getData, useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { copyText } from '../../../ui/browser'
import { confirmDialog } from '../../../ui/dialogs'
import { DraftInput } from '../../../ui/DraftField'
import { ChevronRightIcon, CopyIcon, LinkIcon, PlusIcon, ShelfIcon, TrashIcon, XIcon } from '../../../ui/icons'
import { useKeepInPlace } from '../../../ui/keepInPlace'
import { AskIcon, PasteIcon, SparkIcon } from '../../claude/claudeIcons'
import { sourceLabel } from '../../claude/claudeUi'
import { ManualDialog } from '../../claude/ManualDialog'
import { Markdown } from '../../claude/Markdown'
import { PasteResultDialog } from '../../claude/PasteResultDialog'
import { GrowTextarea } from '../settings/GrowTextarea'
import { ArrowDownIcon, ArrowUpIcon } from '../strategy/strategyIcons'
import { previewText } from '../strategy/proofLogic'
import { dayHeading, groupByDate, resultHeading, scopeLabel } from './critiqueLogic'
import '../strategy/claudeSections.css'
import './critique.css'
import '../../bench/bench.css'

/** 閉じている時に見せる結果の長さ（これより長ければ「全文を表示」。閉じている間は頭だけを変換する。Markdown.tsx） */
const LONG_RESULT = 900
/** 閉じたプロンプトの1行の見本を作る時に見る、依頼文の最初の字数 */
const PREVIEW_SOURCE = 1_000

export function CritiqueTab({ titleId }: { titleId: ID }) {
  const data = useData()
  const title = data.titles[titleId]
  const prompts = useMemo(() => critiquePromptsOf(data, titleId), [data.critiquePrompts, titleId]) // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => critiqueResultsOf(data, titleId), [data.critiqueResults, titleId]) // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => groupByDate(results), [results])
  // いまの採用原稿（批評した時点との違い「現在 +3,200字」を出す）。原稿が変わった時だけ数え直す
  const current = useMemo(
    () => (results.length ? manuscriptOf(data, titleId, Date.now()) : null),
    [results.length > 0, data.titles, data.chapters, data.pieces, data.versions, titleId], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [manual, setManual] = useState<{ promptId: ID | null } | null>(null)
  const [paste, setPaste] = useState<{ promptId: ID | null } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<ID>>(() => new Set())
  const [focusId, setFocusId] = useState<ID | null>(null)
  // 相対比較する作品（タイトルの選んだ順）と、相対比較の棚の作品（作品の名前を出す）
  const benchWorks = data.benchWorks
  const comparing = useMemo(() => benchWorksOfTitle(data, titleId), [title?.benchWorkIds, benchWorks, titleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(
    (id: ID) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const ask = useCallback((promptId: ID | null) => setManual({ promptId }), [])

  if (!title) return null

  const addPrompt = (shared: boolean) => {
    const id = attempt(() => actions.addCritiquePrompt(shared ? null : titleId))
    if (!id) return
    setExpanded((prev) => new Set(prev).add(id))
    setFocusId(id)
  }

  const firstPrompt = prompts.title[0]?.id ?? prompts.shared[0]?.id ?? null

  return (
    <div className="cq-tab" data-testid="critique-tab">
      <div className="cq-intro">
        <p className="small muted">
          採用原稿でタイトル全体を、望む形で Claude に批評してもらうためのプロンプトと、その結果を日付ごとに残します。Claude
          のコネクタからも書き込まれます。
        </p>
        <div className="cq-intro-actions">
          <button type="button" className="btn" onClick={() => ask(firstPrompt)} data-testid="critique-manual">
            <AskIcon />
            Claude に頼む（手動）
          </button>
          <button type="button" className="btn" onClick={() => setPaste({ promptId: firstPrompt })} data-testid="critique-paste">
            <PasteIcon />
            結果を貼り付け
          </button>
        </div>
      </div>

      <CompareWorks titleId={titleId} comparing={comparing} benchWorks={benchWorks} />

      <section className="cq-section" aria-labelledby="cq-prompts-heading" data-testid="critique-prompts">
        <div className="cq-head">
          <h2 id="cq-prompts-heading">批評プロンプト</h2>
        </div>
        <PromptGroup
          title={title}
          heading="このタイトルのプロンプト"
          prompts={prompts.title}
          shared={false}
          expanded={expanded}
          onToggle={toggle}
          onAdd={() => addPrompt(false)}
          onAsk={ask}
          focusId={focusId}
          onFocused={() => setFocusId(null)}
        />
        <PromptGroup
          title={title}
          heading="共通のプロンプト（どのタイトルでも使えます）"
          prompts={prompts.shared}
          shared
          expanded={expanded}
          onToggle={toggle}
          onAdd={() => addPrompt(true)}
          onAsk={ask}
          focusId={focusId}
          onFocused={() => setFocusId(null)}
        />
      </section>

      <section className="cq-section" aria-labelledby="cq-results-heading" data-testid="critique-results">
        <div className="cq-head">
          <h2 id="cq-results-heading">
            批評の結果<span className="sx-count">{results.length}</span>
          </h2>
        </div>
        {results.length === 0 ? (
          <div className="empty cq-empty" data-testid="critique-results-empty">
            <p>まだ批評の結果がありません。</p>
            <p className="small">
              プロンプトの「Claude 用にコピー」をコネクタを付けた claude.ai のチャットに貼るか、「Claude
              に頼む（手動）」で本文と一緒に送ってください。
            </p>
          </div>
        ) : (
          <ol className="cq-days">
            {days.map((day) => (
              <li key={day.date} className="cq-day" data-testid="critique-day">
                <h3 className="cq-day-head">{dayHeading(day.date)}</h3>
                <ol className="cq-results">
                  {day.items.map((r) => (
                    <ResultCard
                      key={r.id}
                      r={r}
                      current={current}
                      prompts={data.critiquePrompts}
                      benchWorks={r.benchWorkIds?.length ? benchWorks : undefined}
                    />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </section>

      {manual ? (
        <ManualDialog
          titleId={titleId}
          task="critique"
          tasks={['critique']}
          promptId={manual.promptId}
          onClose={() => setManual(null)}
          onPaste={(_task, promptId) => setPaste({ promptId })}
        />
      ) : null}
      {paste ? <PasteResultDialog titleId={titleId} critique promptId={paste.promptId} onClose={() => setPaste(null)} /> : null}
    </div>
  )
}

interface PromptGroupProps {
  title: Title
  heading: string
  prompts: CritiquePrompt[]
  shared: boolean
  expanded: ReadonlySet<ID>
  onToggle: (id: ID) => void
  onAdd: () => void
  onAsk: (promptId: ID) => void
  focusId: ID | null
  onFocused: () => void
}

function PromptGroup({
  title,
  heading,
  prompts,
  shared,
  expanded,
  onToggle,
  onAdd,
  onAsk,
  focusId,
  onFocused,
}: PromptGroupProps) {
  return (
    <div className="cq-group" data-testid={shared ? 'critique-prompts-shared' : 'critique-prompts-title'}>
      <div className="cq-group-head">
        <h3>{heading}</h3>
        <span className="grow" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={onAdd}
          data-testid={shared ? 'add-shared-prompt' : 'add-title-prompt'}
        >
          <PlusIcon />
          プロンプトを追加
        </button>
      </div>
      {prompts.length === 0 ? (
        <p className="small muted cq-group-empty">
          {shared ? 'どのタイトルでも使うプロンプトはまだありません。' : 'このタイトル用のプロンプトはまだありません。'}
        </p>
      ) : (
        <ol className="sx-list">
          {prompts.map((p, i) => (
            <PromptCard
              key={p.id}
              title={title}
              prompt={p}
              first={i === 0}
              last={i === prompts.length - 1}
              expanded={expanded.has(p.id)}
              onToggle={onToggle}
              onAsk={onAsk}
              autoFocus={focusId === p.id}
              onFocused={onFocused}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

const PROMPT_FOCUS = { up: '[data-testid="prompt-up"]', down: '[data-testid="prompt-down"]' }

const PromptCard = memo(function PromptCard({
  title,
  prompt: p,
  first,
  last,
  expanded,
  onToggle,
  onAsk,
  autoFocus,
  onFocused,
}: {
  title: Title
  prompt: CritiquePrompt
  first: boolean
  last: boolean
  expanded: boolean
  onToggle: (id: ID) => void
  onAsk: (promptId: ID) => void
  autoFocus: boolean
  onFocused: () => void
}) {
  const { ref, move } = useKeepInPlace<HTMLLIElement>()
  const name = p.name.trim()
  const badge = sourceLabel(p.source)
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? PROMPT_FOCUS.up : PROMPT_FOCUS.down
    const other = dir < 0 ? PROMPT_FOCUS.down : PROMPT_FOCUS.up
    move(() => attempt(() => (actions.moveCritiquePromptStep(p.id, dir), true)), [same, other])
  }
  const commit = (patch: { name?: string; body?: string }) => {
    const cur = getData().critiquePrompts[p.id]
    if (!cur) return
    if (patch.name !== undefined && patch.name === cur.name) return
    if (patch.body !== undefined && patch.body === cur.body) return
    attempt(() => actions.updateCritiquePrompt(p.id, patch))
  }
  const copyForClaude = () => {
    const now = getData()
    const cur = now.critiquePrompts[p.id] ?? p
    void copyText(
      critiqueConnectorPrompt(title, cur, benchWorksOfTitle(now, title.id)),
      'Claude 用の依頼をコピーしました（コネクタを付けたチャットに貼り付けてください）',
    )
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${name || '名前のないプロンプト'}」を削除しますか？`,
      message: trashNotice(p.titleId === null ? '共通のプロンプトなので、どのタイトルからも見えなくなります。' : ''),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteCritiquePrompt(p.id), true))) notify('批評プロンプトをゴミ箱に移しました')
  }
  const bodyId = `cq-prompt-${p.id}`
  return (
    <li
      ref={ref}
      className={`sx-card cq-prompt${expanded ? ' is-open' : ''}`}
      data-testid="critique-prompt"
      data-prompt-id={p.id}
    >
      <div className="sx-card-head">
        <button
          type="button"
          className="sx-card-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          onClick={() => onToggle(p.id)}
          data-testid="prompt-toggle"
        >
          <span className="sx-card-text">
            <span className={`sx-card-name${name ? '' : ' is-empty'}`} data-testid="prompt-name">
              {name || '名前のないプロンプト'}
            </span>
            {!expanded && p.body.trim() ? (
              // 長い依頼文でも、見せる最初の部分だけを整える
              <span className="sx-card-preview">{previewText(p.body.slice(0, PREVIEW_SOURCE))}</span>
            ) : null}
          </span>
          <ChevronRightIcon className="icon sx-chevron" />
        </button>
        <span className="sx-order">
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={first}
            aria-label="1つ上へ"
            title="1つ上へ"
            data-testid="prompt-up"
          >
            <ArrowUpIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(1)}
            disabled={last}
            aria-label="1つ下へ"
            title="1つ下へ"
            data-testid="prompt-down"
          >
            <ArrowDownIcon />
          </button>
        </span>
      </div>
      <div className="cq-prompt-actions">
        <button type="button" className="btn btn-sm" onClick={copyForClaude} data-testid="prompt-copy">
          <CopyIcon />
          Claude 用にコピー
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onAsk(p.id)} data-testid="prompt-manual">
          <AskIcon />
          手動で頼む
        </button>
        {badge ? (
          <span className="badge cl-badge">
            <SparkIcon />
            {badge}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="sx-card-body" id={bodyId}>
          <label className="field">
            <span>名前</span>
            <DraftInput
              key={`${p.id}:name`}
              className="input"
              value={p.name}
              onCommit={(v) => commit({ name: v })}
              placeholder="例：全体の構成と人物の弧"
              autoFocus={autoFocus}
              onFocus={autoFocus ? onFocused : undefined}
              data-testid="prompt-name-input"
            />
          </label>
          <label className="field">
            <span>依頼文（採用原稿でタイトル全体を読んでもらう前提で書きます）</span>
            <GrowTextarea
              key={`${p.id}:body`}
              className="textarea cq-prompt-body"
              rows={5}
              value={p.body}
              onCommit={(v) => commit({ body: v })}
              placeholder="例：プロの編集者として、構成・人物・文章の3つの観点で、良い点と直すべき点を具体的な場面を挙げて批評してください。"
              data-testid="prompt-body-input"
            />
          </label>
          <div className="sx-card-actions">
            <span className="grow" />
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()} data-testid="prompt-delete">
              <TrashIcon />
              削除
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
})

const ResultCard = memo(function ResultCard({
  r,
  current,
  prompts,
  benchWorks,
}: {
  r: CritiqueResult
  current: CritiqueManuscript | null
  prompts: Record<ID, CritiquePrompt>
  /** 比べた作品の名前を出すための棚（比べた作品のある結果だけに渡す。ほかの結果は棚が変わっても描き直さない） */
  benchWorks?: Record<ID, BenchWork>
}) {
  const [full, setFull] = useState(false)
  const badge = sourceLabel(r.source)
  const long = r.resultMarkdown.length > LONG_RESULT
  const heading = resultHeading(r)
  const promptGone = r.promptId !== null && !prompts[r.promptId]
  const remove = async () => {
    const ok = await confirmDialog({
      title: '批評の結果を削除しますか？',
      message: trashNotice(),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteCritiqueResult(r.id), true))) notify('批評の結果をゴミ箱に移しました')
  }
  return (
    <li className="sx-card cq-result" data-testid="critique-result" data-result-id={r.id}>
      <div className="cq-result-head">
        <span className="badge cl-badge" data-testid="critique-result-source">
          <SparkIcon />
          {badge ?? '手で記録'}
        </span>
        <h4 className="cq-result-title" data-testid="critique-result-title">
          {heading}
        </h4>
        {isNewerRecord(r) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
        <button
          type="button"
          className="icon-btn"
          onClick={() => void remove()}
          aria-label="批評の結果を削除"
          title="削除（ゴミ箱へ）"
          data-testid="critique-result-delete"
        >
          <TrashIcon />
        </button>
      </div>
      <p className="cq-result-meta">
        <span data-testid="critique-result-scope">{scopeLabel(r)}</span>
        {r.manuscript ? (
          <span data-testid="critique-result-manuscript">{manuscriptLabel(r.manuscript, current ?? undefined)}</span>
        ) : null}
        {r.model.trim() ? <span>{r.model}</span> : null}
      </p>
      {benchWorks && r.benchWorkIds?.length ? <ComparedWorks ids={r.benchWorkIds} works={benchWorks} /> : null}
      {r.promptText.trim() ? (
        <details className="cq-snapshot">
          <summary data-testid="critique-result-prompt-toggle">
            <ChevronRightIcon className="icon cq-snapshot-chevron" />
            使ったプロンプト{promptGone ? '（プロンプトは削除されています）' : ''}
          </summary>
          <pre className="cq-snapshot-text" data-testid="critique-result-prompt">
            {r.promptText}
          </pre>
        </details>
      ) : null}
      {r.resultMarkdown.trim() ? (
        <>
          <div className={`cq-result-body${long && !full ? ' is-clamped' : ''}`}>
            <Markdown text={r.resultMarkdown} preview={long && !full} testId="critique-result-body" />
          </div>
          {long ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm sn-more"
              aria-expanded={full}
              onClick={() => setFull((v) => !v)}
              data-testid="critique-result-more"
            >
              <ChevronRightIcon className="icon sx-chevron" />
              {full ? '折りたたむ' : '全文を表示'}
            </button>
          ) : null}
        </>
      ) : null}
      <ArtifactUrl r={r} />
      <label className="field cq-note">
        <span>メモ</span>
        <GrowTextarea
          key={`${r.id}:note`}
          className="textarea"
          rows={1}
          value={r.note}
          onCommit={(v) => {
            const cur = getData().critiqueResults[r.id]
            if (cur && cur.note !== v) attempt(() => actions.updateCritiqueResult(r.id, { note: v }))
          }}
          placeholder="批評を読んで考えたこと・直す予定など"
          data-testid="critique-result-note"
        />
      </label>
    </li>
  )
})

/** アーティファクトの URL（https だけ。確定した時＝Enter・フォーカスを外した時に確かめて保存する） */
function ArtifactUrl({ r }: { r: CritiqueResult }) {
  const [draft, setDraft] = useState(r.artifactUrl)
  const [error, setError] = useState<string | null>(null)
  const [base, setBase] = useState(r.artifactUrl)
  // 別の端末などで URL が変わったら、入力欄も合わせる
  if (base !== r.artifactUrl) {
    setBase(r.artifactUrl)
    setDraft(r.artifactUrl)
  }
  const commit = () => {
    const v = draft.trim()
    if (v === r.artifactUrl) {
      setError(null)
      return
    }
    if (v && !isHttpsUrl(v)) {
      setError('https:// で始まる URL を入れてください')
      return
    }
    setError(null)
    attempt(() => actions.updateCritiqueResult(r.id, { artifactUrl: v }))
  }
  return (
    <div className="field cq-url">
      <span id={`cq-url-${r.id}`}>アーティファクトの URL</span>
      <div className="cq-url-row">
        <input
          className="input"
          type="url"
          inputMode="url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="https://claude.ai/…"
          aria-labelledby={`cq-url-${r.id}`}
          aria-invalid={error ? true : undefined}
          data-testid="critique-result-url"
        />
        {r.artifactUrl ? (
          <a
            className="btn btn-sm"
            href={r.artifactUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="critique-result-url-open"
          >
            <LinkIcon />
            開く
          </a>
        ) : null}
      </div>
      {error ? (
        <span className="cl-error small" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 「相対比較する作品」: ホームの「相対比較」から、このタイトルと比べる作品を選ぶ（作品の画面へのリンクと、外す ×）。
 * Claude はコネクタでその分析を読み、手動の依頼には分析を入れられる
 */
function CompareWorks({
  titleId,
  comparing,
  benchWorks,
}: {
  titleId: ID
  comparing: readonly BenchWork[]
  benchWorks: Record<ID, BenchWork>
}) {
  const shelf = useMemo(() => sortedBenchWorks({ benchWorks }), [benchWorks])
  const chosen = new Set(comparing.map((w) => w.id))
  const addable = shelf.filter((w) => !chosen.has(w.id))
  const add = (workId: string) => {
    if (!workId) return
    if (attempt(() => (actions.addTitleBenchWork(titleId, workId), true)))
      notify(`『${benchWorkName(benchWorks[workId])}』を相対比較する作品にしました`)
  }
  const remove = (w: BenchWork) => {
    if (attempt(() => (actions.removeTitleBenchWork(titleId, w.id), true)))
      notify(`『${benchWorkName(w)}』を相対比較する作品から外しました（作品はホームの「相対比較」に残ります）`)
  }
  return (
    <section className="bw-compare" data-area="bench" aria-labelledby="cq-bench-heading" data-testid="critique-bench">
      <div className="bw-compare-head">
        <h3 id="cq-bench-heading">
          <ShelfIcon />
          相対比較する作品
        </h3>
        <span className="small muted">
          {comparing.length
            ? 'Claude はコネクタでこれらの作品の分析を読んで比べます。'
            : 'ホームの「相対比較」から、このタイトルと比べる既存の作品を選べます。'}
        </span>
      </div>
      {comparing.length ? (
        <ul className="bw-chips" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {comparing.map((w) => (
            <li key={w.id} className="bw-compare-chip" data-testid="critique-bench-chip">
              <Link to={paths.bench(w.id)}>『{benchWorkName(w)}』</Link>
              <button
                type="button"
                className="icon-btn"
                onClick={() => remove(w)}
                aria-label={`『${benchWorkName(w)}』を相対比較する作品から外す`}
                title="相対比較する作品から外す"
                data-testid="critique-bench-remove"
              >
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {shelf.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }} data-testid="critique-bench-empty">
          相対比較にまだ作品がありません。<Link to={paths.homeArea('bench')}>ホームの「相対比較」</Link>で追加してください。
        </p>
      ) : addable.length ? (
        <select
          className="select bw-compare-add"
          value=""
          onChange={(e) => add(e.target.value)}
          aria-label="相対比較する作品を選ぶ"
          data-testid="critique-bench-add"
        >
          <option value="">＋ 相対比較する作品を選ぶ…</option>
          {addable.map((w) => (
            <option key={w.id} value={w.id}>
              {benchWorkName(w)}
              {w.author.trim() ? `（${w.author.trim()}）` : ''}
            </option>
          ))}
        </select>
      ) : null}
    </section>
  )
}

/** 批評の結果の「比べた作品: 『…』」（作品の画面へのリンク。相対比較から消えた作品は数だけ） */
function ComparedWorks({ ids, works }: { ids: readonly ID[]; works: Record<ID, BenchWork> }) {
  const shown = ids.map((id) => works[id]).filter((w): w is BenchWork => Boolean(w))
  const gone = ids.length - shown.length
  return (
    <p className="cq-result-bench" data-area="bench" data-testid="critique-result-bench">
      <span>比べた作品:</span>
      {shown.map((w) => (
        <Link key={w.id} to={paths.bench(w.id)} className="bw-chip" data-testid="critique-result-bench-chip">
          『{benchWorkName(w)}』
        </Link>
      ))}
      {gone > 0 ? <span className="small muted">（ほか{gone}作品は相対比較から削除されています）</span> : null}
    </p>
  )
}
