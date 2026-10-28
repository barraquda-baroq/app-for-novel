// 同期の競合で、どちらの文章も消さないための控えを作る。
// - 稿の本文が両方の端末で変わっていた → この端末の本文を「（競合: ○○での編集）」の別の稿として残す
// - 片方で削除・片方で編集されていた → 削除を優先し、編集された内容をゴミ箱に残す（reason: 'conflict'。
//   戻し方は src/domain/trash.ts。同じ id が残っていれば新しい id の複製として戻る）
import { actLabel, pieceFullLabel } from '../domain/structure'
import { trashLabel } from '../domain/trash'
import type {
  AppData,
  ContentTableName,
  CritiquePrompt,
  CritiqueResult,
  ID,
  Idea,
  Memo,
  Piece,
  RevisionIdea,
  SettingEntry,
  StrategyNote,
  Submission,
  TrashEntry,
  TrashKind,
  TrashOrigin,
  TrashRecord,
  Title,
  Version,
} from '../domain/types'
import type { AnyRecord, Change, ConflictHooks, ConflictNote } from '../db/persistence'
import type { Rec } from './merge'

/** 端末の呼び名（競合の控えの名前に使う） */
export function deviceLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  // 名前は同期されてほかの端末でも見えるので、「この端末」とは書かない
  return 'ブラウザ'
}

export function conflictVersionName(name: string, device: string): string {
  return `${name || '無題の稿'}（競合: ${device}での編集）`
}

