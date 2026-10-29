// 読み込んだデータの整合性を直す。壊れたバックアップや、別タブとの競合で参照が切れたデータでも
// 画面が落ちないよう、起動時とバックアップ復元時に通す。直せないものは安全側（削除・未分類）に倒す。
import { deepEqual } from './equal'
import { textHash } from './text'
import { TRASH_KIND_LABELS, isContentTable, isTrashKind } from './trash'
import {
  type AppData,
  type Chapter,
  type ClaudeSource,
  type ClaudeTableName,
  type CritiqueManuscript,
  type CritiqueScope,
  type ID,
  type Idea,
  type Memo,
  type NodeRef,
  type Piece,
  type ProofAnchor,
  type ProofCategory,
  type ProofCovered,
  type SettingCategory,
  type SettingEntry,
  type SettingField,
  type SnapshotPiece,
  type StrategyContest,
  type Submission,
  type SubmissionSnapshot,
  type SubmissionStatus,
  type Title,
  type TrashEntry,
  type TrashOrigin,
  type TrashRecord,
  type Version,
} from './types'

export interface RepairResult {
  data: AppData
  /** 直した箇所の説明（空なら変更なし） */
  fixes: string[]
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 幕か。幕は kind 'act'。古い版（2.1 まで）の端末は知らない kind を第n話（'episode'）にして書き戻すことがあるので、
 * 属する話（parentId。幕だけが持つ）があれば幕として扱う（第n話として本編に並べない）
 */
const isActPiece = (p: Piece): boolean => p.kind === 'act' || (p.kind !== 'special' && typeof p.parentId === 'string')

const STATUSES: SubmissionStatus[] = [
  'considering',
  'planned',
  'submitted',
  'reviewing',
  'passed',
  'won',
  'rejected',
  'withdrawn',
]

/** 変わった時だけ差し替える（同じ内容なら元のオブジェクトを使い続ける） */
function same(a: unknown, b: unknown): boolean {
  return deepEqual(a, b)
}

function normalizeSnapshot(raw: unknown, texts: AppData['snapshotTexts'], fix: (m: string) => void): SubmissionSnapshot | null {
  if (raw === null || raw === undefined) return null
  if (!isObj(raw) || !isObj(raw.activeVersions)) {
    fix('壊れた応募時の原稿の記録を取り除きました')
    return null
  }
  const activeVersions: Record<ID, ID | null> = {}
  for (const [k, v] of Object.entries(raw.activeVersions)) activeVersions[k] = typeof v === 'string' ? v : null
  const snap: SubmissionSnapshot = {
    at: num(raw.at),
    charCount: num(raw.charCount),
    activeVersions,
  }
  if (typeof raw.pages === 'number') snap.pages = raw.pages
  if (Array.isArray(raw.order)) snap.order = raw.order.filter((x): x is string => typeof x === 'string')
  if (isObj(raw.pieces)) {
    const pieces: Record<ID, SnapshotPiece> = {}
    for (const [id, p] of Object.entries(raw.pieces)) {
      if (!isObj(p)) continue
      let textKey = strOrNull(p.textKey)
      const legacyBody = typeof p.body === 'string' ? p.body : null
      // 古い記録の本文（記録の中に直接入っていたもの）は、本文の控えの表へ移す
      if (!textKey && legacyBody !== null) {
        textKey = `${textHash(legacyBody)}-${legacyBody.length.toString(36)}`
        for (let n = 1; texts[textKey] && texts[textKey].body !== legacyBody; n++) {
          textKey = `${textHash(legacyBody)}-${legacyBody.length.toString(36)}-${n}`
        }
        texts[textKey] = { id: textKey, body: legacyBody }
      }
      if (textKey && !texts[textKey]) textKey = null
      pieces[id] = {
        kind: p.kind === 'special' ? 'special' : 'episode',
        label: str(p.label),
        subtitle: str(p.subtitle),
        versionId: strOrNull(p.versionId),
        versionName: strOrNull(p.versionName),
        chars: num(p.chars),
        textKey,
        hash: str(p.hash),
      }
    }
    snap.pieces = pieces
  }
  // 提出した梗概・あらすじ／キャッチコピーの控え（後から足した項目。古い記録には無い）
  if (typeof raw.synopsis === 'string') snap.synopsis = raw.synopsis
  if (typeof raw.catchphrase === 'string') snap.catchphrase = raw.catchphrase
  return snap
}

/**
 * 応募計画の後から足した項目（規定の備考・提出する梗概／キャッチコピー・特記事項）。
 * 古いデータには無いので、無い項目は無いまま（画面では空・規定なしとして扱い、補ったことにもしない）。
 * ある項目は形だけ直す
 */
function submissionExtras(s: Submission): Partial<Submission> {
  const out: Partial<Submission> = {}
  for (const k of ['limitNote', 'synopsis', 'catchphrase', 'specialNotes'] as const) if (s[k] !== undefined) out[k] = str(s[k])
  for (const k of ['synopsisMin', 'synopsisMax', 'catchphraseMin', 'catchphraseMax'] as const)
    if (s[k] !== undefined) out[k] = numOrNull(s[k])
  return out
}

export function repairData(input: AppData): RepairResult {
  const fixes: string[] = []
  const d: AppData = {
    titles: { ...input.titles },
    chapters: { ...input.chapters },
    pieces: { ...input.pieces },
    versions: { ...input.versions },
    memos: { ...input.memos },
    ideas: { ...input.ideas },
    settingCategories: { ...input.settingCategories },
    settingEntries: { ...input.settingEntries },
    submissions: { ...input.submissions },
    snapshotTexts: { ...(input.snapshotTexts ?? {}) },
    // 2.3 の表（古いバックアップ・古い形のデータには無い）
    proofSuggestions: { ...(input.proofSuggestions ?? {}) },
    proofBatches: { ...(input.proofBatches ?? {}) },
    revisionIdeas: { ...(input.revisionIdeas ?? {}) },
    strategyNotes: { ...(input.strategyNotes ?? {}) },
    critiquePrompts: { ...(input.critiquePrompts ?? {}) },
    critiqueResults: { ...(input.critiqueResults ?? {}) },
    trashEntries: { ...(input.trashEntries ?? {}) },
    trashRecords: { ...(input.trashRecords ?? {}) },
  }
  const fix = (msg: string) => fixes.push(msg)

  // id が一致しない・オブジェクトでないレコードを取り除く
  for (const table of Object.keys(d) as (keyof AppData)[]) {
    const rows = d[table] as Record<ID, unknown>
    for (const [id, rec] of Object.entries(rows)) {
      if (!isObj(rec) || rec.id !== id) {
        delete rows[id]
        fix('形式の壊れたレコードを取り除きました')
      }
    }
  }

  // タイトル: 必須項目
  for (const t of Object.values(d.titles)) {
    const next: Title = {
      ...t,
      name: str(t.name, '無題のタイトル'),
      synopsis: str(t.synopsis),
      strategyNote: str(t.strategyNote),
      chaptersEnabled: Boolean(t.chaptersEnabled),
      numbering: t.numbering === 'perChapter' ? 'perChapter' : 'continuous',
      structure: Array.isArray(t.structure) ? t.structure : [],
      order: num(t.order),
      createdAt: num(t.createdAt),
      updatedAt: num(t.updatedAt),
    }
    if (!same(next, t)) {
      d.titles[t.id] = next
      fix(`タイトル「${next.name}」の項目を補いました`)
    }
  }

  // タイトルのないレコードを消す
  const dropOrphans = <T extends 'chapters' | 'pieces' | 'memos' | 'settingCategories' | 'submissions'>(
    table: T,
    label: string,
  ) => {
    for (const r of Object.values(d[table]) as { id: ID; titleId: ID }[]) {
      if (!d.titles[r.titleId]) {
        delete (d[table] as Record<ID, unknown>)[r.id]
        fix(`タイトルのない${label}を削除しました`)
      }
    }
  }
  dropOrphans('chapters', '章')
  dropOrphans('pieces', '話')
  dropOrphans('memos', 'メモ')
  dropOrphans('settingCategories', '設定項目')
  dropOrphans('submissions', '応募計画')

  // 幕: 属する話（同じタイトルの第n話）がなければ見えなくする（同期の途中で、話より先に幕が届いた時など）。
  // 幕の稿も、話のない稿として下で一緒に見えなくなる
  for (const p of Object.values(d.pieces)) {
    if (!isActPiece(p)) continue
    const parent = typeof p.parentId === 'string' ? d.pieces[p.parentId] : undefined
    if (!parent || parent.kind === 'special' || isActPiece(parent) || parent.titleId !== p.titleId) {
      delete d.pieces[p.id]
      fix('属する話のない幕を表示から外しました')
    }
  }

  // 章・メモ・設定項目の必須項目
  for (const c of Object.values(d.chapters)) {
    const next: Chapter = {
      ...c,
      name: str(c.name),
      note: str(c.note),
      pieceIds: Array.isArray(c.pieceIds) ? c.pieceIds.filter((x): x is string => typeof x === 'string') : [],
      createdAt: num(c.createdAt),
      updatedAt: num(c.updatedAt),
    }
    if (!same(next, c)) {
      d.chapters[c.id] = next
      fix('章の項目を補いました')
    }
  }
  for (const m of Object.values(d.memos)) {
    const next: Memo = {
      ...m,
      name: str(m.name),
      body: str(m.body),
      order: num(m.order),
      createdAt: num(m.createdAt),
      updatedAt: num(m.updatedAt),
    }
    if (!same(next, m)) {
      d.memos[m.id] = next
      fix('メモの項目を補いました')
    }
  }
  for (const c of Object.values(d.settingCategories)) {
    const next: SettingCategory = {
      ...c,
      name: str(c.name),
      fieldTemplate: Array.isArray(c.fieldTemplate) ? c.fieldTemplate.filter((x): x is string => typeof x === 'string') : [],
      order: num(c.order),
      createdAt: num(c.createdAt),
      updatedAt: num(c.updatedAt),
    }
    if (!same(next, c)) {
      d.settingCategories[c.id] = next
      fix('設定項目の項目を補いました')
    }
  }

  for (const e of Object.values(d.settingEntries)) {
    const cat = d.settingCategories[e.categoryId]
    if (!cat || !d.titles[e.titleId] || cat.titleId !== e.titleId) {
      delete d.settingEntries[e.id]
      fix('設定項目のないエントリを削除しました')
      continue
    }
    const fields: SettingField[] = (Array.isArray(e.fields) ? e.fields : [])
      .filter((f): f is SettingField => isObj(f) && typeof f.id === 'string')
      .map((f) => ({ id: f.id, key: str(f.key), value: str(f.value) }))
    const next: SettingEntry = {
      ...e,
      name: str(e.name),
      body: str(e.body),
      fields,
      order: num(e.order),
      createdAt: num(e.createdAt),
      updatedAt: num(e.updatedAt),
    }
    if (!same(next, e)) {
      d.settingEntries[e.id] = next
      fix('設定エントリの項目を補いました')
    }
  }

  // 推敲バージョン: 話のないものを消し、必須項目を補う
  for (const v of Object.values(d.versions)) {
    if (!d.pieces[v.pieceId]) {
      delete d.versions[v.id]
      fix('話のない推敲バージョンを削除しました')
      continue
    }
    const next: Version = {
      ...v,
      titleId: d.pieces[v.pieceId].titleId,
      name: str(v.name),
      body: str(v.body),
      note: str(v.note),
      sourceVersionId: strOrNull(v.sourceVersionId),
      createdAt: num(v.createdAt),
      updatedAt: num(v.updatedAt),
    }
    if (!same(next, v)) {
      d.versions[v.id] = next
      fix('推敲バージョンの項目を補いました')
    }
  }

  // 話: バージョン一覧と採用中の稿
  const versionsByPiece = new Map<ID, ID[]>()
  for (const v of Object.values(d.versions).sort((a, b) => num(a.createdAt) - num(b.createdAt))) {
    const list = versionsByPiece.get(v.pieceId) ?? []
    list.push(v.id)
    versionsByPiece.set(v.pieceId, list)
  }
  // 話を指している幕（作られた順。同じ時刻なら id の順にして、どの端末・タブでも同じ並びにする）。
  // 幕の並びに載っていない幕を後ろに足すのに使う
  const actsByParent = new Map<ID, ID[]>()
  const byCreated = (a: Piece, b: Piece) => num(a.createdAt) - num(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const p of Object.values(d.pieces).sort(byCreated)) {
    if (!isActPiece(p) || typeof p.parentId !== 'string') continue
    const list = actsByParent.get(p.parentId) ?? []
    list.push(p.id)
    actsByParent.set(p.parentId, list)
  }
  for (const p of Object.values(d.pieces)) {
    const owned = versionsByPiece.get(p.id) ?? []
    const listed = (Array.isArray(p.versionIds) ? p.versionIds : []).filter(
      (id, i, arr) => owned.includes(id) && arr.indexOf(id) === i,
    )
    const versionIds = [...listed, ...owned.filter((id) => !listed.includes(id))]
    const activeVersionId = p.activeVersionId && versionIds.includes(p.activeVersionId) ? p.activeVersionId : null
    // 幕は幕のまま（第n話にしない。古い版の端末が第n話として書いた幕も幕に戻す）
    const kind = p.kind === 'special' ? 'special' : isActPiece(p) ? 'act' : 'episode'
    const next: Piece = {
      ...p,
      kind,
      label: str(p.label),
      subtitle: str(p.subtitle),
      versionIds,
      activeVersionId,
      versionSeq: Math.max(num(p.versionSeq, 1), versionIds.length, 1),
      createdAt: num(p.createdAt),
      updatedAt: num(p.updatedAt),
    }
    // 幕に分けた話の幕の並び: この話を指している幕だけを残し（重複も除く）、載っていない幕は作られた順に後ろへ足す。
    // - 幕の並びが空（[]。セパレートを解除した話）なら、残っている幕は足さない（解除した端末の幕の削除が同期で届くまでの間や、
    //   解除と別の端末での幕の変更が重なった時に、採用稿のない幕・一部の幕だけの話に見えないように。残った幕は見えないまま、
    //   話の削除でいっしょに片付く）
    // - 幕の並びが無い（一度も分けていない話）のに話を指す幕があれば、分けた端末の話の更新より先に幕が届いたので、
    //   作られた順（＝読む順。acts.ts の newAct）に並べる
    // 第n話以外の幕の並びは使わない（そのまま残すが、どこからも読まない）
    if (kind === 'episode') {
      const mine = actsByParent.get(p.id) ?? []
      const raw: unknown[] = Array.isArray(p.actIds) ? p.actIds : []
      const kept = raw.filter((id, i): id is ID => typeof id === 'string' && mine.includes(id) && raw.indexOf(id) === i)
      const undone = Array.isArray(p.actIds) && p.actIds.length === 0
      const actIds = undone ? [] : [...kept, ...mine.filter((id) => !kept.includes(id))]
      if (Array.isArray(p.actIds) || actIds.length > 0) next.actIds = actIds
    }
    if (!same(next, p)) {
      d.pieces[p.id] = next
      fix(kind === 'act' ? '幕の推敲バージョン一覧を直しました' : '話の推敲バージョン一覧・幕の並びを直しました')
    }
  }

  // 本編の構成: 存在しない参照・重複参照を除き、どこにも入っていない話はタイトル直下の末尾へ
  const placed = new Set<ID>()
  const chapterSeen = new Set<ID>()
  const keepPiece = (t: Title, pid: unknown): pid is ID => {
    if (typeof pid !== 'string') return false
    const p = d.pieces[pid]
    // 幕は本編の並びに載せない（話の幕の並びにだけ載る）
    if (!p || p.titleId !== t.id || p.kind === 'act' || placed.has(pid)) return false
    placed.add(pid)
    return true
  }
  for (const t of Object.values(d.titles)) {
    const structure: NodeRef[] = []
    for (const node of t.structure as unknown[]) {
      if (!isObj(node)) continue
      if (node.type === 'chapter') {
        const ch = typeof node.id === 'string' ? d.chapters[node.id] : undefined
        if (!ch || ch.titleId !== t.id || chapterSeen.has(ch.id)) continue
        chapterSeen.add(ch.id)
        const pieceIds = ch.pieceIds.filter((pid) => keepPiece(t, pid))
        if (pieceIds.length !== ch.pieceIds.length) {
          d.chapters[ch.id] = { ...ch, pieceIds }
          fix(`章「${ch.name}」の話の一覧を直しました`)
        }
        structure.push({ type: 'chapter', id: ch.id })
      } else if (node.type === 'piece') {
        if (keepPiece(t, node.id)) structure.push({ type: 'piece', id: node.id as ID })
      }
    }
    // 構成に載っていない章（中身ごと）と話を末尾に戻す
    for (const ch of Object.values(d.chapters)) {
      if (ch.titleId !== t.id || chapterSeen.has(ch.id)) continue
      chapterSeen.add(ch.id)
      const pieceIds = ch.pieceIds.filter((pid) => keepPiece(t, pid))
      d.chapters[ch.id] = { ...ch, pieceIds }
      structure.push({ type: 'chapter', id: ch.id })
      fix(`構成から外れていた章「${ch.name}」を戻しました`)
    }
    for (const p of Object.values(d.pieces).sort((a, b) => num(a.createdAt) - num(b.createdAt))) {
      if (p.titleId !== t.id || p.kind === 'act' || placed.has(p.id)) continue
      placed.add(p.id)
      structure.push({ type: 'piece', id: p.id })
      fix('構成から外れていた話を末尾に戻しました')
    }
    if (!same(structure, t.structure)) {
      d.titles[t.id] = { ...d.titles[t.id], structure }
      fix('本編の構成から存在しない章・話への参照を取り除きました')
    }
  }

  // アイデア: 存在しないタイトルを指すものは「どのタイトルにも属さない」へ
  let unassignedOrder = Object.values(d.ideas)
    .filter((i) => i.titleId === null)
    .reduce((m, i) => Math.max(m, num(i.order)), -1)
  for (const idea of Object.values(d.ideas).sort((a, b) => num(a.order) - num(b.order))) {
    const orphan = idea.titleId !== null && (typeof idea.titleId !== 'string' || !d.titles[idea.titleId])
    if (orphan) unassignedOrder += 1
    const next: Idea = {
      ...idea,
      titleId: orphan ? null : idea.titleId,
      heading: str(idea.heading),
      body: str(idea.body),
      order: orphan ? unassignedOrder : num(idea.order),
      createdAt: num(idea.createdAt),
      updatedAt: num(idea.updatedAt),
    }
    if (!same(next, idea)) {
      d.ideas[idea.id] = next
      fix(orphan ? 'タイトルのないアイデアを「どのタイトルにも属さない」へ移しました' : 'アイデアの項目を補いました')
    }
  }

  // 応募計画: 必須項目と記録の形
  for (const s of Object.values(d.submissions)) {
    const unit = s.limitUnit === 'pages' ? 'pages' : 'chars'
    const next: Submission = {
      ...s,
      order: num(s.order),
      contestName: str(s.contestName),
      organizer: str(s.organizer),
      url: str(s.url),
      deadline: str(s.deadline),
      submittedOn: str(s.submittedOn),
      resultOn: str(s.resultOn),
      status: STATUSES.includes(s.status) ? s.status : 'considering',
      stage: str(s.stage),
      overview: str(s.overview),
      minChars: numOrNull(s.minChars),
      maxChars: numOrNull(s.maxChars),
      limitUnit: unit,
      ...submissionExtras(s),
      result: str(s.result),
      revisionPlan: str(s.revisionPlan),
      resubmissionPlan: str(s.resubmissionPlan),
      snapshot: normalizeSnapshot(s.snapshot, d.snapshotTexts, fix),
      createdAt: num(s.createdAt),
      updatedAt: num(s.updatedAt),
    }
    // limitUnit を持たない古いデータは「文字数」のまま（補ったことは数えない）
    const comparable = s.limitUnit === undefined ? { ...next, limitUnit: undefined } : next
    if (!same(comparable, s)) {
      d.submissions[s.id] = s.limitUnit === undefined ? { ...next } : next
      fix('応募計画の項目を補いました')
    }
  }

  // 本文の控え: 形の壊れたものと、どの記録からも使われていないものを消す
  const usedTexts = new Set<ID>()
  for (const s of Object.values(d.submissions)) {
    for (const p of Object.values(s.snapshot?.pieces ?? {})) if (p.textKey) usedTexts.add(p.textKey)
  }
  for (const t of Object.values(d.snapshotTexts)) {
    if (typeof t.body !== 'string' || !usedTexts.has(t.id)) {
      delete d.snapshotTexts[t.id]
      fix('使われていない応募時の原稿の控えを整理しました')
    }
  }

  repairClaudeRecords(d, fix)

  repairTrash(d, fix)

  return { data: fixes.length ? d : input, fixes }
}

// ---------- 2.3: 推敲案・改稿案・戦略メモ・作品批評 ----------
// 表示用に、足りない項目を補う（知らない項目はそのまま残す。新しい版のコネクタ・アプリが書いたものかもしれない）。
// タイトルが無いもの（共通の批評プロンプト以外）は見えなくする。話・稿・応募計画への参照は切れていても残す（画面で扱う）。

const bool = (v: unknown): boolean => v === true
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const SOURCES = ['claude', 'paste', 'manual'] as const
const source = (v: unknown): ClaudeSource => (SOURCES.includes(v as ClaudeSource) ? (v as ClaudeSource) : 'manual')

/** 共通の項目（v・source・日時） */
function claudeBase<T extends { v?: unknown; source?: unknown; createdAt?: unknown; updatedAt?: unknown }>(r: T) {
  return { v: num(r.v, 1), source: source(r.source), createdAt: num(r.createdAt), updatedAt: num(r.updatedAt) }
}

/** 名前の付いた項目を、文字列でなければ取り除く（無いままでよい項目） */
function optionalString<T extends object>(rec: T, key: string): T {
  const v = (rec as Record<string, unknown>)[key]
  if (v === undefined || typeof v === 'string') return rec
  const out = { ...rec } as Record<string, unknown>
  delete out[key]
  return out as T
}

function normalizeAnchor(raw: unknown): ProofAnchor | null {
  if (!isObj(raw)) return null
  return {
    ...raw,
    offset: num(raw.offset),
    length: num(raw.length),
    paragraph: num(raw.paragraph, 1),
    before: str(raw.before),
    after: str(raw.after),
    bodyHash: str(raw.bodyHash),
  } as ProofAnchor
}

function normalizeContest(raw: unknown, i: number): StrategyContest | null {
  if (!isObj(raw)) return null
  return {
    ...raw,
    id: str(raw.id, `k${i}`),
    name: str(raw.name),
    organizer: str(raw.organizer),
    url: str(raw.url),
    deadline: str(raw.deadline),
    minChars: numOrNull(raw.minChars),
    maxChars: numOrNull(raw.maxChars),
    limitUnit: raw.limitUnit === 'pages' ? 'pages' : 'chars',
    fit: str(raw.fit),
    plan: str(raw.plan),
    submissionId: strOrNull(raw.submissionId),
  } as StrategyContest
}

function normalizeScope(raw: unknown): CritiqueScope {
  if (isObj(raw) && raw.kind === 'range' && typeof raw.fromPieceId === 'string' && typeof raw.toPieceId === 'string') {
    return { ...raw, kind: 'range', fromPieceId: raw.fromPieceId, toPieceId: raw.toPieceId, label: str(raw.label) }
  }
  return isObj(raw) && raw.kind === 'whole' ? (raw as CritiqueScope) : { kind: 'whole' }
}

function normalizeManuscript(raw: unknown): CritiqueManuscript | null {
  if (!isObj(raw)) return null
  return { ...raw, chars: num(raw.chars), pieces: num(raw.pieces), hash: str(raw.hash), at: num(raw.at) } as CritiqueManuscript
}

function repairClaudeRecords(d: AppData, fix: (m: string) => void): void {
  /** タイトルの無いレコードを見えなくし、残りを normalize で整える */
  const each = <T extends ClaudeTableName>(
    table: T,
    label: string,
    normalize: (r: AppData[T][string]) => AppData[T][string],
    shared = false,
  ) => {
    const rows = d[table] as Record<ID, AppData[T][string]>
    for (const r of Object.values(rows)) {
      const titleId = (r as { titleId?: unknown }).titleId
      const keep = (shared && titleId === null) || (typeof titleId === 'string' && Boolean(d.titles[titleId]))
      if (!keep) {
        delete rows[r.id]
        fix(`タイトルのない${label}を表示から外しました`)
        continue
      }
      const next = normalize(r)
      if (!same(next, r)) {
        rows[r.id] = next
        fix(`${label}の項目を補いました`)
      }
    }
  }

  each('proofSuggestions', '推敲案', (r) =>
    optionalString(
      {
        ...r,
        ...claudeBase(r),
        pieceId: str(r.pieceId),
        parentId: strOrNull(r.parentId),
        versionId: strOrNull(r.versionId),
        pieceLabel: str(r.pieceLabel),
        anchor: normalizeAnchor(r.anchor),
        // 知らない種類（新しいコネクタが書いたもの）も、そのまま残す
        category: str(r.category, 'other') as ProofCategory,
        categoryLabel: str(r.categoryLabel),
        excerpt: str(r.excerpt),
        suggestion: str(r.suggestion),
        reason: str(r.reason),
        flagged: bool(r.flagged),
        done: bool(r.done),
        doneAt: numOrNull(r.doneAt),
        runId: strOrNull(r.runId),
        batchId: strOrNull(r.batchId),
      },
      'model',
    ),
  )
  each('proofBatches', '推敲案の実行の記録', (r) =>
    optionalString(
      {
        ...r,
        ...claudeBase(r),
        runId: str(r.runId),
        runLabel: str(r.runLabel),
        runDate: str(r.runDate),
        categories: strList(r.categories) as ProofCategory[],
        covered: (Array.isArray(r.covered) ? r.covered : [])
          .filter((c): c is ProofCovered => isObj(c) && typeof c.pieceId === 'string')
          .map((c) => ({ ...c, versionId: strOrNull(c.versionId), bodyHash: str(c.bodyHash), label: str(c.label) })),
        itemIds: strList(r.itemIds),
      },
      'model',
    ),
  )
  each('revisionIdeas', '改稿案', (r) => ({
    ...r,
    ...claudeBase(r),
    heading: str(r.heading),
    body: str(r.body),
    checked: bool(r.checked),
    checkedAt: numOrNull(r.checkedAt),
    pieceIds: strList(r.pieceIds),
    order: num(r.order),
  }))
  each('strategyNotes', '戦略メモ', (r) =>
    optionalString(
      {
        ...r,
        ...claudeBase(r),
        runDate: str(r.runDate),
        heading: str(r.heading),
        body: str(r.body),
        contests: (Array.isArray(r.contests) ? r.contests : [])
          .map((c, i) => normalizeContest(c, i))
          .filter((c): c is StrategyContest => c !== null),
        appliedAt: numOrNull(r.appliedAt),
      },
      'model',
    ),
  )
  each(
    'critiquePrompts',
    '批評プロンプト',
    (r) => ({
      ...r,
      ...claudeBase(r),
      titleId: strOrNull(r.titleId),
      name: str(r.name),
      body: str(r.body),
      order: num(r.order),
    }),
    true,
  )
  each('critiqueResults', '批評の結果', (r) => ({
    ...r,
    ...claudeBase(r),
    promptId: strOrNull(r.promptId),
    promptName: str(r.promptName),
    promptText: str(r.promptText),
    runDate: str(r.runDate),
    resultMarkdown: str(r.resultMarkdown),
    artifactUrl: str(r.artifactUrl),
    scope: normalizeScope(r.scope),
    manuscript: normalizeManuscript(r.manuscript),
    model: str(r.model),
    note: str(r.note),
  }))
}

/** 削除した時点の場所の形を整える（項目の順番は変えない。知らない項目は残す） */
function normalizeOrigin(raw: unknown): TrashOrigin {
  const o = isObj(raw) ? raw : {}
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(o)) {
    if (key === 'titleId' || key === 'chapterId' || key === 'prevId') out[key] = strOrNull(v)
    // 位置が分からない時は -1（戻す時は末尾、order で並ぶものは元の order の値の位置へ）
    else if (key === 'index') out[key] = num(v, -1)
    else if (key === 'pieceId' || key === 'parentId' || key === 'categoryId') {
      if (typeof v === 'string') out[key] = v
    } else if (key === 'wasActive') {
      if (typeof v === 'boolean') out[key] = v
    } else out[key] = v
  }
  if (!('titleId' in out)) out.titleId = null
  if (!('index' in out)) out.index = -1
  return out as unknown as TrashOrigin
}

