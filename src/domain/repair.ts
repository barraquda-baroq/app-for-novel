// 読み込んだデータの整合性を直す。壊れたバックアップや、別タブとの競合で参照が切れたデータでも
// 画面が落ちないよう、起動時とバックアップ復元時に通す。直せないものは安全側（削除・未分類）に倒す。
import { textHash } from './text'
import {
  type AppData,
  type Chapter,
  type ID,
  type Idea,
  type Memo,
  type NodeRef,
  type Piece,
  type SettingCategory,
  type SettingEntry,
  type SettingField,
  type SnapshotPiece,
  type Submission,
  type SubmissionSnapshot,
  type SubmissionStatus,
  type Title,
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
  return JSON.stringify(a) === JSON.stringify(b)
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
  return snap
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
  for (const p of Object.values(d.pieces)) {
    const owned = versionsByPiece.get(p.id) ?? []
    const listed = (Array.isArray(p.versionIds) ? p.versionIds : []).filter(
      (id, i, arr) => owned.includes(id) && arr.indexOf(id) === i,
    )
    const versionIds = [...listed, ...owned.filter((id) => !listed.includes(id))]
    const activeVersionId = p.activeVersionId && versionIds.includes(p.activeVersionId) ? p.activeVersionId : null
    const next: Piece = {
      ...p,
      kind: p.kind === 'special' ? 'special' : 'episode',
      label: str(p.label),
      subtitle: str(p.subtitle),
      versionIds,
      activeVersionId,
      versionSeq: Math.max(num(p.versionSeq, 1), versionIds.length, 1),
      createdAt: num(p.createdAt),
      updatedAt: num(p.updatedAt),
    }
    if (!same(next, p)) {
      d.pieces[p.id] = next
      fix('話の推敲バージョン一覧を直しました')
    }
  }

  // 本編の構成: 存在しない参照・重複参照を除き、どこにも入っていない話はタイトル直下の末尾へ
  const placed = new Set<ID>()
  const chapterSeen = new Set<ID>()
  const keepPiece = (t: Title, pid: unknown): pid is ID => {
    if (typeof pid !== 'string') return false
    const p = d.pieces[pid]
    if (!p || p.titleId !== t.id || placed.has(pid)) return false
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
      if (p.titleId !== t.id || placed.has(p.id)) continue
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

  return { data: fixes.length ? d : input, fixes }
}
