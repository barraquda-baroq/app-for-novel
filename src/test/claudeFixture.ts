// 2.3（Claude 連携）のテスト用のデータ: 本文を入れた話を並べたタイトル。幕に分けた話・特殊ブロックも作れる。
import { separatePiece } from '../domain/acts'
import { createTitle } from '../domain/entityOps'
import { addEpisode, addSpecial, updatePiece, updateVersion } from '../domain/storyOps'
import { emptyData, type AppData, type ID } from '../domain/types'

export interface Novel {
  data: AppData
  titleId: ID
  /** 話の id（読む順。特殊ブロックは specialId） */
  ids: ID[]
}

/** 本文 bodies の第n話を並べたタイトル（題は subtitles） */
export function novel(bodies: readonly string[], opts: { name?: string; subtitles?: string[]; data?: AppData } = {}): Novel {
  const t = createTitle(opts.data ?? emptyData(), opts.name ?? '星の庭')
  let data = t.data
  const ids: ID[] = []
  bodies.forEach((body, i) => {
    const r = addEpisode(data, t.result)
    data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
    if (opts.subtitles?.[i]) data = updatePiece(data, r.result, { subtitle: opts.subtitles[i] })
    ids.push(r.result)
  })
  return { data, titleId: t.result, ids }
}

/** 話を幕に分ける（戻り値は幕の id） */
export function splitEpisode(n: Novel, pieceId: ID, offsets: number[]): { data: AppData; acts: ID[] } {
  const r = separatePiece(n.data, pieceId, offsets)
  n.data = r.data
  return { data: r.data, acts: r.result }
}

/** タイトル直下の先頭に特殊ブロック（見出し label・本文 body）を足す */
export function addPrologue(n: Novel, label: string, body: string): ID {
  const r = addSpecial(n.data, n.titleId, { chapterId: null, index: 0 }, label)
  n.data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
  return r.result
}
