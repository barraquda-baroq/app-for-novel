// 話・タイトルの指し方（コネクタのツールの入力と、手動連携の貼り付けで同じものを使う）。
// - 短い id: 種類の1文字 + ':' + id の先頭8文字（'t:3f2a9c1b'）。id そのもの（UUID）でもよい
// - '#12': 読む順の12番目（第n話・特殊ブロック。章をまたいで通し）。'#12.2' はその話の第2幕
// - 「第12話」「第3話 第2幕」「プロローグ」（特殊ブロックの見出し）。章ごとに話数を振っている時は「一章 第1話」
// 指し先が複数ある時は ambiguous で候補を返す（候補は「#3 第3話　題 [p:…]」の形）。
import { actsOf, chaptersOf, episodeNumbers, flatten, isSplit, pieceFullLabel, pieceLabel } from '../domain/structure'
import type { AppData, Chapter, ID, Piece, Title } from '../domain/types'

/** 短い id の種類の文字 */
export const SHORT_ID_LETTERS = {
  title: 't',
  chapter: 'c',
  piece: 'p',
  version: 'v',
  settingEntry: 'e',
  memo: 'm',
  idea: 'i',
  submission: 'o',
  proofSuggestion: 'x',
  proofBatch: 'b',
  revisionIdea: 'r',
  strategyNote: 'g',
  critiquePrompt: 'q',
  critiqueResult: 'a',
} as const

export type ShortIdKind = keyof typeof SHORT_ID_LETTERS

/** id の頭（英数字だけ。内容から作った id は先頭の 'cX-' を除く） */
function idHead(id: string): string {
  return id
    .replace(/^c[a-z]-/, '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toLowerCase()
}

/** 短い id（'p:3f2a9c1b'） */
export function shortId(kind: ShortIdKind, id: string): string {
  return `${SHORT_ID_LETTERS[kind]}:${idHead(id).slice(0, 8)}`
}

/** 短い id か id そのものが、この id を指しているか（短い id は4文字以上の頭） */
export function matchesId(kind: ShortIdKind, ref: string, id: string): boolean {
  const r = ref.trim()
  if (r === id) return true
  const prefix = `${SHORT_ID_LETTERS[kind]}:`
  if (!r.toLowerCase().startsWith(prefix)) return false
  const head = r
    .slice(prefix.length)
    .replace(/[^0-9a-zA-Z]/g, '')
    .toLowerCase()
  return head.length >= 4 && idHead(id).startsWith(head)
}

export type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'ambiguous'; message: string; candidates: string[] }

/** 読む順の1つ（第n話・特殊ブロック。幕は含まない） */
export interface ReadingItem {
  /** 読む順（1から。'#12' の 12） */
  index: number
  piece: Piece
  chapterId: ID | null
  /** 「第12話」「プロローグ」 */
  label: string
  /** 「第12話　題」 */
  fullLabel: string
}

/** タイトルの話を読む順に（幕は含まない。幕は actsOf で） */
export function readingOrder(data: AppData, titleId: ID): ReadingItem[] {
  const numbers = episodeNumbers(data, titleId)
  return flatten(data, titleId).map((f, i) => {
    const piece = data.pieces[f.pieceId]
    return {
      index: i + 1,
      piece,
      chapterId: f.chapterId,
      label: pieceLabel(data, piece, numbers),
      fullLabel: pieceFullLabel(data, piece, numbers),
    }
  })
}

/** 候補の表記「#3 第3話　題 [p:…]」（幕は「#3 第3話　題　第2幕 [p:…]」） */
export function pieceRefLabel(data: AppData, piece: Piece, order?: readonly ReadingItem[]): string {
  const list = order ?? readingOrder(data, piece.titleId)
  const topId = piece.kind === 'act' && piece.parentId ? piece.parentId : piece.id
  const item = list.find((x) => x.piece.id === topId)
  return `${item ? `#${item.index} ` : ''}${pieceFullLabel(data, piece)} [${shortId('piece', piece.id)}]`
}

const normalizeRef = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim()

/** 「第12話」「第１２話」「第十二話」は扱わず、算用数字（全角も可）だけ */
const EPISODE_RE = /^(?:(.+?) )?第(\d+)話(?: ?第(\d+)幕)?$/

/**
 * タイトルの指し方を読む（短い id・id・タイトル名）。見つからない・複数ある時は候補を返す
 */
