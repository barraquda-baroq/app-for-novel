// 推敲の「確かめた範囲」を、Claude が読んだ時の本文で残すための控え（2.9。コネクタの接続ごと）。
// - novel_read_text が話・幕の採用原稿を出した時に、その話（幕なら幕と、幕の属する話）の採用原稿の指紋を控える。指紋は
//   proofCoverage・buildProofreading と同じ adoptedBodyHash（hashJson(採用原稿)）なので、そのまま比べられる
// - novel_add_proofreading の covered は、控えがいまの指紋と違えば控えの指紋を残す（読んだ後に作者が直した話は、アプリと
//   novel_list_proofreading の確認の範囲で「本文が変わった話」に出る）。控えが無ければ今までどおり書く時の指紋
// - 長い話を何ページかに分けて読んだ時・幕を1つずつ読んだ時は、前に読んだ区切り（幕・幕に分けていない話）がその後に変わっていれば、
//   その前の指紋のままにする（変わった所を読んでいないことがあるため）。まだ読んでいない幕だけが変わった時は、いまの指紋。
//   変わった区切りをその始めから読み直すと、いまの指紋で控え直す（話の始めから読み直す時は、いまの話に無い区切り（消えた幕・
//   幕に分ける前の話・つなぐ前の幕）の控えは忘れる）
// 控えを置く所（接続ごと・数と期間の上限）はコネクタが決める（connector/src/vault/core.ts）。
import { actParts, isSplit, parentOf } from '../domain/structure'
import type { AppData, ID, Piece } from '../domain/types'
import { adoptedBodyHash } from './order'
import type { ServedPart } from './view'

/** 1つの話・幕の、読んだ時の控え */
export interface ReadMemoEntry {
  /** 読んだ時の採用原稿の指紋（adoptedBodyHash。ProofCovered.bodyHash と同じ値） */
  hash: string
  /** 読んだ時の採用稿（幕に分けた話は null。ProofCovered.versionId と同じ値） */
  versionId: ID | null
  /** 読んだ区切り（幕・幕に分けていない話）ごとの、読んだ時の採用原稿の指紋 */
  parts: Record<ID, string>
}

/** 1つの接続の控え（読み書き） */
export interface ReadMemoAccess {
  get(pieceId: ID): ReadMemoEntry | undefined
  set(pieceId: ID, entry: ReadMemoEntry): void
}

/** 話・幕の採用稿（buildProofreading の covered と同じ。幕に分けた話は null） */
function adoptedVersionId(piece: Piece): ID | null {
  return isSplit(piece) ? null : (piece.activeVersionId ?? null)
}

/** 話・幕の区切り（幕に分けた話は幕。ほかはそれ自身） */
function partsOf(data: AppData, piece: Piece): ID[] {
  const acts = isSplit(piece) ? actParts(data, piece).map((p) => p.act.id) : []
  return acts.length ? acts : [piece.id]
}

/** novel_read_text が出した区切り（ViewResult.served）から、その接続の控えを新しくする */
export function noteServed(data: AppData, served: readonly ServedPart[], memo: ReadMemoAccess): void {
  /** 控える話・幕 → このページに出した区切りと、それを始めから出したか */
  const byTarget = new Map<ID, Map<ID, boolean>>()
  const add = (target: ID, part: ServedPart) => {
    const parts = byTarget.get(target) ?? new Map<ID, boolean>()
    parts.set(part.pieceId, (parts.get(part.pieceId) ?? false) || part.start)
    byTarget.set(target, parts)
  }
  for (const part of served) {
    const piece = data.pieces[part.pieceId]
    if (!piece) continue
    add(piece.id, part)
    // 幕は、幕の属する話の控えにも入れる（covered には話を渡すことが多い）
    const parent = parentOf(data, piece)
    if (parent) add(parent.id, part)
  }
  for (const [targetId, parts] of byTarget) {
    const target = data.pieces[targetId]
    if (!target) continue
    const page: Record<ID, string> = {}
    for (const id of parts.keys()) page[id] = adoptedBodyHash(data, id)
    const now = { hash: adoptedBodyHash(data, targetId), versionId: adoptedVersionId(target) }
    const prev = memo.get(targetId)
    if (!prev) {
      memo.set(targetId, { ...now, parts: page })
      continue
    }
    // 話の始めから読んだ: いまの話に無い区切りの控えは忘れる
    const own = partsOf(data, target)
    const earlier: Record<ID, string> =
      parts.get(own[0]) === true
        ? Object.fromEntries(Object.entries(prev.parts).filter(([id]) => own.includes(id)))
        : { ...prev.parts }
    // 前に読んだ区切り（このページで始めから読み直したものを除く）が、その後に変わったか
    const stale = Object.entries(earlier).some(([id, h]) => parts.get(id) !== true && adoptedBodyHash(data, id) !== h)
    if (!stale) {
      memo.set(targetId, { ...now, parts: { ...earlier, ...page } })
      continue
    }
    // 変わっていた: 前の指紋のまま。変わった区切りの控えも残す（その区切りを始めから読み直すまで、変わったままにする）
    for (const [id, h] of Object.entries(page)) if (parts.get(id) === true || !(id in earlier)) earlier[id] = h
    memo.set(targetId, { hash: prev.hash, versionId: prev.versionId, parts: earlier })
  }
}

/**
 * 読んだ後に採用原稿が変わった話・幕か（控えがあり、いまの指紋と違う）。幕に控えが無ければ、幕の属する話の控えで見る
 * （推敲案の引用が見つからない時の説明に使う）
 */
export function changedSinceRead(data: AppData, piece: Piece, readAs: (pieceId: ID) => ReadMemoEntry | undefined): boolean {
  const own = readAs(piece.id)
  if (own) return own.hash !== adoptedBodyHash(data, piece.id)
  const parent = parentOf(data, piece)
  const memo = parent ? readAs(parent.id) : undefined
  return Boolean(parent && memo && memo.hash !== adoptedBodyHash(data, parent.id))
}
