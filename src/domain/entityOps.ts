// タイトル・アイデア・メモ・設定項目・戦略（応募計画）の更新操作。
import { activeBody, episodeNumbers, flatten, pieceLabel } from './structure'
import { countChars, textStats } from './text'
import { Tx, transact } from './tx'
import {
  DomainError,
  type AppData,
  type ID,
  type Idea,
  type Memo,
  type SettingCategory,
  type SettingEntry,
  type SettingField,
  type SnapshotPiece,
  type Submission,
  type SubmissionSnapshot,
  type Title,
} from './types'
import { byOrder, newId, nextOrder, now, stepOrder } from './util'

function putAll<T extends 'titles' | 'ideas' | 'memos' | 'settingCategories' | 'settingEntries' | 'submissions'>(
  tx: Tx,
  table: T,
  records: AppData[T][string][],
): void {
  for (const r of records) tx.put(table, r)
}

// ---------- タイトル ----------

export const DEFAULT_SETTING_CATEGORIES: { name: string; fieldTemplate: string[] }[] = [
  { name: 'キャラクター', fieldTemplate: ['読み', '年齢', '性別', '立場・役割', '性格', '外見', '背景'] },
  { name: '世界観', fieldTemplate: [] },
]

export function sortedTitles(data: AppData): Title[] {
  return Object.values(data.titles).sort(byOrder)
}

export function createTitle(data: AppData, name: string): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const ts = now()
    const title: Title = {
      id: newId(),
      name: name.trim() || '無題のタイトル',
      synopsis: '',
      chaptersEnabled: false,
      numbering: 'continuous',
      structure: [],
      strategyNote: '',
      order: nextOrder(tx.all('titles')),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('titles', title)
    DEFAULT_SETTING_CATEGORIES.forEach((c, i) => {
      tx.put('settingCategories', {
        id: newId(),
        titleId: title.id,
        name: c.name,
        fieldTemplate: [...c.fieldTemplate],
        order: i,
        createdAt: ts,
        updatedAt: ts,
      })
    })
    return title.id
  })
}

export function updateTitle(data: AppData, titleId: ID, patch: Partial<Pick<Title, 'name' | 'synopsis' | 'strategyNote'>>): AppData {
  return transact(data, (tx) => {
    const t = tx.get('titles', titleId)
    if (!t) throw new DomainError('タイトルが見つかりません')
    tx.put('titles', { ...t, ...patch, updatedAt: now() })
  }).data
}

/** タイトル一覧の index 番目（0始まり）へ移す */
export function moveTitleTo(data: AppData, titleId: ID, index: number): AppData {
  return transact(data, (tx) => {
    const list = tx.all('titles').sort(byOrder)
    const from = list.findIndex((t) => t.id === titleId)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved)
    list.forEach((t, i) => {
      if (t.order !== i) tx.put('titles', { ...t, order: i })
    })
  }).data
}

export function moveTitleStep(data: AppData, titleId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => putAll(tx, 'titles', stepOrder(tx.all('titles'), titleId, dir))).data
}

/** タイトルと配下をすべて削除する。タイトルに紐づくアイデアは「どのタイトルにも属さない」へ移す */
export function deleteTitle(data: AppData, titleId: ID): AppData {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) return
    const belongs = (r: { titleId: ID | null }) => r.titleId === titleId
    for (const c of tx.all('chapters').filter(belongs)) tx.delete('chapters', c.id)
    for (const p of tx.all('pieces').filter(belongs)) tx.delete('pieces', p.id)
    for (const v of tx.all('versions').filter(belongs)) tx.delete('versions', v.id)
    for (const m of tx.all('memos').filter(belongs)) tx.delete('memos', m.id)
    for (const c of tx.all('settingCategories').filter(belongs)) tx.delete('settingCategories', c.id)
    for (const e of tx.all('settingEntries').filter(belongs)) tx.delete('settingEntries', e.id)
    for (const s of tx.all('submissions').filter(belongs)) tx.delete('submissions', s.id)
    let order = nextOrder(tx.all('ideas').filter((i) => i.titleId === null))
    for (const idea of tx.all('ideas').filter(belongs).sort(byOrder)) {
      tx.put('ideas', { ...idea, titleId: null, order: order++, updatedAt: now() })
    }
    tx.delete('titles', titleId)
  }).data
}

