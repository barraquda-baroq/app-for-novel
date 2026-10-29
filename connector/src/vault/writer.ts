// Firestore への書き込み（作るだけ）。書き換え・削除・分割文書・復元の印は書かない（アクセスルールでも書けない）。
// - 文書の形は端末と同じ（src/sync/codec.ts の encodeRecord）。updated はサーバー時刻（REQUEST_TIME）、device は claude-connector
// - 「無い時だけ作る」（currentDocument.exists = false）。内容から作った id なので、同じ結果を2回送っても1つしかできない
// - 送る前に、端末と同じ decodeRecord で読み戻せることを確かめる（端末で「読み取れませんでした」にならないように）
import { decodeRecord, encodeRecord } from '../../../src/sync/codec'
import { stableStringify, type Rec } from '../../../src/sync/merge'
import type { NewRecord } from '../../../src/claude/records'
import { RECORD_LIMITS } from '../../../src/claude/records'
import { CONNECTOR_DEVICE } from '../version'
import type { CommitResult, CommitWrite, FirestoreRest } from './firestore'
import type { RecRow } from './store'
import { timestampMicros, type Fields } from './values'

/** 1回の commit に入れる書き込みの数 */
export const COMMIT_GROUP = 100

/** Claude の6つの表（アクセスルールで作れる表） */
export const WRITABLE_TABLES = new Set([
  'proofSuggestions',
  'proofBatches',
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
])

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

/** 記録を作る書き込みにする（分割が要る大きさ・読み戻せない形は断る） */
export function prepareWrite(fs: FirestoreRest, ownerUid: string, rec: NewRecord): PreparedWrite {
  const record = rec.record as unknown as Rec
  if (!WRITABLE_TABLES.has(rec.table)) throw new EncodeError(`表 ${rec.table} には書き込めません`)
  if (typeof record.id !== 'string' || !record.id || record.id.length > 64) throw new EncodeError('記録の id が不正です')
  const enc = encodeRecord(record)
  if (enc.json === null || enc.parts.length > 0 || enc.json.length > RECORD_LIMITS.recordJson)
    throw new EncodeError('記録が大きすぎます（200,000字まで）')
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