/** ゴミ箱: 種類の分からない件・形の壊れた中身・件のない中身・中身のない件を取り除き、項目を補う */
function repairTrash(d: AppData, fix: (m: string) => void): void {
  for (const e of Object.values(d.trashEntries)) {
    if (!isTrashKind(e.kind)) {
      delete d.trashEntries[e.id]
      fix('種類の分からないゴミ箱の項目を取り除きました')
      continue
    }
    const next: TrashEntry = {
      ...e,
      label: str(e.label, TRASH_KIND_LABELS[e.kind]),
      titleName: str(e.titleName),
      origin: normalizeOrigin(e.origin),
      recordIds: Array.isArray(e.recordIds) ? e.recordIds.filter((x): x is string => typeof x === 'string') : [],
      reason: e.reason === 'conflict' ? 'conflict' : 'deleted',
      deletedAt: num(e.deletedAt, num(e.createdAt, num(e.updatedAt))),
      createdAt: num(e.createdAt),
      updatedAt: num(e.updatedAt),
    }
    if ('parentLabel' in next && typeof next.parentLabel !== 'string') delete next.parentLabel
    if (!same(next, e)) {
      d.trashEntries[e.id] = next
      fix('ゴミ箱の項目を補いました')
    }
  }

  const byEntry = new Map<ID, ID[]>()
  for (const r of Object.values(d.trashRecords)) {
    const rec: unknown = r.record
    if (!isContentTable(r.table) || !isObj(rec) || typeof rec.id !== 'string') {
      delete d.trashRecords[r.id]
      fix('形の壊れたゴミ箱の中身を取り除きました')
      continue
    }
    if (typeof r.entryId !== 'string' || !d.trashEntries[r.entryId]) {
      delete d.trashRecords[r.id]
      fix('ゴミ箱の項目のない中身を取り除きました')
      continue
    }
    const next: TrashRecord = { ...r, createdAt: num(r.createdAt), updatedAt: num(r.updatedAt) }
    if (!same(next, r)) {
      d.trashRecords[r.id] = next
      fix('ゴミ箱の中身の項目を補いました')
    }
    const list = byEntry.get(r.entryId) ?? []
    list.push(r.id)
    byEntry.set(r.entryId, list)
  }

  for (const e of Object.values(d.trashEntries)) {
    const owned = byEntry.get(e.id) ?? []
    if (owned.length === 0) {
      delete d.trashEntries[e.id]
      fix('中身のないゴミ箱の項目を取り除きました')
      continue
    }
    // 載っている順（先頭が本体）を保ち、載っていない中身は後ろに足す
    const ownedSet = new Set(owned)
    const listed = [...new Set(e.recordIds.filter((id) => ownedSet.has(id)))]
    const listedSet = new Set(listed)
    const recordIds = [...listed, ...owned.filter((id) => !listedSet.has(id))]
    if (!same(recordIds, e.recordIds)) {
      d.trashEntries[e.id] = { ...e, recordIds }
      fix('ゴミ箱の項目の中身の一覧を直しました')
    }
  }
}
