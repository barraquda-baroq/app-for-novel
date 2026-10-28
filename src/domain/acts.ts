// セパレート（幕）: 採用した第n話を WEB 掲載用に「第n話　題　第x幕」へ分ける。話数は増やさない。
// - 分けると、話の採用稿を分割点で区切った本文が各幕の「第1稿」（採用中）になる。区切るだけで本文は1字も変えない
//   （各幕の本文を順につなぐと元の本文に戻る。区切りの記号も足さない）
// - 分けている間、話の本文は各幕の採用稿をつないだもの（structure.ts の adoptedText）。話自身の稿・採用は
//   セパレートを解除するまで変えられない（storyOps.ts）
// - 幕はさらに分けたり、次の幕とつないだりできる。幕の番号（第x幕）は保存せず、話の actIds の中の位置から導出する
// - セパレート解除はすべての幕に採用稿がある時だけ。各幕の採用稿をつないだ本文を、話の新しい稿として採用する
// 消える幕の採用していなかった稿はゴミ箱へ1件にまとめて移す（戻すと、つないだ先の幕・話の稿として戻る）。
// 消える幕の採用稿の推敲メモは、稿の名前とともに新しい稿の推敲メモに引き継ぐ。
// 消える幕を戻し先にしていたゴミ箱の稿（前につないだ時・稿を削除した時のもの）は、残る幕・話へ付け替える。
// すべて純粋関数で、新しい AppData を返す。仕様違反は DomainError を投げる。
import { makeVersion } from './storyOps'
import { activeVersion, actLabel, actParts, actsOf, isSplit, parentOf, pieceFullLabel, type ActPart } from './structure'
import { putInTrash } from './trash'
import { Tx, transact } from './tx'
import { DomainError, type AppData, type ID, type Piece, type TrashOrigin, type Version } from './types'
import { newId, now } from './util'

/** さらに分けた幕の、最初の区切りの本文を入れる稿の名前に付ける */
export const SPLIT_VERSION_SUFFIX = '（分割）'
/** 次の幕とつないだ稿の名前に付ける */
export const JOINED_VERSION_SUFFIX = '（つないだ稿）'
/** セパレートを解除した時に、話の新しい稿の名前に付ける */
export const UNSEPARATED_VERSION_SUFFIX = '（幕をつないだ稿）'

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * 本文の offset（文字コード単位の位置）で区切れるか。区切れなければ短い理由を返す。
 * 先頭・末尾・既に区切った位置（others）・サロゲートペア（𠮷 など）の途中・改行（CRLF）の途中は区切れない。
 */
export function splitPointError(body: string, offset: number, others: readonly number[] = []): string | null {
  if (!Number.isInteger(offset)) return '区切る位置が正しくありません'
  if (offset <= 0) return '先頭では区切れません'
  if (offset >= body.length) return '末尾では区切れません'
  if (others.includes(offset)) return 'そこはもう区切ってあります'
  const before = body.charCodeAt(offset - 1)
  const after = body.charCodeAt(offset)
  if (isHigh(before) && isLow(after)) return '文字の途中では区切れません'
  if (before === 0x0d && after === 0x0a) return '改行の途中では区切れません'
  return null
}

/**
 * 分割点で区切った本文（分割点は小さい順に並べ替える）。つなぐと body に戻る（1字も足さない・削らない）。
 * 区切れない位置があれば DomainError。
 */
export function splitSegments(body: string, offsets: readonly number[]): string[] {
  if (offsets.length === 0) throw new DomainError('区切る位置を1つ以上選んでください')
  const sorted = [...offsets].sort((a, b) => a - b)
  sorted.forEach((o, i) => {
    const err = splitPointError(body, o, sorted.slice(0, i))
    if (err) throw new DomainError(err)
  })
  const out: string[] = []
  let prev = 0
  for (const o of sorted) {
    out.push(body.slice(prev, o))
    prev = o
  }
  out.push(body.slice(prev))
  return out
}

/**
 * 区切った本文の数と同じ幕を作る（各幕の第1稿が採用中。本文はその区切り）。
 * 作った時刻は読む順（order）に1ずつずらす（同期の途中で、話の幕の並びより先に幕が届いても、
 * 修復（repair.ts）が作られた順＝読む順に並べられるように）
 */