export function resolveTitle(data: AppData, ref: string): Resolved<Title> {
  const r = ref.trim()
  const titles = Object.values(data.titles)
  const byId = titles.filter((t) => matchesId('title', r, t.id))
  if (byId.length === 1) return { ok: true, value: byId[0] }
  const byName = byId.length ? byId : titles.filter((t) => normalizeRef(t.name) === normalizeRef(r))
  if (byName.length === 1) return { ok: true, value: byName[0] }
  const candidates = (byName.length ? byName : titles).slice(0, 20).map((t) => `${shortId('title', t.id)}『${t.name}』`)
  return byName.length
    ? { ok: false, reason: 'ambiguous', message: `タイトル '${r}' が複数あります`, candidates }
    : { ok: false, reason: 'not_found', message: `タイトル '${r}' が見つかりません`, candidates }
}

/**
 * 話の指し方を読む（短い id・id・'#12'・'#12.2'・「第12話」「第3話 第2幕」「一章 第1話」・特殊ブロックの見出し）。
 * 幕を指したら幕を、話を指したら話を返す（幕に分けた話は呼び出し側で幕に分ける）
 */
export function resolvePiece(data: AppData, titleId: ID, ref: string, order?: readonly ReadingItem[]): Resolved<Piece> {
  const list = order ?? readingOrder(data, titleId)
  const r = ref.trim()
  const fail = (reason: 'not_found' | 'ambiguous', pieces: Piece[], message: string): Resolved<Piece> => ({
    ok: false,
    reason,
    message,
    candidates: (pieces.length ? pieces : list.slice(0, 5).map((x) => x.piece))
      .slice(0, 10)
      .map((p) => pieceRefLabel(data, p, list)),
  })
  const pick = (pieces: Piece[], what: string): Resolved<Piece> => {
    if (pieces.length === 1) return { ok: true, value: pieces[0] }
    if (pieces.length > 1) return fail('ambiguous', pieces, `『${what}』が${pieces.length}つあります`)
    return fail('not_found', [], `話 '${what}' が見つかりません`)
  }
  if (!r) return fail('not_found', [], '話が指定されていません')
  const all = [...list.map((x) => x.piece), ...list.flatMap((x) => actsOf(data, x.piece))]

  // id・短い id
  const byId = all.filter((p) => matchesId('piece', r, p.id))
  if (byId.length) return pick(byId, r)

  const n = normalizeRef(r)
  // '#12'・'#12.2'
  const hash = /^#(\d+)(?:\.(\d+))?$/.exec(n)
  if (hash) {
    const item = list.find((x) => x.index === Number(hash[1]))
    if (!item) return fail('not_found', [], `'${r}' はありません（このタイトルは #1〜#${list.length}）`)
    if (!hash[2]) return { ok: true, value: item.piece }
    const act = actsOf(data, item.piece)[Number(hash[2]) - 1]
    return act ? { ok: true, value: act } : fail('not_found', [item.piece], `${item.fullLabel}に第${hash[2]}幕はありません`)
  }

  // 「第12話」「一章 第1話」「第3話 第2幕」
  const ep = EPISODE_RE.exec(n)
  if (ep) {
    const [, chapterName, num, actNum] = ep
    let items = list.filter((x) => x.piece.kind === 'episode' && x.label === `第${Number(num)}話`)
    if (chapterName) {
      const chapters = chaptersOf(data, titleId).filter((c: Chapter) => normalizeRef(c.name) === normalizeRef(chapterName))
      items = items.filter((x) => chapters.some((c) => c.id === x.chapterId))
    }
    if (actNum) {
      const acts = items.map((x) => actsOf(data, x.piece)[Number(actNum) - 1]).filter((a): a is Piece => Boolean(a))
      if (!acts.length && items.length === 1)
        return fail('not_found', [items[0].piece], `${items[0].fullLabel}に第${actNum}幕はありません`)
      return pick(acts, r)
    }
    return pick(
      items.map((x) => x.piece),
      r,
    )
  }

  // 特殊ブロックの見出し・「第12話　題」の題まで含めた表記
  const byLabel = list.filter(
    (x) => normalizeRef(x.fullLabel) === n || (x.piece.kind === 'special' && normalizeRef(x.label) === n),
  )
  if (byLabel.length)
    return pick(
      byLabel.map((x) => x.piece),
      r,
    )
  return fail('not_found', [], `話 '${r}' が見つかりません`)
}

/** 話（第n話・特殊ブロック）とその幕（幕に分けた話は幕だけ）の並び。範囲の指定で使う */
export function piecesWithActs(data: AppData, piece: Piece): Piece[] {
  return isSplit(piece) ? actsOf(data, piece) : [piece]
}
