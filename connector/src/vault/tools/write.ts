// 書き込みツール（W1〜W5）の結果の形。テキストに加えて structuredContent に
// { created: [{ id, label }], skipped: [{ index, reason, hint }] } を返す（原稿は入れない）。
import {
  summarizeItems,
  WRITE_TOOL_LABELS,
  type BuildResult,
  type ItemResult,
  type ItemStatus,
  type WriteTool,
} from '../../../../src/claude/records'
import { shortId, type ShortIdKind } from '../../../../src/claude/refs'
import type { ClaudeTableName } from '../../../../src/domain/types'
import { capText, fail, type ToolResult } from './common'

const KIND: Record<ClaudeTableName, ShortIdKind> = {
  proofSuggestions: 'proofSuggestion',
  proofBatches: 'proofBatch',
  revisionIdeas: 'revisionIdea',
  strategyNotes: 'strategyNote',
  critiquePrompts: 'critiquePrompt',
  critiqueResults: 'critiqueResult',
  benchWorks: 'benchWork',
  benchAnalyses: 'benchAnalysis',
}

const WHERE: Record<WriteTool, string> = {
  novel_add_proofreading: 'アプリのタイトルの「戦略 → 推敲案」',
  novel_add_revision_ideas: 'アプリのタイトルの「戦略 → 改稿案」',
  novel_add_strategy_note: 'アプリのタイトルの「戦略 → 戦略メモ」',
  novel_save_critique_prompt: 'アプリのタイトルの「作品批評 → 批評プロンプト」',
  novel_add_critique_result: 'アプリのタイトルの「作品批評」の結果',
  novel_add_bench_analysis: 'アプリのホームの「ベンチ作品」',
}

const STATUS_LABELS: Record<ItemStatus, string> = {
  created: '追加',
  duplicate: '重複',
  previously_deleted: '以前に削除',
  not_found: '見つからない',
  ambiguous: '場所が決まらない',
  invalid: '形が違う',
}

/** 送る前の確かめで入力全体を受け付けなかった */
export function buildError(built: BuildResult): ToolResult {
  return fail(built.error ?? '入力を受け付けませんでした', built.candidates)
}

/**
 * 結果を作る。createdIds は実際に作った記録（{表名}:{id}）。試し直しで2回目に「重複」になった記録も、
 * 1回目に作っていれば「追加」として返す
 */
export function writeResult(tool: WriteTool, built: BuildResult, createdIds: ReadonlySet<string>): ToolResult {
  const items: ItemResult[] = built.items.map((it) =>
    it.id && it.table && createdIds.has(`${it.table}:${it.id}`) && it.status !== 'created' ? { ...it, status: 'created', hint: undefined } : it,
  )
  const created = items.filter((it) => it.status === 'created' && it.id && it.table && createdIds.has(`${it.table}:${it.id}`))
  const skipped = items.filter((it) => !created.includes(it))
  const batch = built.records.find((r) => r.table === 'proofBatches')
  const batchMade = batch ? createdIds.has(`proofBatches:${batch.record.id}`) : false
  const lines: string[] = [`${WRITE_TOOL_LABELS[tool]}: ${summarizeItems(items) || '追加するものはありませんでした'}`]
  for (const it of created) lines.push(`- 追加 ${shortId(KIND[it.table!], it.id!)} ${it.label}`)
  for (const it of skipped) {
    lines.push(`- ${STATUS_LABELS[it.status]} ${it.label}${it.hint ? `: ${it.hint}` : ''}`)
    if (it.candidates?.length) for (const c of it.candidates.slice(0, 5)) lines.push(`    候補: ${c}`)
  }
  if (batchMade) lines.push('- 実行の記録（確認した話・追加した案）を残しました')
  for (const n of built.notes) lines.push(`補足: ${n}`)
  if (created.length || batchMade)
    lines.push(`${WHERE[tool]}に、各端末が同期すると出ます。本文（稿）は書き換えていません。`)
  const needsFix = skipped.some((it) => it.status === 'not_found' || it.status === 'ambiguous' || it.status === 'invalid')
  return {
    text: capText(lines.join('\n')),
    isError: !created.length && !batchMade && needsFix ? true : undefined,
    structured: {
      created: created.map((it) => ({ id: shortId(KIND[it.table!], it.id!), label: it.label })),
      skipped: skipped.map((it) => ({ index: it.index, reason: it.status, ...(it.hint ? { hint: it.hint } : {}) })),
    },
  }
}
