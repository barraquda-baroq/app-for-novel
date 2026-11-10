// Firestore への書き込み（作るだけ）。書き換え・削除・分割文書・復元の印は書かない（アクセスルールでも書けない）。
// ゴミ箱へ移す依頼（2.7）も同じく作るだけ（カードの削除・ゴミ箱の記録は書かない）。
// Claude のアイデアとアイデアへの追記の依頼（2.8）も作るだけ（作者のアイデアの書き換え・削除はしない。追記はアプリがカードに足す）。
// - 1件の記録は JSON にして 200,000 字まで（分割文書を書かないため。アクセスルールと同じ値）。超える記録は、ふだんは
//   src/claude/records.ts が分け方を書いた理由で断る。ここは最後の守り（それでも届いたら、分けて呼ぶように返す）
// - 文書の形は端末と同じ（src/sync/codec.ts の encodeRecord）。updated はサーバー時刻（REQUEST_TIME）、device は claude-connector
// - 「無い時だけ作る」（currentDocument.exists = false）。内容から作った id なので、同じ結果を2回送っても1つしかできない
// - 送る前に、端末と同じ decodeRecord で読み戻せることを確かめる（端末で「読み取れませんでした」にならないように）
import { decodeRecord, encodeRecord } from '../../../src/sync/codec'
import { stableStringify, type Rec } from '../../../src/sync/merge'
import type { NewRecord } from '../../../src/claude/records'
import { RECORD_LIMITS, recordTooLarge } from '../../../src/claude/records'
import { CLAUDE_IDEA_ID, IDEA_APPEND_ID, IDEA_LIMITS } from '../../../src/claude/ideaAppend'
import { TRASH_LIMITS } from '../../../src/claude/trashRequest'
import type { Idea, IdeaAppend, TrashRequest } from '../../../src/domain/types'
import { CONNECTOR_DEVICE } from '../version'
import type { CommitResult, CommitWrite, FirestoreRest } from './firestore'
import type { RecRow } from './store'
import { timestampMicros, type Fields } from './values'

/** 1回の commit に入れる書き込みの数 */
export const COMMIT_GROUP = 100

/**
 * アクセスルールで作れる表: Claude の10の表（2.5 の相対比較の作品とその分析、2.6 の資料とその記録も）と、2.7 のゴミ箱へ移す依頼
 * （作るだけ。アプリが確かめてカードをゴミ箱へ移す。依頼の JSON は 2,000 字まで）、2.8 の Claude のアイデア（id は cy-…）と
 * アイデアへの追記の依頼（id は cu-…。アプリが確かめてカードの終わりに足す）。アイデア・追記の依頼の JSON は 50,000 字まで
 */
export const WRITABLE_TABLES = new Set([
  'proofSuggestions',
  'proofBatches',
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
  'benchWorks',
  'benchAnalyses',
  'materials',
  'materialNotes',
  'trashRequests',
  'ideas',
  'ideaAppends',
])

/** 書く記録（Claude の記録か、ゴミ箱へ移す依頼か、Claude のアイデアか、アイデアへの追記の依頼） */
export type WritableRecord =
  | NewRecord
  | { table: 'trashRequests'; record: TrashRequest }
  | { table: 'ideas'; record: Idea }
  | { table: 'ideaAppends'; record: IdeaAppend }

export interface PreparedWrite {
  table: string
  id: string
  json: string
  hash: string
  write: CommitWrite
}

export class EncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncodeError'
  }
}

/**
 * 記録を作る書き込みにする（200,000 字を超える・分割が要る大きさ・読み戻せない形は断る）。
 * アイデアは id が cy-…、追記の依頼は cu-… で、JSON が 50,000 字までのものだけ（アクセスルールと同じ。ふだんは
 * src/claude の組み立てで断るので、ここは最後の守り）
 */
export function prepareWrite(fs: FirestoreRest, ownerUid: string, rec: WritableRecord): PreparedWrite {
  const record = rec.record as unknown as Rec
  if (!WRITABLE_TABLES.has(rec.table)) throw new EncodeError(`表 ${rec.table} には書き込めません`)
  if (typeof record.id !== 'string' || !record.id || record.id.length > 64) throw new EncodeError('記録の id が不正です')
  if ((rec.table === 'ideas' && !CLAUDE_IDEA_ID.test(record.id)) || (rec.table === 'ideaAppends' && !IDEA_APPEND_ID.test(record.id)))
    throw new EncodeError('記録の id が不正です')
  const enc = encodeRecord(record)
  if (rec.table === 'trashRequests' && (enc.json === null || enc.json.length > TRASH_LIMITS.json))
    throw new EncodeError('ゴミ箱へ移す依頼が大きすぎます（1件の依頼は JSON にして 2,000 字まで）')
  if (rec.table === 'ideas' && (enc.json === null || enc.json.length > IDEA_LIMITS.recordJson))
    throw new EncodeError('アイデアが大きすぎます（1件は JSON にして 50,000 字まで）')
  if (rec.table === 'ideaAppends' && (enc.json === null || enc.json.length > IDEA_LIMITS.appendJson))
    throw new EncodeError('アイデアへの追記の依頼が大きすぎます（1件は JSON にして 50,000 字まで）')
  if (enc.json === null || enc.parts.length > 0 || enc.json.length > RECORD_LIMITS.recordJson)
    throw new EncodeError(
      recordTooLarge(
        enc.json?.length ?? enc.parts.reduce((n, p) => n + p.length, 0),
        '記録',
        '内容を2つ以上に分けて、ツールを分けて呼んでください（長い批評の結果は前半・後半のように分け、各部の1行目の先頭に「（1/2）」「（2/2）」と番号を書く。見出しで始める時は「## （1/2）総評」のように # の後ろに）',
      ),
    )
  // 端末と同じ読み方で読み戻せること
  const back = decodeRecord(
    {
      table: rec.table as never,
      id: record.id,
      json: enc.json,
      chunks: 0,
      deleted: false,
      hash: enc.hash,
      updated: null,
      device: CONNECTOR_DEVICE,
    },
    () => undefined,
  )
  if (!back || stableStringify(back) !== enc.json) throw new EncodeError('記録を読み戻せません')
  const docId = `${rec.table}:${record.id}`
  const fields: Fields = {
    table: { stringValue: rec.table },
    id: { stringValue: record.id },
    json: { stringValue: enc.json },
    chunks: { integerValue: '0' },
    deleted: { booleanValue: false },
    hash: { stringValue: enc.hash },
    device: { stringValue: CONNECTOR_DEVICE },
  }
  return {
    table: rec.table,
    id: record.id,
    json: enc.json,
    hash: enc.hash,
    write: {
      update: { name: fs.name(`users/${ownerUid}/records/${docId}`), fields },
      updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false },
    },
  }
}

/** 書けた記録を、写しの行にする（次の差分の読み取りを待たずに見えるように） */
export function rowsOfCommit(prepared: PreparedWrite[], result: CommitResult): RecRow[] {
  return prepared.map((p, i) => {
    const wr = result.writeResults[i]
    const t = wr?.transformResults?.[0] as { timestampValue?: string } | undefined
    const updated = t?.timestampValue ?? result.commitTime
    return {
      name: `${p.table}:${p.id}`,
      tbl: p.table,
      id: p.id,
      deleted: false,
      chunks: 0,
      hash: p.hash,
      updUs: timestampMicros(updated),
      updated,
      updateTime: wr?.updateTime ?? result.commitTime,
      device: CONNECTOR_DEVICE,
      json: p.json,
      reset: false,
    }
  })
}

export function groups<T>(list: readonly T[], size = COMMIT_GROUP): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