export interface TitleSummary {
  episodes: number
  specials: number
  /** 採用原稿がない話・特殊ブロックの合計 */
  missingActive: number
  /** 採用原稿がない第n話の数 */
  missingEpisodes: number
  /** 採用原稿がない特殊ブロックの数 */
  missingSpecials: number
  activeChars: number
}

export function titleSummary(data: AppData, titleId: ID): TitleSummary {
  const summary: TitleSummary = { episodes: 0, specials: 0, missingActive: 0, missingEpisodes: 0, missingSpecials: 0, activeChars: 0 }
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    if (p.kind === 'episode') summary.episodes += 1
    else summary.specials += 1
    const body = activeBody(data, p)
    if (body === null) {
      summary.missingActive += 1
      if (p.kind === 'episode') summary.missingEpisodes += 1
      else summary.missingSpecials += 1
    } else summary.activeChars += countChars(body)
  }
  return summary
}

/** 「採用原稿なし 2話＋特殊1」のような表記（話と特殊ブロックを分けて数える）。どちらも0なら空文字 */
export function missingActiveLabel(missingEpisodes: number, missingSpecials: number): string {
  if (missingEpisodes === 0 && missingSpecials === 0) return ''
  if (missingSpecials === 0) return `採用原稿なし ${missingEpisodes}話`
  if (missingEpisodes === 0) return `採用原稿なし 特殊${missingSpecials}`
  return `採用原稿なし ${missingEpisodes}話＋特殊${missingSpecials}`
}

/** タイトル配下のどれかが最後に編集された日時（原稿の編集も含む） */
export function titleLastEdited(data: AppData, titleId: ID): number {
  let latest = data.titles[titleId]?.updatedAt ?? 0
  const tables = ['chapters', 'pieces', 'versions', 'memos', 'settingCategories', 'settingEntries', 'submissions'] as const
  for (const table of tables) {
    for (const r of Object.values(data[table]) as { titleId: ID; updatedAt: number }[]) {
      if (r.titleId === titleId && r.updatedAt > latest) latest = r.updatedAt
    }
  }
  return latest
}

// ---------- アイデア ----------

export interface IdeaSection {
  /** null = どのタイトルにも属さない */
  titleId: ID | null
  name: string
  ideas: Idea[]
}

/** アイデア領域の仕切り。タイトルの数だけ仕切りがあり、最後に「どのタイトルにも属さない」 */
export function ideaSections(data: AppData): IdeaSection[] {
  const ideas = Object.values(data.ideas).sort(byOrder)
  const sections: IdeaSection[] = sortedTitles(data).map((t) => ({
    titleId: t.id,
    name: t.name,
    ideas: ideas.filter((i) => i.titleId === t.id),
  }))
  sections.push({
    titleId: null,
    name: 'どのタイトルにも属さない',
    ideas: ideas.filter((i) => i.titleId === null || !data.titles[i.titleId]),
  })
  return sections
}

export function addIdea(data: AppData, titleId: ID | null, heading = '', body = ''): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (titleId !== null && !tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const idea: Idea = {
      id: newId(),
      titleId,
      heading,
      body,
      order: nextOrder(tx.all('ideas').filter((i) => i.titleId === titleId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('ideas', idea)
    return idea.id
  })
}

export function updateIdea(data: AppData, ideaId: ID, patch: Partial<Pick<Idea, 'heading' | 'body'>>): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) throw new DomainError('アイデアが見つかりません')
    tx.put('ideas', { ...i, ...patch, updatedAt: now() })
  }).data
}

/** 別の仕切り（タイトル or どのタイトルにも属さない）へ移す。移動先の末尾に入る */
export function moveIdeaToSection(data: AppData, ideaId: ID, titleId: ID | null): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) throw new DomainError('アイデアが見つかりません')
    if (titleId !== null && !tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    if (i.titleId === titleId) return
    const order = nextOrder(tx.all('ideas').filter((x) => x.titleId === titleId))
    tx.put('ideas', { ...i, titleId, order, updatedAt: now() })
  }).data
}

