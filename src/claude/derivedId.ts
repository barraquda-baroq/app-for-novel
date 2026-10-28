// 内容から作る id（Claude・手動連携の貼り付けで作る記録）。同じ内容を2回足しても同じ id になるので、
// コネクタは「まだ無い時だけ作る」（exists:false）、アプリの貼り付けは「もうあれば作らない」で、重ねて作らない。
// アプリとコネクタで同じ値になるように、同期の指紋と同じ同期的なハッシュ（src/domain/hash.ts の hashJson）を使う。
// 形: `c` + 種類の1文字 + `-` + 指紋（[a-z0-9.-] だけ・40字以内）。手で作ったレコードの id（newId の UUID）とは重ならない。
import { hashJson } from '../domain/hash'
import type { ID } from '../domain/types'

export type DerivedKind =
  | 'proofSuggestion'
  | 'proofRun'
  | 'proofBatch'
  | 'revisionIdea'
  | 'strategyNote'
  | 'critiquePrompt'
  | 'critiqueResult'

/** 種類ごとの1文字 */
export const DERIVED_ID_LETTERS: Record<DerivedKind, string> = {
  proofSuggestion: 's',
  proofRun: 'r',
  proofBatch: 'b',
  revisionIdea: 'i',
  strategyNote: 'n',
  critiquePrompt: 'p',
  critiqueResult: 'q',
}

/** 比べる前に揃える（Unicode の正規化 NFC。合成済みの文字と組み合わせの文字を同じに扱う） */
export function nfc(s: string): string {
  return s.normalize('NFC')
}

export type IdPart = string | number | boolean | null | undefined

/**
 * 内容から作る id。parts は種類ごとに決まった順に渡す（文字列は NFC にそろえる。null・undefined は空）。
 * 区切りは \u0000（本文には入らない文字）
 */
export function derivedId(kind: DerivedKind, parts: readonly IdPart[]): ID {
  const joined = [kind, ...parts.map((p) => (typeof p === 'string' ? nfc(p) : p == null ? '' : String(p)))].join('\u0000')
  return `c${DERIVED_ID_LETTERS[kind]}-${hashJson(joined)}`
}

/** 内容から作った id か（種類も分かれば返す） */
export function derivedKindOf(id: string): DerivedKind | null {
  const m = /^c([a-z])-[0-9a-z.]+$/.exec(id)
  if (!m) return null
  for (const [kind, letter] of Object.entries(DERIVED_ID_LETTERS)) if (letter === m[1]) return kind as DerivedKind
  return null
}

/** 長い文章は指紋にしてから id の材料にする */
const long = (s: string) => hashJson(nfc(s))

/**
 * 推敲案。pieceId は見つけた話・幕（幕に分けた話なら幕）。occurrence は同じ抜き出しが本文に何度もある時の何番目か（0から）
 */
export function proofSuggestionId(p: {
  titleId: ID
  pieceId: ID
  contextBefore: string
  excerpt: string
  occurrence: number
  category: string
  suggestion: string
}): ID {
  return derivedId('proofSuggestion', [
    p.titleId,
    p.pieceId,
    p.contextBefore + p.excerpt,
    p.occurrence,
    p.category,
    p.suggestion,
  ])
}

/** 推敲案の実行（同じタイトル・名前・日付の追加をまとめる） */
export function proofRunId(titleId: ID, runLabel: string, runDate: string): ID {
  return derivedId('proofRun', [titleId, runLabel.trim(), runDate])
}

/** 推敲案の1回の追加（同じ追加を2回送っても1つ） */
export function proofBatchId(runId: ID, coveredPieceIds: readonly ID[], itemIds: readonly ID[]): ID {
  return derivedId('proofBatch', [runId, [...coveredPieceIds].sort().join(','), [...itemIds].sort().join(',')])
}

export function revisionIdeaId(titleId: ID, heading: string, body: string): ID {
  return derivedId('revisionIdea', [titleId, heading.trim(), long(body)])
}

export function strategyNoteId(titleId: ID, runDate: string, heading: string, body: string): ID {
  return derivedId('strategyNote', [titleId, runDate, heading.trim(), long(body)])
}

/** 批評プロンプト。titleId = null は共通のプロンプト */
export function critiquePromptId(titleId: ID | null, name: string, body: string): ID {
  return derivedId('critiquePrompt', [titleId ?? 'shared', name.trim(), long(body)])
}

export function critiqueResultId(p: {
  titleId: ID
  runDate: string
  promptText: string
  resultMarkdown: string
  artifactUrl: string
}): ID {
  return derivedId('critiqueResult', [p.titleId, p.runDate, long(p.promptText), long(p.resultMarkdown), p.artifactUrl.trim()])
}
