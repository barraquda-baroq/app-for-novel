// 2.3 の推敲案・改稿案・戦略メモ・作品批評の操作（アプリで手で書く・チェックする・削除する）。
// Claude（コネクタ・手動連携の貼り付け）が作った記録も、作った後はふつうのレコードとして編集・削除できる
// （コネクタは作るだけで、書き換え・削除はしない）。削除はゴミ箱へ（「チェック済みを削除」は1件にまとめる）。
import { locateExcerpt } from '../claude/anchor'
import { isProofCategory, PROOF_CATEGORY_LABELS } from '../claude/categories'
import { jstDate } from '../claude/dates'
import { isHttpsUrl, type NewRecord } from '../claude/records'
import { manuscriptOf } from '../claude/snapshot'
import { CLAUDE_RECORD_VERSION } from '../claude/visibility'
import { pieceFullLabel } from './structure'
import { orderOrigin, putInTrash, trashLabel } from './trash'
import { transact, type Tx } from './tx'
import {
  CLAUDE_TABLES,
  DomainError,
  type AppData,
  type ClaudeAccess,
  type CritiquePrompt,
  type CritiqueResult,
  type CritiqueScope,
  type ID,
  type ProofCategory,
  type ProofSuggestion,
  type RevisionIdea,
  type StrategyNote,
  type Submission,
} from './types'
import { newId, now } from './util'

const manual = (titleId: ID, ts: number) => ({
  v: CLAUDE_RECORD_VERSION,
  source: 'manual' as const,
  titleId,
  createdAt: ts,
  updatedAt: ts,
})

function requireTitle(tx: Tx, titleId: ID) {
  const t = tx.get('titles', titleId)
  if (!t) throw new DomainError('タイトルが見つかりません')
  return t
}

const titleName = (tx: Tx, titleId: ID | null) => (titleId ? (tx.get('titles', titleId)?.name ?? '') : '')

// ---------- タイトル ----------

/** タイトルを Claude に見せるか（見せない／読むだけ／読む＋書き込む） */
export function setTitleClaudeAccess(data: AppData, titleId: ID, access: ClaudeAccess): AppData {
  return transact(data, (tx) => {
    const t = requireTitle(tx, titleId)
    if (t.claudeAccess === access) return
    tx.put('titles', { ...t, claudeAccess: access, updatedAt: now() })
  }).data
}

// ---------- 改稿案 ----------

/** order で並ぶ、チェックしていない改稿案（同じタイトル） */
function openIdeas(tx: Tx, titleId: ID): RevisionIdea[] {
  return tx
    .all('revisionIdeas')
    .filter((r) => r.titleId === titleId && !r.checked)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

const nextIdeaOrder = (tx: Tx, titleId: ID) =>
  tx
    .all('revisionIdeas')
    .filter((r) => r.titleId === titleId)
    .reduce((m, r) => Math.max(m, r.order), -1) + 1

/** 改稿案を足す（チェックしていない案の末尾） */
export function addRevisionIdea(
  data: AppData,
  titleId: ID,
  init: { heading?: string; body?: string; pieceIds?: ID[] } = {},
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireTitle(tx, titleId)
    const ts = now()
    const idea: RevisionIdea = {
      id: newId(),
      ...manual(titleId, ts),
      heading: init.heading ?? '',
      body: init.body ?? '',
      checked: false,
      checkedAt: null,
      pieceIds: [...new Set(init.pieceIds ?? [])],
      order: nextIdeaOrder(tx, titleId),
    }
    tx.put('revisionIdeas', idea)
    return idea.id
  })
}

export function updateRevisionIdea(
  data: AppData,
  id: ID,
  patch: Partial<Pick<RevisionIdea, 'heading' | 'body' | 'pieceIds'>>,
): AppData {
  return transact(data, (tx) => {
    const r = tx.get('revisionIdeas', id)
    if (!r) throw new DomainError('改稿案が見つかりません')
    const next = { ...r, ...patch }
    if (patch.pieceIds) next.pieceIds = [...new Set(patch.pieceIds)]
    tx.put('revisionIdeas', { ...next, updatedAt: now() })
  }).data
}

/**
 * チェック（実装済み・ボツ）する・外す。チェックすると斜線＋グレーで下へ沈む（並びは src/claude/order.ts）。
 * 外すと、チェックしていない案の末尾に戻る
 */