/** アイデアを指定の仕切り（null = どのタイトルにも属さない）の index 番目（0始まり）へ移す */
export function moveIdeaTo(data: AppData, ideaId: ID, titleId: ID | null, index: number): AppData {
  return transact(data, (tx) => {
    const idea = tx.get('ideas', ideaId)
    if (!idea) throw new DomainError('アイデアが見つかりません')
    if (titleId !== null && !tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const list = tx
      .all('ideas')
      .filter((i) => i.titleId === titleId && i.id !== ideaId)
      .sort(byOrder)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, { ...idea, titleId })
    const ts = now()
    list.forEach((it, i) => {
      if (it.id === ideaId) {
        if (it.order !== i || idea.titleId !== titleId) tx.put('ideas', { ...it, order: i, updatedAt: ts })
      } else if (it.order !== i) tx.put('ideas', { ...it, order: i })
    })
  }).data
}

export function moveIdeaStep(data: AppData, ideaId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) return
    putAll(tx, 'ideas', stepOrder(tx.all('ideas').filter((x) => x.titleId === i.titleId), ideaId, dir))
  }).data
}

export function deleteIdea(data: AppData, ideaId: ID): AppData {
  return transact(data, (tx) => tx.delete('ideas', ideaId)).data
}

// ---------- メモ（付箋。タイトル内で常に一番下に表示） ----------

export function memosOf(data: AppData, titleId: ID): Memo[] {
  return Object.values(data.memos)
    .filter((m) => m.titleId === titleId)
    .sort(byOrder)
}

export function addMemo(data: AppData, titleId: ID, name = '新しいメモ'): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const memo: Memo = {
      id: newId(),
      titleId,
      name: name.trim() || '新しいメモ',
      body: '',
      order: nextOrder(tx.all('memos').filter((m) => m.titleId === titleId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('memos', memo)
    return memo.id
  })
}

export function updateMemo(data: AppData, memoId: ID, patch: Partial<Pick<Memo, 'name' | 'body'>>): AppData {
  return transact(data, (tx) => {
    const m = tx.get('memos', memoId)
    if (!m) throw new DomainError('メモが見つかりません')
    tx.put('memos', { ...m, ...patch, updatedAt: now() })
  }).data
}

export function moveMemoStep(data: AppData, memoId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const m = tx.get('memos', memoId)
    if (!m) return
    putAll(tx, 'memos', stepOrder(tx.all('memos').filter((x) => x.titleId === m.titleId), memoId, dir))
  }).data
}

export function deleteMemo(data: AppData, memoId: ID): AppData {
  return transact(data, (tx) => tx.delete('memos', memoId)).data
}

// ---------- 設定項目 ----------

export function categoriesOf(data: AppData, titleId: ID): SettingCategory[] {
  return Object.values(data.settingCategories)
    .filter((c) => c.titleId === titleId)
    .sort(byOrder)
}

export function entriesOf(data: AppData, categoryId: ID): SettingEntry[] {
  return Object.values(data.settingEntries)
    .filter((e) => e.categoryId === categoryId)
    .sort(byOrder)
}

export function addCategory(data: AppData, titleId: ID, name: string, fieldTemplate: string[] = []): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const cat: SettingCategory = {
      id: newId(),
      titleId,
      name: name.trim() || '新しい設定項目',
      fieldTemplate,
      order: nextOrder(tx.all('settingCategories').filter((c) => c.titleId === titleId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('settingCategories', cat)
    return cat.id
  })
}

export function updateCategory(
  data: AppData,
  categoryId: ID,
  patch: Partial<Pick<SettingCategory, 'name' | 'fieldTemplate'>>,
): AppData {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) throw new DomainError('設定項目が見つかりません')
    tx.put('settingCategories', { ...c, ...patch, updatedAt: now() })
  }).data
}

export function moveCategoryStep(data: AppData, categoryId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) return
    putAll(tx, 'settingCategories', stepOrder(tx.all('settingCategories').filter((x) => x.titleId === c.titleId), categoryId, dir))
  }).data
}

/** 設定項目と、その中のエントリをすべて削除する */
export function deleteCategory(data: AppData, categoryId: ID): AppData {
  return transact(data, (tx) => {
    for (const e of tx.all('settingEntries').filter((x) => x.categoryId === categoryId)) tx.delete('settingEntries', e.id)
    tx.delete('settingCategories', categoryId)
  }).data
}

