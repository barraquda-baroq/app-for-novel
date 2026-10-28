// 幕（2.2 セパレート）の同期の規則（純粋関数）。persistence.ts の送信待ちの読み出し・クラウドからの反映が使う。
//
// 幕に分けた話（E）の幕の並び（actIds）・幕・稿は、別々のレコードでも1つのまとまりとして扱う:
// - 送る時: 幕の構成を変えた（分けた・さらに分けた・つないだ・解除した）話の送信待ちがあれば、その話と幕・稿・この操作の
//   ゴミ箱の件を1つのトランザクションで送る（groupOutbox。全部書けるか、1つも書かない）
// - 受け取った時: 両方の端末で同じ話の幕の構成が変わっていたら、項目ごとに合わせずに、どちらかの構成を丸ごと採る
//   （resolveActsPieces）。採らなかった側で作った稿は、残る幕・話の稿（競合の名前付き）かゴミ箱に残す
// 記号: B = base（最後にクラウドと揃えた時）、M = この端末、T = クラウド の actIds（無ければ []）。
import { contentEqual, mergeRemote, type Rec } from './merge'

type Loose = Record<string, unknown>

const asLoose = (r: unknown): Loose | null => (r && typeof r === 'object' ? (r as Loose) : null)

/** 話の幕の並び（無い・壊れていれば []） */
export function actIdsOf(r: unknown): string[] {
  const ids = asLoose(r)?.actIds
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

/** 幕のレコードか（古い版の端末が第n話として書いた幕も、属する話 parentId を持つ） */
export function isActRecord(r: unknown): boolean {
  const p = asLoose(r)
  if (!p) return false
  return p.kind === 'act' || (p.kind !== 'special' && typeof p.parentId === 'string')
}

/** 第n話のレコードか（幕・特殊ブロックでない） */
export function isEpisodeRecord(r: unknown): boolean {
  const p = asLoose(r)
  if (!p) return false
  return p.kind !== 'special' && p.kind !== 'act' && typeof p.parentId !== 'string'
}

/** 幕の属する話の id */
export function parentIdOf(r: unknown): string | null {
  const id = asLoose(r)?.parentId
  return typeof id === 'string' ? id : null
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** base で分けていた幕をすべて無くした（セパレート解除。解除してから分け直した時も） */
export function undoneActs(base: readonly string[], x: readonly string[]): boolean {
  return base.length > 0 && x.every((id) => !base.includes(id))
}

export type ActsVerdict = 'mine' | 'theirs'

/**
 * 両方の端末で幕の構成が変わっていた時に、どちらの構成を採るか。
 * この端末がセパレートを解除し（解除してから分け直した時も）、別の端末は解除していない時だけこの端末。
 * それ以外はクラウド（先に送った端末）。
 */
export function actsVerdict(B: readonly string[], M: readonly string[], T: readonly string[]): ActsVerdict {
  return undoneActs(B, M) && !undoneActs(B, T) ? 'mine' : 'theirs'
}

/** 送信待ちの1件（readOutbox が読んだもの） */
export interface GroupEntry {
  k: string
  table: string
  id: string
  base: Rec | null
  local: Rec | null
  noHistory: boolean
  force: boolean
}

/**
 * 幕の構成を変えた話の送信待ちか: 幕の並びが base と違う。共通の履歴が無い時（初めてのログイン）は、
 * この端末の話が幕に分けてあれば（クラウドの話と突き合わせるまで、幕だけを先に送らないように）
 */
export function isDirtyEpisodeRow(e: Pick<GroupEntry, 'base' | 'local' | 'noHistory' | 'force'>): boolean {
  if (e.force) return false
  const r = e.local ?? e.base
  if (!r || !isEpisodeRecord(r)) return false
  return !sameIds(actIdsOf(e.local), actIdsOf(e.base)) || (e.noHistory && actIdsOf(e.local).length > 0)
}

/**
 * 幕のまとまり（k → まとまりの名前 `pieces/${話の id}`）。幕の構成を変えた話ごとに、その話・幕（base とこの端末の幕の並び、
 * この話を指す幕）・それらの稿・まだ送っていないこの操作のゴミ箱の件（戻し先がこの話・幕のもの）と中身。
 */
export function groupOutbox(entries: readonly GroupEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  const pieces = entries.filter((e) => e.table === 'pieces')
  const dirty = pieces.filter(isDirtyEpisodeRow)
  if (!dirty.length) return out
  const versions = entries.filter((e) => e.table === 'versions')
  const trashEntries = entries.filter((e) => e.table === 'trashEntries')
  const trashRecords = entries.filter((e) => e.table === 'trashRecords')
  for (const row of dirty) {
    const ep = row.id
    const key = `pieces/${ep}`
    const assign = (k: string) => {
      if (!out.has(k)) out.set(k, key)
    }
    const set = new Set<string>([ep, ...actIdsOf(row.base), ...actIdsOf(row.local)])
    for (const p of pieces) {
      const r = p.local ?? p.base
      if (r && isActRecord(r) && parentIdOf(r) === ep) set.add(p.id)
    }
    for (const p of pieces) if (set.has(p.id)) assign(p.k)
    for (const v of versions) {
      const pieceId = asLoose(v.local ?? v.base)?.pieceId
      if (typeof pieceId === 'string' && set.has(pieceId)) assign(v.k)
    }
    const entryIds = new Set<string>()
    for (const t of trashEntries) {
      if (t.base !== null || !t.local) continue
      const origin = asLoose(asLoose(t.local)?.origin)
      if (!origin) continue
      if (origin.parentId === ep || (typeof origin.pieceId === 'string' && set.has(origin.pieceId))) {
        assign(t.k)
        entryIds.add(t.id)
      }
    }
    for (const r of trashRecords) {
      const entryId = asLoose(r.local ?? r.base)?.entryId
      if (typeof entryId === 'string' && entryIds.has(entryId)) assign(r.k)
    }
  }
  return out
}

/** 1つのレコードの3つの状態 */
export interface Tri {
  base: Rec | null
  local: Rec | null
  cloud: Rec | null
}

export interface ActsResolution {
  /** 合わせた後の話と幕（null = 消す） */
  pieces: Map<string, Rec | null>
  /** この端末では消えていて、合わせた後に残る幕（この端末の操作で消した幕が戻る） */
  resurrected: Set<string>
  /** この端末にあって、合わせた後に消える幕 */
  removed: Set<string>
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 両方の端末で幕の構成が変わっていた話を、1つのまとまりとして合わせる。
 * - 話: 項目ごとに合わせ（題など）、幕の並びと採用稿は採った側のもの。稿の番号は大きい方、稿の一覧は両方
 * - 幕: 採った側の幕の並びに載っている幕だけを、採った側の内容で残す（この端末で変えた幕の採用・稿の一覧も採った側に戻す）
 */
export function resolveActsPieces(input: {
  episodeId: string
  episode: Tri
  acts: ReadonlyMap<string, Tri>
  verdict: ActsVerdict
  noHistory: boolean
  device: string
}): ActsResolution {
  const { episode, verdict } = input
  const winner = asLoose(verdict === 'mine' ? episode.local : episode.cloud)
  const merged = mergeRemote('pieces', episode.base, episode.local, episode.cloud, {
    device: input.device,
    noHistory: input.noHistory,
  }).record
  const out: Loose = { ...(asLoose(merged) ?? winner ?? {}) }
  if (winner && Array.isArray(winner.actIds)) out.actIds = winner.actIds
  else delete out.actIds
  if (winner && 'activeVersionId' in winner) out.activeVersionId = winner.activeVersionId
  out.versionSeq = Math.max(num(asLoose(episode.local)?.versionSeq), num(asLoose(episode.cloud)?.versionSeq), 1)
  const finalEpisode = contentEqual(out as Rec, episode.cloud) ? episode.cloud : (out as Rec)
  const pieces = new Map<string, Rec | null>([[input.episodeId, finalEpisode]])
  const listed = actIdsOf(finalEpisode)
  const resurrected = new Set<string>()
  const removed = new Set<string>()
  for (const [id, t] of input.acts) {
    if (id === input.episodeId) continue
    const f = listed.includes(id) ? (verdict === 'mine' ? t.local : t.cloud) : null
    pieces.set(id, f)
    if (!t.local && f) resurrected.add(id)
    if (t.local && !f) removed.add(id)
  }
  return { pieces, resurrected, removed }
}

type PieceLike = { id: string; activeVersionId?: unknown; parentId?: unknown; actIds?: unknown }
type VersionLike = { id: string; pieceId?: unknown; body?: unknown; note?: unknown }

/** 話の採用原稿（分けていれば、載っている幕の採用稿をつないだもの） */
export function familyText(
  episode: PieceLike | null | undefined,
  getPiece: (id: string) => PieceLike | null | undefined,
  getVersion: (id: string) => VersionLike | null | undefined,
): string {
  if (!episode) return ''
  const ids = actIdsOf(episode)
  const bodyOf = (p: PieceLike) => {
    const v = typeof p.activeVersionId === 'string' ? getVersion(p.activeVersionId) : null
    return v && v.pieceId === p.id && typeof v.body === 'string' ? v.body : ''
  }
  if (!ids.length) return bodyOf(episode)
  return ids
    .map((id) => {
      const act = getPiece(id)
      return act && act.parentId === episode.id ? bodyOf(act) : ''
    })
    .join('')
}

/**
 * 控える稿の残し先（話・幕）と、その稿が何幕目の稿だったか。
 * - 話が分けていなければ話
 * - 稿の幕が残っていればその幕
 * - 稿の幕が載っていた並び（反映する前のこの端末・base・クラウドの順に探す）で、左隣の残っている幕、なければ右隣
 * - この端末で作った幕なら、同じ位置の残っている幕（範囲に収める）
 * - それも無ければ最初の幕
 */
export function chooseTarget(input: {
  episodeId: string
  /** 合わせた後に残る幕（読む順。分けていなければ空） */
  live: readonly string[]
  orders: readonly (readonly string[])[]
  pieceId: string
  createdHere: boolean
}): { targetId: string; actNumber: number | null } {
  const list = input.orders.find((o) => o.includes(input.pieceId))
  const idx = list ? list.indexOf(input.pieceId) : -1
  const actNumber = idx >= 0 ? idx + 1 : null
  const { live } = input
  if (!live.length) return { targetId: input.episodeId, actNumber }
  if (live.includes(input.pieceId)) return { targetId: input.pieceId, actNumber }
  if (list) {
    for (let i = idx - 1; i >= 0; i--) if (live.includes(list[i])) return { targetId: list[i], actNumber }
    for (let i = idx + 1; i < list.length; i++) if (live.includes(list[i])) return { targetId: list[i], actNumber }
  }
  if (input.createdHere && idx >= 0) return { targetId: live[Math.min(idx, live.length - 1)], actNumber }
  return { targetId: live[0], actNumber }
}

/** 控えるまでもない稿: 本文が空か採用原稿にそのまま入っていて、推敲メモが空（ゴミ箱にだけ残す） */
export function isRedundant(v: VersionLike, text: string): boolean {
  const body = typeof v.body === 'string' ? v.body : ''
  const note = typeof v.note === 'string' ? v.note : ''
  return (body === '' || text.includes(body)) && note.trim() === ''
}