export function setRevisionIdeaChecked(data: AppData, id: ID, checked: boolean): AppData {
  return transact(data, (tx) => {
    const r = tx.get('revisionIdeas', id)
    if (!r) throw new DomainError('改稿案が見つかりません')
    if (r.checked === checked) return
    const ts = now()
    tx.put('revisionIdeas', {
      ...r,
      checked,
      checkedAt: checked ? ts : null,
      ...(checked ? {} : { order: nextIdeaOrder(tx, r.titleId) }),
      updatedAt: ts,
    })
  }).data
}

/** チェックしていない改稿案の中で、index 番目（0から）へ移す */
export function moveRevisionIdeaTo(data: AppData, id: ID, index: number): AppData {
  return transact(data, (tx) => {
    const r = tx.get('revisionIdeas', id)
    if (!r) throw new DomainError('改稿案が見つかりません')
    if (r.checked) throw new DomainError('チェックした改稿案は並べ替えられません')
    const list = openIdeas(tx, r.titleId).filter((x) => x.id !== id)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, r)
    const ts = now()
    list.forEach((x, i) => {
      if (x.order !== i) tx.put('revisionIdeas', { ...x, order: i, updatedAt: ts })
    })
  }).data
}

/** チェックしていない改稿案の中で1つ上（-1）・下（+1）へ */
export function moveRevisionIdeaStep(data: AppData, id: ID, dir: -1 | 1): AppData {
  const r = data.revisionIdeas[id]
  if (!r || r.checked) return data
  const list = Object.values(data.revisionIdeas)
    .filter((x) => x.titleId === r.titleId && !x.checked)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const i = list.findIndex((x) => x.id === id)
  const to = i + dir
  if (i < 0 || to < 0 || to >= list.length) return data
  return moveRevisionIdeaTo(data, id, to)
}

export function deleteRevisionIdea(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const r = tx.get('revisionIdeas', id)
    if (!r) return
    putInTrash(tx, {
      kind: 'revisionIdea',
      label: trashLabel.revisionIdea(r),
      titleName: titleName(tx, r.titleId),
      origin: { titleId: r.titleId, ...orderOrigin(openIdeas(tx, r.titleId), id) },
      records: [{ table: 'revisionIdeas', record: r }],
    })
  }).data
}

// ---------- 推敲案 ----------

/**
 * 推敲案を手で足す。excerpt が話（幕に分けた話は各幕）の採用原稿に1か所だけあれば場所を控える
 * （無い・何か所もあれば場所なし。画面では excerpt で探す）
 */
export function addProofSuggestion(
  data: AppData,
  titleId: ID,
  init: {
    pieceId: ID
    excerpt: string
    suggestion?: string
    reason?: string
    category?: ProofCategory
    categoryLabel?: string
    flagged?: boolean
  },
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireTitle(tx, titleId)
    const piece = tx.get('pieces', init.pieceId)
    if (!piece || piece.titleId !== titleId) throw new DomainError('話が見つかりません')
    const located = init.excerpt ? locateExcerpt(tx.data, piece, init.excerpt) : { status: 'not_found' as const }
    const found = located.status === 'found' ? located : null
    const target = found ? found.segment.piece : piece
    const category = init.category && isProofCategory(init.category) ? init.category : 'other'
    const ts = now()
    const s: ProofSuggestion = {
      id: newId(),
      ...manual(titleId, ts),
      pieceId: target.id,
      parentId: target.kind === 'act' ? (target.parentId ?? null) : null,
      versionId: found ? found.segment.version.id : null,
      pieceLabel: pieceFullLabel(tx.data, target),
      anchor: found ? found.anchor : null,
      category,
      categoryLabel: init.categoryLabel?.trim() || PROOF_CATEGORY_LABELS[category],
      excerpt: init.excerpt,
      suggestion: init.suggestion ?? '',
      reason: init.reason ?? '',
      flagged: init.flagged === true,
      done: false,
      doneAt: null,
      runId: null,
      batchId: null,
    }
    tx.put('proofSuggestions', s)
    return s.id
  })
}

