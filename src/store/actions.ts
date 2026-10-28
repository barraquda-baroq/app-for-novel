// UI から呼ぶ操作。ドメインの純粋関数を現在のデータに適用して保存する。
// 仕様違反は DomainError を投げるので、UI 側では attempt() で受けてトースト表示する。
import * as A from '../domain/acts'
import * as E from '../domain/entityOps'
import {
  applyPieceEdits,
  keepOrphanedEdits,
  type OrphanKeepTarget,
  type PieceEdit,
  type PieceEditOptions,
} from '../domain/pieceEdits'
import * as S from '../domain/storyOps'
import * as T from '../domain/trash'
import type { AppData, ID, NumberingMode, SettingEntry, Slot } from '../domain/types'
import { commit, getData } from './appStore'

function apply(fn: (d: AppData) => AppData): void {
  commit(fn(getData()))
}

function run<R>(fn: (d: AppData) => { data: AppData; result: R }): R {
  const r = fn(getData())
  commit(r.data)
  return r.result
}

export const actions = {
  // タイトル
  createTitle: (name: string) => run((d) => E.createTitle(d, name)),
  updateTitle: (titleId: ID, patch: Parameters<typeof E.updateTitle>[2]) => apply((d) => E.updateTitle(d, titleId, patch)),
  moveTitleStep: (titleId: ID, dir: -1 | 1) => apply((d) => E.moveTitleStep(d, titleId, dir)),
  moveTitleTo: (titleId: ID, index: number) => apply((d) => E.moveTitleTo(d, titleId, index)),
  deleteTitle: (titleId: ID) => apply((d) => E.deleteTitle(d, titleId)),

  // アイデア
  addIdea: (titleId: ID | null, heading = '', body = '') => run((d) => E.addIdea(d, titleId, heading, body)),
  updateIdea: (ideaId: ID, patch: Parameters<typeof E.updateIdea>[2]) => apply((d) => E.updateIdea(d, ideaId, patch)),
  moveIdeaToSection: (ideaId: ID, titleId: ID | null) => apply((d) => E.moveIdeaToSection(d, ideaId, titleId)),
  moveIdeaStep: (ideaId: ID, dir: -1 | 1) => apply((d) => E.moveIdeaStep(d, ideaId, dir)),
  moveIdeaTo: (ideaId: ID, titleId: ID | null, index: number) => apply((d) => E.moveIdeaTo(d, ideaId, titleId, index)),
  deleteIdea: (ideaId: ID) => apply((d) => E.deleteIdea(d, ideaId)),

  // 本編: 話数追加・特殊追加
  addEpisode: (titleId: ID, target?: ID | null) => run((d) => S.addEpisode(d, titleId, target)),
  addSpecial: (titleId: ID, slot: Slot, label?: string) => run((d) => S.addSpecial(d, titleId, slot, label)),
  updatePiece: (pieceId: ID, patch: { subtitle?: string; label?: string }) => apply((d) => S.updatePiece(d, pieceId, patch)),
  deletePiece: (pieceId: ID) => apply((d) => S.deletePiece(d, pieceId)),
  movePiece: (pieceId: ID, slot: Slot) => apply((d) => S.movePiece(d, pieceId, slot)),
  movePieceStep: (pieceId: ID, dir: -1 | 1) => apply((d) => S.movePieceStep(d, pieceId, dir)),

  // 章
  setChaptersEnabled: (titleId: ID, enabled: boolean) => apply((d) => S.setChaptersEnabled(d, titleId, enabled)),
  setNumbering: (titleId: ID, mode: NumberingMode) => apply((d) => S.setNumbering(d, titleId, mode)),
  addChapter: (titleId: ID, name?: string) => run((d) => S.addChapter(d, titleId, name)),
  updateChapter: (chapterId: ID, patch: { name?: string; note?: string }) => apply((d) => S.updateChapter(d, chapterId, patch)),
  moveChapterStep: (chapterId: ID, dir: -1 | 1) => apply((d) => S.moveChapterStep(d, chapterId, dir)),
  removeChapter: (chapterId: ID) => apply((d) => S.removeChapter(d, chapterId)),

  // 推敲バージョン
  addVersion: (pieceId: ID, opts?: Parameters<typeof S.addVersion>[2]) => run((d) => S.addVersion(d, pieceId, opts)),
  duplicateVersion: (versionId: ID) => run((d) => S.duplicateVersion(d, versionId)),
  updateVersion: (versionId: ID, patch: { name?: string; body?: string; note?: string }) =>
    apply((d) => S.updateVersion(d, versionId, patch)),
  deleteVersion: (versionId: ID) => apply((d) => S.deleteVersion(d, versionId)),
  setActiveVersion: (pieceId: ID, versionId: ID | null) => apply((d) => S.setActiveVersion(d, pieceId, versionId)),
  /** 原稿画面の「保存」: 画面の中で持っていた編集をまとめて書き込む（本文が競合したら別の稿として残す） */
  savePieceEdits: (pieceId: ID, edits: readonly PieceEdit[], opts: PieceEditOptions) =>
    run((d) => applyPieceEdits(d, pieceId, edits, opts)),
  /** 保存先の話・幕が無くなった（幕に分けられた）編集を、残し先の新しい稿（無ければゴミ箱）として残す */
  keepOrphanedEdits: (edits: readonly PieceEdit[], target: OrphanKeepTarget, opts: PieceEditOptions) =>
    run((d) => keepOrphanedEdits(d, edits, target, opts)),

  // セパレート（幕）
  /** 話（または幕）を採用稿の offsets の位置で幕に分ける。戻り値は分けた後の幕の id（読む順） */
  separatePiece: (pieceId: ID, offsets: readonly number[]) => run((d) => A.separatePiece(d, pieceId, offsets)),
  /** 幕を次の幕とつなぐ。戻り値はつないだ稿の id */
  joinActWithNext: (actId: ID) => run((d) => A.joinActWithNext(d, actId)),
  /** セパレートを解除する。戻り値は各幕をつないだ話の新しい稿の id */
  unseparatePiece: (pieceId: ID) => run((d) => A.unseparatePiece(d, pieceId)),

  // メモ
  addMemo: (titleId: ID, name?: string) => run((d) => E.addMemo(d, titleId, name)),
  updateMemo: (memoId: ID, patch: Parameters<typeof E.updateMemo>[2]) => apply((d) => E.updateMemo(d, memoId, patch)),
  moveMemoStep: (memoId: ID, dir: -1 | 1) => apply((d) => E.moveMemoStep(d, memoId, dir)),
  deleteMemo: (memoId: ID) => apply((d) => E.deleteMemo(d, memoId)),

  // 設定項目
  addCategory: (titleId: ID, name: string, fieldTemplate?: string[]) =>
    run((d) => E.addCategory(d, titleId, name, fieldTemplate)),
  updateCategory: (categoryId: ID, patch: Parameters<typeof E.updateCategory>[2]) =>
    apply((d) => E.updateCategory(d, categoryId, patch)),
  moveCategoryStep: (categoryId: ID, dir: -1 | 1) => apply((d) => E.moveCategoryStep(d, categoryId, dir)),
  deleteCategory: (categoryId: ID) => apply((d) => E.deleteCategory(d, categoryId)),
  addEntry: (categoryId: ID, name?: string) => run((d) => E.addEntry(d, categoryId, name)),
  updateEntry: (entryId: ID, patch: Partial<Pick<SettingEntry, 'name' | 'body' | 'fields'>>) =>
    apply((d) => E.updateEntry(d, entryId, patch)),
  moveEntryStep: (entryId: ID, dir: -1 | 1) => apply((d) => E.moveEntryStep(d, entryId, dir)),
  moveEntryToCategory: (entryId: ID, categoryId: ID) => apply((d) => E.moveEntryToCategory(d, entryId, categoryId)),
  deleteEntry: (entryId: ID) => apply((d) => E.deleteEntry(d, entryId)),

  // 戦略
  addSubmission: (titleId: ID, contestName?: string) => run((d) => E.addSubmission(d, titleId, contestName)),
  updateSubmission: (submissionId: ID, patch: E.SubmissionPatch) => apply((d) => E.updateSubmission(d, submissionId, patch)),
  moveSubmissionStep: (submissionId: ID, dir: -1 | 1) => apply((d) => E.moveSubmissionStep(d, submissionId, dir)),
  deleteSubmission: (submissionId: ID) => apply((d) => E.deleteSubmission(d, submissionId)),
  recordSubmissionSnapshot: (submissionId: ID) => apply((d) => E.recordSubmissionSnapshot(d, submissionId)),

  // ゴミ箱（削除の操作は上の各 delete… がゴミ箱へ移す）
  restoreTrashEntry: (entryId: ID) => run((d) => T.restoreTrashEntry(d, entryId)),
  deleteTrashEntry: (entryId: ID) => apply((d) => T.deleteTrashEntry(d, entryId)),
  emptyTrash: () => apply((d) => T.emptyTrash(d)),
  /** 削除してから30日たったものを完全に削除する（起動時と1時間ごとに呼ぶ） */
  purgeExpiredTrash: (nowTs: number = Date.now()) => apply((d) => T.purgeExpiredTrash(d, nowTs)),
}

export type Actions = typeof actions