function newAct(episode: Piece, body: string, ts: number, order = 0): { act: Piece; version: Version } {
  const base: Piece = {
    id: newId(),
    titleId: episode.titleId,
    kind: 'act',
    label: '',
    subtitle: '',
    parentId: episode.id,
    activeVersionId: null,
    versionIds: [],
    versionSeq: 1,
    createdAt: ts + order,
    updatedAt: ts,
  }
  const version = { ...makeVersion(base, 1, body), createdAt: ts, updatedAt: ts }
  return { act: { ...base, activeVersionId: version.id, versionIds: [version.id] }, version }
}

function requirePiece(tx: Tx, pieceId: ID): Piece {
  const p = tx.get('pieces', pieceId)
  if (!p) throw new DomainError('話が見つかりません')
  return p
}

/** この話の稿として採用中の稿（参照切れ・別の話の稿なら null） */
function adoptedOf(tx: Tx, piece: Piece): Version | null {
  const v = activeVersion(tx.data, piece)
  return v && v.pieceId === piece.id ? v : null
}

/** 幕と、その属する話（幕でない・話が見つからなければ DomainError） */
function requireAct(tx: Tx, actId: ID): { act: Piece; parent: Piece; acts: Piece[]; index: number } {
  const act = requirePiece(tx, actId)
  if (act.kind !== 'act') throw new DomainError('幕ではありません')
  const parent = parentOf(tx.data, act)
  const acts = parent ? actsOf(tx.data, parent) : []
  const index = acts.findIndex((a) => a.id === act.id)
  if (!parent || index < 0) throw new DomainError('幕の属する話が見つかりません')
  return { act, parent, acts, index }
}

/** 稿の一覧（versionIds の順。載っていない稿も後ろに付ける） */
function versionsOf(tx: Tx, piece: Piece): Version[] {
  const listed = piece.versionIds.map((id) => tx.get('versions', id)).filter((v): v is Version => Boolean(v))
  const extra = tx.all('versions').filter((v) => v.pieceId === piece.id && !piece.versionIds.includes(v.id))
  return [...listed, ...extra]
}

/** ゴミ箱に入れる、消える幕の採用していなかった稿（戻した時に、どの幕の稿だったか分かる名前にする） */
function leftoverVersions(tx: Tx, act: Piece, number: number): Version[] {
  const adopted = act.activeVersionId
  return versionsOf(tx, act)
    .filter((v) => v.id !== adopted)
    .map((v) => ({ ...v, name: `${actLabel(number)}の${v.name.trim() || '無題の稿'}` }))
}

/** 消える幕の採用稿の推敲メモを、稿の名前つきで新しい稿の推敲メモに引き継ぐ（空のメモは飛ばす） */
function carriedNote(parts: readonly { number: number; version: Version }[]): string {
  return parts
    .filter((x) => x.version.note.trim() !== '')
    .map((x) => `【${actLabel(x.number)}　${x.version.name.trim() || '無題の稿'}】\n${x.version.note}`)
    .join('\n\n')
}

/**
 * 消える幕（removedId）を戻し先にしていたゴミ箱の稿（前につないだ時の残り・幕から削除した稿）を、残る幕・話（into）へ付け替える。
 * 末尾に、採用せずに戻す（戻した稿が、つないだ本文の採用稿を入れ替えないように）
 */
function retargetTrash(tx: Tx, removedId: ID, into: Piece): void {
  const ts = now()
  for (const e of tx.all('trashEntries')) {
    if (e.kind !== 'version' || e.origin?.pieceId !== removedId) continue
    // 位置は分からない（-1）ことにして直前の要素も外す（末尾に戻る）。null の直前は「先頭」の意味なので入れない
    const origin: TrashOrigin = { ...e.origin, titleId: into.titleId, pieceId: into.id, index: -1, wasActive: false }
    delete origin.prevId
    tx.put('trashEntries', { ...e, origin, updatedAt: ts })
  }
}

/** 幕と、その採用稿を消す（採用稿の本文は、つないだ稿に入っている） */
function removeAct(tx: Tx, act: Piece): void {
  for (const v of versionsOf(tx, act)) tx.delete('versions', v.id)
  tx.delete('pieces', act.id)
}