export function addEntry(data: AppData, categoryId: ID, name = ''): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) throw new DomainError('設定項目が見つかりません')
    const ts = now()
    const entry: SettingEntry = {
      id: newId(),
      titleId: c.titleId,
      categoryId,
      name,
      fields: c.fieldTemplate.map((key): SettingField => ({ id: newId(), key, value: '' })),
      body: '',
      order: nextOrder(tx.all('settingEntries').filter((e) => e.categoryId === categoryId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('settingEntries', entry)
    return entry.id
  })
}

export function updateEntry(data: AppData, entryId: ID, patch: Partial<Pick<SettingEntry, 'name' | 'body' | 'fields'>>): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    if (!e) throw new DomainError('エントリが見つかりません')
    tx.put('settingEntries', { ...e, ...patch, updatedAt: now() })
  }).data
}

export function moveEntryStep(data: AppData, entryId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    if (!e) return
    putAll(tx, 'settingEntries', stepOrder(tx.all('settingEntries').filter((x) => x.categoryId === e.categoryId), entryId, dir))
  }).data
}

export function moveEntryToCategory(data: AppData, entryId: ID, categoryId: ID): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    const c = tx.get('settingCategories', categoryId)
    if (!e || !c) throw new DomainError('移動先が見つかりません')
    if (c.titleId !== e.titleId) throw new DomainError('別タイトルの設定項目には移動できません')
    if (e.categoryId === categoryId) return
    const order = nextOrder(tx.all('settingEntries').filter((x) => x.categoryId === categoryId))
    tx.put('settingEntries', { ...e, categoryId, order, updatedAt: now() })
  }).data
}

export function deleteEntry(data: AppData, entryId: ID): AppData {
  return transact(data, (tx) => tx.delete('settingEntries', entryId)).data
}

// ---------- 戦略（応募計画・結果・改稿/再応募方針） ----------

export const SUBMISSION_STATUSES: { value: Submission['status']; label: string }[] = [
  { value: 'considering', label: '検討中' },
  { value: 'planned', label: '応募予定' },
  { value: 'submitted', label: '応募済み' },
  { value: 'reviewing', label: '選考中' },
  { value: 'passed', label: '選考通過' },
  { value: 'won', label: '受賞' },
  { value: 'rejected', label: '落選' },
  { value: 'withdrawn', label: '取り下げ' },
]

export function submissionStatusLabel(status: Submission['status']): string {
  return SUBMISSION_STATUSES.find((s) => s.value === status)?.label ?? status
}

export function submissionsOf(data: AppData, titleId: ID): Submission[] {
  return Object.values(data.submissions)
    .filter((s) => s.titleId === titleId)
    .sort(byOrder)
}

export function addSubmission(data: AppData, titleId: ID, contestName = ''): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const s: Submission = {
      id: newId(),
      titleId,
      order: nextOrder(tx.all('submissions').filter((x) => x.titleId === titleId)),
      contestName,
      organizer: '',
      url: '',
      deadline: '',
      submittedOn: '',
      resultOn: '',
      status: 'considering',
      stage: '',
      overview: '',
      minChars: null,
      maxChars: null,
      limitUnit: 'chars',
      result: '',
      revisionPlan: '',
      resubmissionPlan: '',
      snapshot: null,
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('submissions', s)
    return s.id
  })
}

export type SubmissionPatch = Partial<Omit<Submission, 'id' | 'titleId' | 'order' | 'createdAt' | 'updatedAt'>>

export function updateSubmission(data: AppData, submissionId: ID, patch: SubmissionPatch): AppData {
  return transact(data, (tx) => {
    const s = tx.get('submissions', submissionId)
    if (!s) throw new DomainError('応募計画が見つかりません')
    tx.put('submissions', { ...s, ...patch, updatedAt: now() })
  }).data
}

export function moveSubmissionStep(data: AppData, submissionId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const s = tx.get('submissions', submissionId)
    if (!s) return
    putAll(tx, 'submissions', stepOrder(tx.all('submissions').filter((x) => x.titleId === s.titleId), submissionId, dir))
  }).data
}