export function updateProofSuggestion(
  data: AppData,
  id: ID,
  patch: Partial<Pick<ProofSuggestion, 'excerpt' | 'suggestion' | 'reason' | 'category' | 'categoryLabel'>>,
): AppData {
  return transact(data, (tx) => {
    const s = tx.get('proofSuggestions', id)
    if (!s) throw new DomainError('推敲案が見つかりません')
    const next = { ...s, ...patch }
    // 種類を変えたら、名前も決まった名前にする（名前だけを変えた時はそのまま）
    if (patch.category !== undefined && patch.categoryLabel === undefined && isProofCategory(patch.category))
      next.categoryLabel = PROOF_CATEGORY_LABELS[patch.category]
    tx.put('proofSuggestions', { ...next, updatedAt: now() })
  }).data
}

/** フラグ（常に一番上） */
export function setProofFlagged(data: AppData, id: ID, flagged: boolean): AppData {
  return transact(data, (tx) => {
    const s = tx.get('proofSuggestions', id)
    if (!s) throw new DomainError('推敲案が見つかりません')
    if (s.flagged === flagged) return
    tx.put('proofSuggestions', { ...s, flagged, updatedAt: now() })
  }).data
}

/** チェック（消し込み）。チェックしたものは斜線＋グレーで下へ */
export function setProofDone(data: AppData, id: ID, done: boolean): AppData {
  return transact(data, (tx) => {
    const s = tx.get('proofSuggestions', id)
    if (!s) throw new DomainError('推敲案が見つかりません')
    if (s.done === done) return
    const ts = now()
    tx.put('proofSuggestions', { ...s, done, doneAt: done ? ts : null, updatedAt: ts })
  }).data
}

export function deleteProofSuggestion(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const s = tx.get('proofSuggestions', id)
    if (!s) return
    putInTrash(tx, {
      kind: 'proofSuggestion',
      label: trashLabel.proofSuggestion(s),
      titleName: titleName(tx, s.titleId),
      ...(s.pieceLabel ? { parentLabel: s.pieceLabel } : {}),
      origin: { titleId: s.titleId, index: -1 },
      records: [{ table: 'proofSuggestions', record: s }],
    })
  }).data
}

/**
 * 「チェック済みを削除」: タイトルのチェックした推敲案をまとめてゴミ箱の1件にする（戻すとまとめて戻る）。
 * ids を渡すとその中のチェックしたものだけ（絞り込んで表示しているものだけ）。消したものが無ければ data のまま
 */
export function deleteCheckedProofSuggestions(data: AppData, titleId: ID, ids?: readonly ID[]): AppData {
  const only = ids ? new Set(ids) : null
  const done = Object.values(data.proofSuggestions)
    .filter((s) => s.titleId === titleId && s.done && (!only || only.has(s.id)))
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  if (!done.length) return data
  return transact(data, (tx) => {
    putInTrash(tx, {
      kind: 'proofSuggestion',
      label: done.length === 1 ? trashLabel.proofSuggestion(done[0]) : trashLabel.proofSuggestions(done.length),
      titleName: titleName(tx, titleId),
      origin: { titleId, index: -1 },
      records: done.map((record) => ({ table: 'proofSuggestions' as const, record })),
    })
  }).data
}

// ---------- 批評プロンプト ----------

function promptsIn(tx: Tx, titleId: ID | null): CritiquePrompt[] {
  return tx
    .all('critiquePrompts')
    .filter((p) => p.titleId === titleId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 批評プロンプトを足す。titleId = null は共通（どのタイトルでも使う） */
export function addCritiquePrompt(
  data: AppData,
  titleId: ID | null,
  init: { name?: string; body?: string } = {},
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (titleId !== null) requireTitle(tx, titleId)
    const ts = now()
    const p: CritiquePrompt = {
      id: newId(),
      ...manual('', ts),
      titleId,
      name: init.name ?? '',
      body: init.body ?? '',
      order: promptsIn(tx, titleId).reduce((m, x) => Math.max(m, x.order), -1) + 1,
    }
    tx.put('critiquePrompts', p)
    return p.id
  })
}

export function updateCritiquePrompt(data: AppData, id: ID, patch: Partial<Pick<CritiquePrompt, 'name' | 'body'>>): AppData {
  return transact(data, (tx) => {
    const p = tx.get('critiquePrompts', id)
    if (!p) throw new DomainError('批評プロンプトが見つかりません')
    tx.put('critiquePrompts', { ...p, ...patch, updatedAt: now() })
  }).data
}