/**
 * 幕に分ける（セパレート）。offsets は採用稿の本文の中の区切る位置（文字コード単位）。
 * - 第n話: 採用稿の本文を区切り、区切りごとの幕（第1稿が採用中）を作る。話自身の稿はそのまま残る（解除するまで変えられない）
 * - 幕（さらに分ける）: その幕に最初の区切りの本文の新しい稿「第n稿（分割）」を作って採用し、残りの区切りの幕をすぐ後ろに入れる
 * 戻り値は分けた後の幕の id（読む順。さらに分けた時は元の幕から）。
 */
export function separatePiece(data: AppData, pieceId: ID, offsets: readonly number[]): { data: AppData; result: ID[] } {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    if (p.kind === 'special') throw new DomainError('特殊ブロックは幕に分けられません')
    if (isSplit(p)) throw new DomainError('この話はもう幕に分けてあります。幕の画面の「さらに分ける」で分けてください')
    const v = adoptedOf(tx, p)
    if (!v) {
      throw new DomainError(
        p.kind === 'act'
          ? '採用稿のない幕は分けられません。先に稿を採用してください'
          : '採用原稿のない話は幕に分けられません。先に稿を採用してください',
      )
    }
    const segments = splitSegments(v.body, offsets)
    const ts = now()

    if (p.kind === 'episode') {
      const made = segments.map((seg, i) => newAct(p, seg, ts, i))
      for (const m of made) {
        tx.put('pieces', m.act)
        tx.put('versions', m.version)
      }
      tx.put('pieces', { ...p, actIds: made.map((m) => m.act.id), updatedAt: ts })
      return made.map((m) => m.act.id)
    }

    // 幕をさらに分ける
    const { parent, acts, index } = requireAct(tx, p.id)
    const seq = p.versionSeq + 1
    const first: Version = {
      ...makeVersion(p, seq, segments[0], v.id, `第${seq}稿${SPLIT_VERSION_SUFFIX}`),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('versions', first)
    tx.put('pieces', { ...p, versionIds: [...p.versionIds, first.id], activeVersionId: first.id, versionSeq: seq, updatedAt: ts })
    const made = segments.slice(1).map((seg, i) => newAct(parent, seg, ts, i))
    for (const m of made) {
      tx.put('pieces', m.act)
      tx.put('versions', m.version)
    }
    const ids = acts.map((a) => a.id)
    ids.splice(index + 1, 0, ...made.map((m) => m.act.id))
    tx.put('pieces', { ...parent, actIds: ids, updatedAt: ts })
    return [p.id, ...made.map((m) => m.act.id)]
  })
}

/** 「第2幕・第4幕」 */
function actNames(parts: readonly Pick<ActPart, 'number'>[]): string {
  return parts.map((p) => actLabel(p.number)).join('・')
}

/** この話の稿を採用している幕か */
const hasAdopted = (x: ActPart) => x.version !== null && x.version.pieceId === x.act.id

/** 次の幕とつなげるか（つなげなければ理由） */
export function joinError(data: AppData, actId: ID): string | null {
  const act = data.pieces[actId]
  if (!act || act.kind !== 'act') return '幕ではありません'
  const parent = parentOf(data, act)
  const parts = parent ? actParts(data, parent) : []
  const i = parts.findIndex((x) => x.act.id === actId)
  if (i < 0) return '幕の属する話が見つかりません'
  const next = parts[i + 1]
  if (!next) return '最後の幕なので、次の幕とつなげません'
  const missing = [parts[i], next].filter((x) => !hasAdopted(x))
  return missing.length > 0 ? `${actNames(missing)}に採用稿がないため、つなげません` : null
}

/**
 * 幕を次の幕とつなぐ。両方に採用稿がある時だけ。
 * この幕に「第n稿（つないだ稿）」（この幕の採用稿の本文＋次の幕の採用稿の本文）を作って採用し、次の幕を消す。
 * 次の幕の採用していなかった稿はゴミ箱へ（1件。戻すとこの幕の稿として戻る）。戻り値はつないだ稿の id。
 */