/** 本文が競合した稿の控え（新しい id の稿。話の稿一覧の末尾に足す） */
export function conflictVersionCopy(mine: Version, device: string, id: ID, now: number): Version {
  // 分けた・つないだ時の元の本文の指紋は、控えには引き継がない（控えは分けた・つないだ稿ではない）
  const { sourceHash: _hash, ...rest } = mine
  void _hash
  return {
    ...rest,
    id,
    name: conflictVersionName(mine.name, device),
    sourceVersionId: mine.id,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * ゴミ箱に入れた話の表記（削除した時の「第n話　題」。見つからなければ null）。削除した話は構成から外れているので、
 * 話の番号はゴミ箱の件の名前にだけ残っている
 */
export function trashedPieceLabel(data: AppData, pieceId: ID): string | null {
  for (const e of Object.values(data.trashEntries)) {
    if (e.kind !== 'piece') continue
    const first = e.recordIds[0] ? data.trashRecords[e.recordIds[0]] : undefined
    if (first?.table === 'pieces' && first.record.id === pieceId) return e.label
  }
  return null
}

/** 話の表記（話があればいまの番号、ゴミ箱に入れた話ならその件の名前。見つからなければ null） */
function episodeLabel(data: AppData, pieceId: ID): string | null {
  const p = data.pieces[pieceId]
  return p ? pieceFullLabel(data, p) : trashedPieceLabel(data, pieceId)
}

/** 幕のレコードか（古い版の端末が第n話として書いた幕も、属する話 parentId を持つ） */
const isActPiece = (p: Pick<Piece, 'kind' | 'parentId'> | undefined): p is Piece =>
  Boolean(p) && (p!.kind === 'act' || (p!.kind !== 'special' && typeof p!.parentId === 'string'))

/**
 * 幕の構成の競合で残す稿の名前。「第2幕の第1稿（競合: iPhoneでの編集）」「第2稿（つないだ稿）（競合: 別の端末での幕の操作）」。
 * actNumber は、稿を別の幕・話へ移して残す時だけ渡す（元の幕が分かるように）。mine = この端末で書いた・作った稿
 */
export function actsVersionName(
  name: string,
  opts: { device: string; mine: boolean; reason: 'edit' | 'acts'; actNumber: number | null },
): string {
  const prefix = opts.actNumber ? `${actLabel(opts.actNumber)}の` : ''
  const who = opts.mine ? opts.device : '別の端末'
  return `${prefix}${name.trim() || '無題の稿'}（競合: ${who}での${opts.reason === 'edit' ? '編集' : '幕の操作'}）`
}

/**
 * 幕の構成の競合で残す稿。残し先（target）が稿の幕そのものなら同じ id のまま名前だけ変え、
 * 別の幕・話へ移す時は新しい id の写しにする（採用はしない。呼び出し側が稿の一覧の末尾に足す）
 */
export function actsVersionCopy(v: Version, target: Pick<Piece, 'id' | 'titleId'>, name: string, id: ID, now: number): Version {
  const { sourceHash: _hash, ...rest } = v
  void _hash
  if (id === v.id && target.id === v.pieceId) return { ...rest, name, updatedAt: now }
  return {
    ...rest,
    id,
    pieceId: target.id,
    titleId: target.titleId,
    name,
    sourceVersionId: v.id,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 幕の構成の競合で、採用原稿に入っている（控えるまでもない）稿や、削除された話の幕の稿を、ゴミ箱の1件にまとめる。
 * 戻すと、稿の幕（残っていれば）・残し先（target）・話（origin.parentId）の稿として戻る（採用はしない）。
 */
export function actsConflictTrash(
  data: AppData,
  items: readonly { record: Version; actNumber: number | null }[],
  info: { episodeId: ID; episode: Piece | null; target: Pick<Piece, 'id'> | null; deleted: boolean },
  opts: { now: number; newId: () => ID },
): { entry: TrashEntry; records: TrashRecord[] } {
  const known = data.pieces[info.episodeId]
  const episode = known ?? info.episode
  const titleId = episode?.titleId ?? items[0]?.record.titleId ?? null
  const entryId = opts.newId()
  const records: TrashRecord[] = items.map(({ record, actNumber }) => ({
    id: opts.newId(),
    entryId,
    table: 'versions',
    record: actNumber ? { ...record, name: `${actLabel(actNumber)}の${record.name.trim() || '無題の稿'}` } : record,
    createdAt: opts.now,
    updatedAt: opts.now,
  }))
  const n = records.length
  // 話がこの端末で削除されていれば、その話のゴミ箱の件の名前（第n話）
  const parentLabel = episodeLabel(data, info.episodeId)
  const entry: TrashEntry = {
    id: entryId,
    kind: 'version',
    label: info.deleted ? `削除された話の幕の稿（${n}稿）` : `幕の分け方の競合で残した稿（${n}稿）`,
    titleName: titleId ? (data.titles[titleId]?.name ?? '') : '',
    ...(parentLabel ? { parentLabel } : {}),
    origin: {
      titleId,
      pieceId: info.target?.id ?? info.episodeId,
      parentId: info.episodeId,
      index: -1,
      wasActive: false,
    },
    recordIds: records.map((r) => r.id),
    reason: 'conflict',
    deletedAt: opts.now,
    createdAt: opts.now,
    updatedAt: opts.now,
  }
  return { entry, records }
}

const KIND_OF: Partial<Record<ContentTableName, TrashKind>> = {
  titles: 'title',
  versions: 'version',
  memos: 'memo',
  ideas: 'idea',
  settingEntries: 'settingEntry',
  submissions: 'submission',
  // 2.3（文章を持つもの。推敲案は控えない）
  revisionIdeas: 'revisionIdea',
  strategyNotes: 'strategyNote',
  critiquePrompts: 'critiquePrompt',
  critiqueResults: 'critiqueResult',
}

/**
 * 片方の端末で削除され、もう片方で編集されていたレコードの控えをゴミ箱の1件にする。
 * 文章を持たない表（タイトル・章・話など）は控えない（null）。
 */
export function conflictTrash(
  data: AppData,
  table: ContentTableName,
  record: Rec,
  opts: {
    now: number
    newId: () => ID
    /** 稿の話・幕（data に無い時。同期で消えた幕など）。幕なら、戻せるように属する話も控える */
    piece?: Piece | null
  },
): { entry: TrashEntry; records: TrashRecord[] } | null {
  const kind = KIND_OF[table]
  if (!kind) return null
  let label = ''
  let parentLabel = ''
  let titleId: ID | null = null
  const origin: TrashOrigin = { titleId: null, index: 0 }
  /** 一緒に控えるレコード（応募計画の応募時の原稿の本文） */
  const extras: { table: ContentTableName; record: Rec }[] = []
  if (table === 'titles') {
    const t = record as unknown as Title
    label = t.name || '無題のタイトル'
    origin.index = t.order
  } else if (table === 'versions') {
    const v = record as unknown as Version
    const known = data.pieces[v.pieceId]
    const piece = known ?? opts.piece ?? undefined
    titleId = v.titleId ?? piece?.titleId ?? null
    label = v.name || '無題の稿'
    origin.pieceId = v.pieceId
    // 幕の稿は、幕の属する話も控える（幕がつないだ・解除したことで無くなっていても、話・残った幕へ戻せるように）
    const parent = isActPiece(piece) && typeof piece.parentId === 'string' ? piece.parentId : null
    if (parent) origin.parentId = parent
    if (known) {
      parentLabel = pieceFullLabel(data, known)
      origin.index = known.versionIds.length
      origin.prevId = known.versionIds[known.versionIds.length - 1] ?? null
    } else if (piece) {
      // 稿の幕がもう無い: 戻す時は戻し先の末尾へ
      const episode = parent ? episodeLabel(data, parent) : null
      parentLabel = episode ? `${episode}の幕` : ''
      origin.index = -1
    } else {
      origin.index = 0
      origin.prevId = null
    }
    origin.wasActive = false
  } else if (table === 'memos') {
    const m = record as unknown as Memo
    titleId = m.titleId
    label = m.name
    origin.index = m.order
  } else if (table === 'ideas') {
    const i = record as unknown as Idea
    titleId = i.titleId
    label = i.heading || i.body.split('\n')[0]?.slice(0, 40) || 'アイデア'
    origin.index = i.order
  } else if (table === 'settingEntries') {
    const e = record as unknown as SettingEntry
    titleId = e.titleId
    label = e.name || '設定のエントリ'
    parentLabel = data.settingCategories[e.categoryId]?.name ?? ''
    origin.categoryId = e.categoryId
    origin.index = e.order
  } else if (table === 'submissions') {
    const s = record as unknown as Submission
    titleId = s.titleId
    label = s.contestName || '応募計画'
    origin.index = s.order
    // 応募時の原稿の本文は別の表にあるので、一緒に控える（後で使われなくなって消えても戻せるように）
    const keys = new Set<ID>()
    for (const p of Object.values(s.snapshot?.pieces ?? {})) if (p.textKey) keys.add(p.textKey)
    for (const key of keys) {
      const text = data.snapshotTexts[key]
      if (text) extras.push({ table: 'snapshotTexts', record: text as unknown as Rec })
    }
  } else if (table === 'revisionIdeas') {
    const r = record as unknown as RevisionIdea
    titleId = r.titleId
    label = trashLabel.revisionIdea(r)
    origin.index = r.order
  } else if (table === 'strategyNotes') {
    const n = record as unknown as StrategyNote
    titleId = n.titleId
    label = trashLabel.strategyNote(n)
    origin.index = -1
  } else if (table === 'critiquePrompts') {
    const p = record as unknown as CritiquePrompt
    titleId = p.titleId
    label = trashLabel.critiquePrompt(p)
    origin.index = p.order
  } else if (table === 'critiqueResults') {
    const r = record as unknown as CritiqueResult
    titleId = r.titleId
    label = trashLabel.critiqueResult(r)
    origin.index = -1
  }
  origin.titleId = table === 'titles' ? null : titleId
  const entryId = opts.newId()
  const records: TrashRecord[] = [{ table, record }, ...extras].map((r) => ({
    id: opts.newId(),
    entryId,
    table: r.table,
    record: r.record as unknown as TrashRecord['record'],
    createdAt: opts.now,
    updatedAt: opts.now,
  }))
  const entry: TrashEntry = {
    id: entryId,
    kind,
    label: label || '（名前なし）',
    titleName: titleId ? (data.titles[titleId]?.name ?? '') : '',
    ...(parentLabel ? { parentLabel } : {}),
    origin,
    recordIds: records.map((r) => r.id),
    reason: 'conflict',
    deletedAt: opts.now,
    createdAt: opts.now,
    updatedAt: opts.now,
  }
  return { entry, records }
}

/** ゴミ箱の1件（件と中身）を、端末内に書く変化にする */
export function trashChanges(r: { entry: TrashEntry; records: TrashRecord[] }): Change[] {
  return [
    { table: 'trashEntries', id: r.entry.id, record: r.entry as unknown as AnyRecord },
    ...r.records.map((tr) => ({ table: 'trashRecords' as const, id: tr.id, record: tr as unknown as AnyRecord })),
  ]
}

/**
 * 同期の競合の控え方（ストア・テストで使う）。data は控えの表記（話の番号・名前）に使う、反映する前の表示用の内容。
 * report で集めた知らせは、保存・反映が終わってからまとめて出す。
 */
export function createConflictHooks(opts: {
  device: string
  data: () => AppData
  report?: (note: ConflictNote) => void
  now?: () => number
  newId: () => ID
}): ConflictHooks {
  const now = opts.now ?? (() => Date.now())
  return {
    device: opts.device,
    versionCopy: (mine) =>
      conflictVersionCopy(mine as unknown as Version, opts.device, opts.newId(), now()) as unknown as AnyRecord,
    trashCopy: (table, record, ctx) => {
      const r = conflictTrash(opts.data(), table as ContentTableName, record, {
        now: now(),
        newId: opts.newId,
        piece: (ctx?.piece ?? null) as Piece | null,
      })
      return r ? trashChanges(r) : []
    },
    actsCopy: (version, target, info) => {
      const v = version as unknown as Version
      const moved = target.id !== v.pieceId
      const name = actsVersionName(v.name, {
        device: opts.device,
        mine: info.mine,
        reason: info.reason,
        actNumber: moved ? info.actNumber : null,
      })
      return actsVersionCopy(v, target as unknown as Piece, name, moved ? opts.newId() : v.id, now()) as unknown as AnyRecord
    },
    actsTrash: (items, info) =>
      trashChanges(
        actsConflictTrash(
          opts.data(),
          items.map((x) => ({ record: x.record as unknown as Version, actNumber: x.actNumber })),
          {
            episodeId: info.episodeId,
            episode: info.episode as unknown as Piece | null,
            target: info.target,
            deleted: info.deleted,
          },
          { now: now(), newId: opts.newId },
        ),
      ),
    report: opts.report,
  }
}