/** 同じ範囲（このタイトルのもの・共通のもの）の中で index 番目（0から）へ移す */
export function moveCritiquePromptTo(data: AppData, id: ID, index: number): AppData {
  return transact(data, (tx) => {
    const p = tx.get('critiquePrompts', id)
    if (!p) throw new DomainError('批評プロンプトが見つかりません')
    const list = promptsIn(tx, p.titleId).filter((x) => x.id !== id)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, p)
    const ts = now()
    list.forEach((x, i) => {
      if (x.order !== i) tx.put('critiquePrompts', { ...x, order: i, updatedAt: ts })
    })
  }).data
}

export function moveCritiquePromptStep(data: AppData, id: ID, dir: -1 | 1): AppData {
  const p = data.critiquePrompts[id]
  if (!p) return data
  const list = Object.values(data.critiquePrompts)
    .filter((x) => x.titleId === p.titleId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const i = list.findIndex((x) => x.id === id)
  const to = i + dir
  if (i < 0 || to < 0 || to >= list.length) return data
  return moveCritiquePromptTo(data, id, to)
}

export function deleteCritiquePrompt(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const p = tx.get('critiquePrompts', id)
    if (!p) return
    putInTrash(tx, {
      kind: 'critiquePrompt',
      label: trashLabel.critiquePrompt(p),
      titleName: p.titleId ? titleName(tx, p.titleId) : '',
      ...(p.titleId === null ? { parentLabel: '共通の批評プロンプト' } : {}),
      origin: { titleId: p.titleId, ...orderOrigin(promptsIn(tx, p.titleId), id) },
      records: [{ table: 'critiquePrompts', record: p }],
    })
  }).data
}

// ---------- 批評結果 ----------

function checkUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const u = url.trim()
  if (u && !isHttpsUrl(u)) throw new DomainError('アーティファクトの URL は https:// で始まる URL にしてください')
  return u
}

/** 批評結果を手で足す（プロンプトの控えと、いまの採用原稿の控えを付ける） */
export function addCritiqueResult(
  data: AppData,
  titleId: ID,
  init: {
    promptId?: ID | null
    resultMarkdown?: string
    artifactUrl?: string
    note?: string
    runDate?: string
    scope?: CritiqueScope
    model?: string
  } = {},
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireTitle(tx, titleId)
    const prompt = init.promptId ? tx.get('critiquePrompts', init.promptId) : undefined
    const ts = now()
    const r: CritiqueResult = {
      id: newId(),
      ...manual(titleId, ts),
      promptId: prompt?.id ?? null,
      promptName: prompt?.name ?? '',
      promptText: prompt?.body ?? '',
      runDate: init.runDate ?? jstDate(ts),
      resultMarkdown: init.resultMarkdown ?? '',
      artifactUrl: checkUrl(init.artifactUrl) ?? '',
      scope: init.scope ?? { kind: 'whole' },
      manuscript: manuscriptOf(tx.data, titleId, ts),
      model: init.model ?? '',
      note: init.note ?? '',
    }
    tx.put('critiqueResults', r)
    return r.id
  })
}

/** 批評結果のアーティファクトの URL（https だけ。空で消す）・メモ・本文を直す */
export function updateCritiqueResult(
  data: AppData,
  id: ID,
  patch: Partial<Pick<CritiqueResult, 'artifactUrl' | 'note' | 'resultMarkdown'>>,
): AppData {
  return transact(data, (tx) => {
    const r = tx.get('critiqueResults', id)
    if (!r) throw new DomainError('批評結果が見つかりません')
    const url = checkUrl(patch.artifactUrl)
    tx.put('critiqueResults', { ...r, ...patch, ...(url !== undefined ? { artifactUrl: url } : {}), updatedAt: now() })
  }).data
}

export function deleteCritiqueResult(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const r = tx.get('critiqueResults', id)
    if (!r) return
    putInTrash(tx, {
      kind: 'critiqueResult',
      label: trashLabel.critiqueResult(r),
      titleName: titleName(tx, r.titleId),
      origin: { titleId: r.titleId, index: -1 },
      records: [{ table: 'critiqueResults', record: r }],
    })
  }).data
}

// ---------- 戦略メモ ----------

/** ［全体戦略に追記］で足す文（「【Claude 2026-10-28】見出し」＋本文） */
export function strategyAppendText(note: Pick<StrategyNote, 'runDate' | 'heading' | 'body'>, today: string): string {
  const date = note.runDate || today
  const heading = note.heading.trim()
  return `【Claude ${date}】${heading}\n${note.body.trim()}`.trimEnd()
}