export function joinActWithNext(data: AppData, actId: ID): { data: AppData; result: ID } {
  const err = joinError(data, actId)
  if (err) throw new DomainError(err)
  return transact(data, (tx) => {
    const { act, parent, acts, index } = requireAct(tx, actId)
    const next = acts[index + 1]
    const a = adoptedOf(tx, act)!
    const b = adoptedOf(tx, next)!
    const ts = now()
    const label = pieceFullLabel(tx.data, act)
    const title = tx.get('titles', act.titleId)
    const seq = act.versionSeq + 1
    const joined: Version = {
      ...makeVersion(act, seq, a.body + b.body, a.id, `第${seq}稿${JOINED_VERSION_SUFFIX}`),
      // 消える次の幕の採用稿の推敲メモを残す（この幕のメモも入れて、つないだ稿だけで分かるように）
      note: carriedNote([
        { number: index + 1, version: a },
        { number: index + 2, version: b },
      ]),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('versions', joined)
    const versionIds = [...act.versionIds, joined.id]
    tx.put('pieces', { ...act, versionIds, activeVersionId: joined.id, versionSeq: seq, updatedAt: ts })

    const leftovers = leftoverVersions(tx, next, index + 2)
    if (leftovers.length > 0) {
      putInTrash(tx, {
        kind: 'version',
        label: `${actLabel(index + 2)}の採用していなかった稿（${leftovers.length}稿）`,
        titleName: title?.name ?? '',
        parentLabel: label,
        origin: {
          titleId: act.titleId,
          pieceId: act.id,
          // この幕も後でつないだ・解除したことで無くなっても、話（の幕）へ戻せるように
          parentId: parent.id,
          index: versionIds.length,
          prevId: joined.id,
          wasActive: false,
        },
        records: leftovers.map((record) => ({ table: 'versions' as const, record })),
        at: ts,
      })
    }
    retargetTrash(tx, next.id, act)
    removeAct(tx, next)
    tx.put('pieces', { ...parent, actIds: acts.filter((x) => x.id !== next.id).map((x) => x.id), updatedAt: ts })
    return joined.id
  })
}

/** セパレートを解除できるか（できなければ理由） */
export function unseparateError(data: AppData, pieceId: ID): string | null {
  const p = data.pieces[pieceId]
  if (!p || !isSplit(p)) return '幕に分けていない話です'
  const missing = actParts(data, p).filter((x) => !hasAdopted(x))
  return missing.length > 0 ? `${actNames(missing)}に採用原稿がないため、セパレートを解除できません` : null
}

/**
 * セパレートを解除する。すべての幕に採用稿がある時だけ（1つでも無ければ DomainError）。
 * 各幕の採用稿をつないだ本文を、話の新しい稿「第n稿（幕をつないだ稿）」として採用し、幕を消す。
 * 各幕の採用していなかった稿はゴミ箱へ（全部で1件。戻すとこの話の稿として戻る）。戻り値は新しい稿の id。
 */
export function unseparatePiece(data: AppData, pieceId: ID): { data: AppData; result: ID } {
  const err = unseparateError(data, pieceId)
  if (err) throw new DomainError(err)
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    const parts = actParts(tx.data, p)
    const ts = now()
    const label = pieceFullLabel(tx.data, p)
    const title = tx.get('titles', p.titleId)
    const seq = p.versionSeq + 1
    const body = parts.map((x) => x.version!.body).join('')
    const own = adoptedOf(tx, p)
    const v: Version = {
      ...makeVersion(p, seq, body, own?.id ?? null, `第${seq}稿${UNSEPARATED_VERSION_SUFFIX}`),
      // 消える各幕の採用稿の推敲メモを残す
      note: carriedNote(parts.map((x) => ({ number: x.number, version: x.version! }))),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('versions', v)
    const versionIds = [...p.versionIds, v.id]

    const leftovers = parts.flatMap((x) => leftoverVersions(tx, x.act, x.number))
    if (leftovers.length > 0) {
      putInTrash(tx, {
        kind: 'version',
        label: `各幕の採用していなかった稿（${leftovers.length}稿）`,
        titleName: title?.name ?? '',
        parentLabel: label,
        origin: { titleId: p.titleId, pieceId: p.id, index: versionIds.length, prevId: v.id, wasActive: false },
        records: leftovers.map((record) => ({ table: 'versions' as const, record })),
        at: ts,
      })
    }
    for (const x of parts) {
      retargetTrash(tx, x.act.id, p)
      removeAct(tx, x.act)
    }
    tx.put('pieces', { ...p, versionIds, activeVersionId: v.id, versionSeq: seq, actIds: [], updatedAt: ts })
    return v.id
  })
}