export function deleteSubmission(data: AppData, submissionId: ID): AppData {
  return transact(data, (tx) => tx.delete('submissions', submissionId)).data
}

/** 本文の指紋（FNV-1a 32bit）。記録後に本文が変わったかの判定に使う */
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 現在の採用原稿の状態（どの話にどの稿を採用しているか・本文の控え・総文字数）を記録する */
export function takeSnapshot(data: AppData, titleId: ID): SubmissionSnapshot {
  const activeVersions: Record<ID, ID | null> = {}
  const pieces: Record<ID, SnapshotPiece> = {}
  const order: ID[] = []
  const numbers = episodeNumbers(data, titleId)
  let charCount = 0
  let pages = 0
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    const body = activeBody(data, p)
    const chars = body ? countChars(body) : 0
    activeVersions[p.id] = body === null ? null : p.activeVersionId
    order.push(p.id)
    pieces[p.id] = {
      kind: p.kind,
      label: pieceLabel(data, p, numbers),
      subtitle: p.subtitle,
      versionId: body === null ? null : p.activeVersionId,
      versionName: body === null ? null : (data.versions[p.activeVersionId!]?.name ?? null),
      chars,
      body,
      hash: textHash(body ?? ''),
    }
    charCount += chars
    if (body) pages += textStats(body).manuscriptPages
  }
  return { at: now(), charCount, activeVersions, pages, order, pieces }
}

export interface SnapshotDiff {
  /** 採用する稿が変わった話（追加・削除された話は added / removed に入る） */
  switched: ID[]
  /** 同じ稿のまま本文が変わった話 */
  edited: ID[]
  /** 記録時より後に追加された話 */
  added: ID[]
  /** 記録時にはあったが今はない話 */
  removed: ID[]
  charDelta: number
}

/** 記録した時点と今の採用原稿を比べる（本文の指紋で比べるので、稿の名前やメモの変更は数えない） */
export function compareSnapshotWithCurrent(data: AppData, titleId: ID, snapshot: SubmissionSnapshot): SnapshotDiff {
  const current = takeSnapshot(data, titleId)
  const diff: SnapshotDiff = { switched: [], edited: [], added: [], removed: [], charDelta: current.charCount - snapshot.charCount }
  const recordedIds = Object.keys(snapshot.activeVersions)
  for (const id of recordedIds) {
    if (!(id in current.activeVersions)) {
      diff.removed.push(id)
      continue
    }
    if (current.activeVersions[id] !== snapshot.activeVersions[id]) {
      diff.switched.push(id)
      continue
    }
    const before = snapshot.pieces?.[id]
    const now_ = current.pieces![id]
    if (before ? before.hash !== now_.hash : false) diff.edited.push(id)
  }
  for (const id of Object.keys(current.activeVersions)) if (!(id in snapshot.activeVersions)) diff.added.push(id)
  return diff
}

/** この稿を「応募時の原稿」として記録している応募先 */
export function submissionsReferencingVersion(data: AppData, versionId: ID): Submission[] {
  return Object.values(data.submissions)
    .filter((s) => s.snapshot && Object.values(s.snapshot.activeVersions).includes(versionId))
    .sort(byOrder)
}

/** 応募時に記録した原稿をテキストにする（記録に本文の控えがある場合のみ） */
export function snapshotText(snapshot: SubmissionSnapshot, titleName: string): string | null {
  if (!snapshot.pieces || !snapshot.order) return null
  const parts: string[] = [titleName, '']
  for (const id of snapshot.order) {
    const p = snapshot.pieces[id]
    if (!p) continue
    parts.push(p.subtitle.trim() ? `${p.label}　${p.subtitle.trim()}` : p.label, '')
    parts.push(p.body ?? '採用原稿がありません。', '', '')
  }
  return parts.join('\n').trimEnd() + '\n'
}

export function recordSubmissionSnapshot(data: AppData, submissionId: ID): AppData {
  const s = data.submissions[submissionId]
  if (!s) throw new DomainError('応募計画が見つかりません')
  return updateSubmission(data, submissionId, { snapshot: takeSnapshot(data, s.titleId) })
}