/**
 * ［全体戦略に追記］: タイトルの全体戦略の末尾に「【Claude YYYY-MM-DD】…」として足し、追記した日時を控える
 * （もう一度押すと、もう一度足す。画面では追記済みと出す）
 */
export function appendStrategyNoteToTitle(data: AppData, noteId: ID): AppData {
  return transact(data, (tx) => {
    const note = tx.get('strategyNotes', noteId)
    if (!note) throw new DomainError('戦略メモが見つかりません')
    const title = requireTitle(tx, note.titleId)
    const ts = now()
    const add = strategyAppendText(note, jstDate(ts))
    const current = title.strategyNote.replace(/\s+$/, '')
    tx.put('titles', { ...title, strategyNote: current ? `${current}\n\n${add}` : add, updatedAt: ts })
    tx.put('strategyNotes', { ...note, appliedAt: ts, updatedAt: ts })
  }).data
}

/**
 * ［応募計画にする］: 戦略メモのコンテストの候補から応募計画を作る（名前・主催・URL・締切・規定・相性を概要に、
 * 方針を改稿方針に入れる）。作った応募計画をコンテストの候補に控える。戻り値は応募計画の id
 */
export function contestToSubmission(data: AppData, noteId: ID, contestId: string): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const note = tx.get('strategyNotes', noteId)
    if (!note) throw new DomainError('戦略メモが見つかりません')
    requireTitle(tx, note.titleId)
    const contest = note.contests.find((c) => c.id === contestId)
    if (!contest) throw new DomainError('コンテストの候補が見つかりません')
    const existing = contest.submissionId ? tx.get('submissions', contest.submissionId) : undefined
    if (existing) return existing.id
    const ts = now()
    const s: Submission = {
      id: newId(),
      titleId: note.titleId,
      order:
        tx
          .all('submissions')
          .filter((x) => x.titleId === note.titleId)
          .reduce((m, x) => Math.max(m, x.order), -1) + 1,
      contestName: contest.name,
      organizer: contest.organizer,
      url: contest.url,
      deadline: contest.deadline,
      submittedOn: '',
      resultOn: '',
      status: 'considering',
      stage: '',
      overview: contest.fit,
      minChars: contest.minChars,
      maxChars: contest.maxChars,
      limitUnit: contest.limitUnit,
      result: '',
      revisionPlan: contest.plan,
      resubmissionPlan: '',
      snapshot: null,
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('submissions', s)
    tx.put('strategyNotes', {
      ...note,
      contests: note.contests.map((c) => (c.id === contestId ? { ...c, submissionId: s.id } : c)),
      updatedAt: ts,
    })
    return s.id
  })
}

export function deleteStrategyNote(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const n = tx.get('strategyNotes', id)
    if (!n) return
    putInTrash(tx, {
      kind: 'strategyNote',
      label: trashLabel.strategyNote(n),
      titleName: titleName(tx, n.titleId),
      origin: { titleId: n.titleId, index: -1 },
      records: [{ table: 'strategyNotes', record: n }],
    })
  }).data
}

// ---------- Claude の記録（手動連携の貼り付け） ----------

/**
 * src/claude/records.ts で作った記録を入れる。もうあるもの（同じ内容を2回貼り付けた）・ゴミ箱にあるもの（以前に削除した）・
 * タイトルが無いものは入れない。戻り値は入れた記録の id
 */
export function addClaudeRecords(data: AppData, records: readonly NewRecord[]): { data: AppData; result: ID[] } {
  const trashed = new Set<string>()
  for (const r of Object.values(data.trashRecords)) {
    const rec = r.record as { id?: unknown }
    if (typeof rec?.id === 'string') trashed.add(`${r.table}:${rec.id}`)
  }
  return transact(data, (tx) => {
    const added: ID[] = []
    for (const { table, record } of records) {
      if (!(CLAUDE_TABLES as readonly string[]).includes(table)) continue
      if (tx.get(table, record.id) || trashed.has(`${table}:${record.id}`)) continue
      const titleId = (record as { titleId: ID | null }).titleId
      if (titleId !== null && !tx.get('titles', titleId)) continue
      if (titleId === null && table !== 'critiquePrompts') continue
      tx.put(table, record as AppData[typeof table][string])
      added.push(record.id)
    }
    return added
  })
}
