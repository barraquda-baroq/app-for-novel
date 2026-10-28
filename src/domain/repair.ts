// 読み込んだデータの整合性を直す。壊れたバックアップや、別タブとの競合で参照が切れたデータでも
// 画面が落ちないよう、起動時とバックアップ復元時に通す。直せないものは安全側（削除・未分類）に倒す。
import type { AppData, Chapter, ID, NodeRef, Piece, Title } from './types'

export interface RepairResult {
  data: AppData
  /** 直した箇所の説明（空なら変更なし） */
  fixes: string[]
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

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
  }
  const fix = (msg: string) => fixes.push(msg)

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
    if (JSON.stringify(next) !== JSON.stringify(t)) {
      d.titles[t.id] = next
      fix(`タイトル「${next.name}」の項目を補いました`)
    }
  }

  // タイトルのないレコードを消す
  const dropOrphans = <T extends 'chapters' | 'pieces' | 'memos' | 'settingCategories' | 'submissions'>(table: T, label: string) => {
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

  for (const e of Object.values(d.settingEntries)) {
    const cat = d.settingCategories[e.categoryId]
    if (!cat || !d.titles[e.titleId] || cat.titleId !== e.titleId) {
      delete d.settingEntries[e.id]
      fix('設定項目のないエントリを削除しました')
    } else if (!Array.isArray(e.fields)) {
      d.settingEntries[e.id] = { ...e, fields: [] }
      fix('設定エントリのフィールドを補いました')
    }
  }
  for (const c of Object.values(d.settingCategories)) {
    if (!Array.isArray(c.fieldTemplate)) {
      d.settingCategories[c.id] = { ...c, fieldTemplate: [] }
      fix('設定項目のテンプレートを補いました')
    }
  }

  // 推敲バージョン: 話のないものを消す
  for (const v of Object.values(d.versions)) {
    if (!d.pieces[v.pieceId]) {
      delete d.versions[v.id]
      fix('話のない推敲バージョンを削除しました')
    } else if (typeof v.body !== 'string') {
      d.versions[v.id] = { ...v, body: '' }
      fix('推敲バージョンの本文を補いました')
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
    const listed = (Array.isArray(p.versionIds) ? p.versionIds : []).filter((id, i, arr) => owned.includes(id) && arr.indexOf(id) === i)
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
    }
    if (JSON.stringify(next) !== JSON.stringify(p)) {
      d.pieces[p.id] = next
      fix('話の推敲バージョン一覧を直しました')
    }
  }

  // 本編の構成: 存在しない参照・重複参照を除き、どこにも入っていない話はタイトル直下の末尾へ
  const placed = new Set<ID>()
  const chapterSeen = new Set<ID>()
  for (const t of Object.values(d.titles)) {
    const structure: NodeRef[] = []
    for (const node of t.structure) {
      if (!node || typeof node !== 'object') continue
      if (node.type === 'chapter') {
        const ch = d.chapters[node.id]
        if (!ch || ch.titleId !== t.id || chapterSeen.has(ch.id)) continue
        chapterSeen.add(ch.id)
        const pieceIds = (Array.isArray(ch.pieceIds) ? ch.pieceIds : []).filter((pid) => {
          const p = d.pieces[pid]
          if (!p || p.titleId !== t.id || placed.has(pid)) return false
          placed.add(pid)
          return true
        })
        if (pieceIds.length !== (ch.pieceIds?.length ?? -1)) {
          d.chapters[ch.id] = { ...ch, pieceIds } as Chapter
          fix(`章「${ch.name}」の話の一覧を直しました`)
        }
        structure.push({ type: 'chapter', id: ch.id })
      } else if (node.type === 'piece') {
        const p = d.pieces[node.id]
        if (!p || p.titleId !== t.id || placed.has(p.id)) continue
        placed.add(p.id)
        structure.push({ type: 'piece', id: p.id })
      }
    }
    // 構成に載っていない章（中身ごと）と話を末尾に戻す
    for (const ch of Object.values(d.chapters)) {
      if (ch.titleId !== t.id || chapterSeen.has(ch.id)) continue
      chapterSeen.add(ch.id)
      const pieceIds = (Array.isArray(ch.pieceIds) ? ch.pieceIds : []).filter((pid) => {
        const p = d.pieces[pid]
        if (!p || p.titleId !== t.id || placed.has(pid)) return false
        placed.add(pid)
        return true
      })
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
    if (JSON.stringify(structure) !== JSON.stringify(t.structure)) {
      d.titles[t.id] = { ...d.titles[t.id], structure }
    }
  }

  // アイデア: 存在しないタイトルを指すものは「どのタイトルにも属さない」へ
  let unassignedOrder = Object.values(d.ideas)
    .filter((i) => i.titleId === null)
    .reduce((m, i) => Math.max(m, num(i.order)), -1)
  for (const idea of Object.values(d.ideas).sort((a, b) => num(a.order) - num(b.order))) {
    if (idea.titleId !== null && !d.titles[idea.titleId]) {
      unassignedOrder += 1
      d.ideas[idea.id] = { ...idea, titleId: null, order: unassignedOrder }
      fix('タイトルのないアイデアを「どのタイトルにも属さない」へ移しました')
    } else if (typeof idea.heading !== 'string' || typeof idea.body !== 'string') {
      d.ideas[idea.id] = { ...idea, heading: str(idea.heading), body: str(idea.body) }
      fix('アイデアの項目を補いました')
    }
  }

  return { data: fixes.length ? d : input, fixes }
}
