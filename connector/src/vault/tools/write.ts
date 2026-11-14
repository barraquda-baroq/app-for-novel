// 書き込みツール（W1〜W7）の結果の形。テキストに加えて structuredContent に
// { created: [{ id, label, chars? }], skipped: [{ index, reason, hint }] } を返す（原稿は入れない）。
// Claude が書いた本文のある記録（相対比較の分析・資料の記録・批評の結果・戦略メモ・改稿案）は、「- 追加」の行の下に
// 「    字数: 2,980字（空白・改行を除く。アプリと同じ数え方）」の行を足す（「- 追加」の行は V30 が読むので変えない。chars も同じ数）。
import {
  summarizeItems,
  WRITE_TOOL_LABELS,
  type BuildResult,
  type ItemResult,
  type ItemStatus,
  type WriteTool,
} from '../../../../src/claude/records'
import { shortId, type ShortIdKind } from '../../../../src/claude/refs'
import { formatCount } from '../../../../src/domain/text'
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
  materials: 'material',
  materialNotes: 'materialNote',
}

const WHERE: Record<WriteTool, string> = {
  novel_add_proofreading: 'アプリのタイトルの「戦略 → 推敲案」',
  novel_add_revision_ideas: 'アプリのタイトルの「戦略 → 改稿案」',
  novel_add_strategy_note: 'アプリのタイトルの「戦略 → 戦略メモ」',
  novel_save_critique_prompt: 'アプリのタイトルの「作品批評 → 批評プロンプト」',
  novel_add_critique_result: 'アプリのタイトルの「作品批評」の結果',
  novel_add_bench_analysis: 'アプリのホームの「相対比較」',
  novel_add_material_notes: 'アプリのホームの「資料」',
}

/**
 * 「- 追加」の行の下に字数の行を出す表（Claude が書いた本文のある記録。推敲案・実行の記録・批評プロンプトには出さない）。
 * 数は builder が ItemResult.chars に入れる（試し直しで「重複」から「追加」にした記録も、送った本文から数えてある）
 */
const CHARS_TABLES: ReadonlySet<ClaudeTableName> = new Set([
  'benchAnalyses',
  'materialNotes',
  'critiqueResults',
  'strategyNotes',
  'revisionIdeas',
])

/** 字数の行（アプリの文字数と同じ数え方: 空白・改行・ルビの記法と読みを除く） */
export function charsLine(chars: number): string {
  return `    字数: ${formatCount(chars)}字（空白・改行を除く。アプリと同じ数え方）`
}

const charsOf = (it: ItemResult): number | undefined =>
  it.table && CHARS_TABLES.has(it.table) && it.chars !== undefined ? it.chars : undefined

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
 * 1回目に作っていれば「追加」として返す。
 * failed は、記録を分けて書いた（100件を超える推敲案）時に前の組だけ書けた失敗の説明: 書けなかった項目を「- 書けなかった」の行に
 * 出し（structuredContent では skipped の not_written）、補足に理由と、同じ呼び出しをもう一度送れば残りだけ足すことを書く。
 * 書けた分があるので失敗（isError）にはしない
 */
export function writeResult(
  tool: WriteTool,
  built: BuildResult,
  createdIds: ReadonlySet<string>,
  opts: { failed?: string } = {},
): ToolResult {
  const items: ItemResult[] = built.items.map((it) =>
    it.id && it.table && createdIds.has(`${it.table}:${it.id}`) && it.status !== 'created'
      ? { ...it, status: 'created', hint: undefined, statusLabel: undefined }
      : it,
  )
  const created = items.filter((it) => it.status === 'created' && it.id && it.table && createdIds.has(`${it.table}:${it.id}`))
  /** 作るはずだったが書けなかった（failed の時だけ） */
  const unwritten = opts.failed ? items.filter((it) => it.status === 'created' && !created.includes(it)) : []
  const skipped = items.filter((it) => !created.includes(it) && !unwritten.includes(it))
  const batch = built.records.find((r) => r.table === 'proofBatches')
  const batchMade = batch ? createdIds.has(`proofBatches:${batch.record.id}`) : false
  const batchLeft = Boolean(opts.failed && batch && !batchMade)
  const summary = [summarizeItems(items.filter((it) => !unwritten.includes(it))), unwritten.length ? `書けなかった ${unwritten.length}件` : '']
    .filter(Boolean)
    .join('・')
  const lines: string[] = [`${WRITE_TOOL_LABELS[tool]}: ${summary || '追加するものはありませんでした'}`]
  for (const it of created) {
    lines.push(`- 追加 ${shortId(KIND[it.table!], it.id!)} ${it.label}`)
    const chars = charsOf(it)
    if (chars !== undefined) lines.push(charsLine(chars))
  }
  for (const it of skipped) {
    lines.push(`- ${it.statusLabel ?? STATUS_LABELS[it.status]} ${it.label}${it.hint ? `: ${it.hint}` : ''}`)
    if (it.candidates?.length) for (const c of it.candidates.slice(0, 5)) lines.push(`    候補: ${c}`)
  }
  for (const it of unwritten) lines.push(`- 書けなかった ${it.label}`)
  if (batchMade) lines.push('- 実行の記録（確認した話・追加した案）を残しました')
  for (const n of built.notes) lines.push(`補足: ${n}`)
  if (opts.failed) {
    const rest = [unwritten.length ? `残りの ${unwritten.length}件` : '', batchLeft ? '実行の記録（確認した話・追加した案）' : '']
      .filter(Boolean)
      .join('と')
    const reason = opts.failed.endsWith('。') ? opts.failed : `${opts.failed}。`
    lines.push(
      `補足: ${rest || '残り'}は書けませんでした。理由: ${reason}同じ呼び出しをもう一度送ると、残りだけ追加します（書けた分は重複として飛ばします）。`,
    )
  }
  if (created.length || batchMade)
    lines.push(`${WHERE[tool]}に、各端末が同期すると出ます。本文（稿）は書き換えていません。`)
  const needsFix = skipped.some((it) => it.status === 'not_found' || it.status === 'ambiguous' || it.status === 'invalid')
  return {
    text: capText(lines.join('\n')),
    isError: !created.length && !batchMade && (needsFix || opts.failed) ? true : undefined,
    structured: {
      created: created.map((it) => {
        const chars = charsOf(it)
        return { id: shortId(KIND[it.table!], it.id!), label: it.label, ...(chars !== undefined ? { chars } : {}) }
      }),
      skipped: [
        ...skipped.map((it) => ({ index: it.index, reason: it.status, ...(it.hint ? { hint: it.hint } : {}) })),
        ...unwritten.map((it) => ({ index: it.index, reason: 'not_written', hint: '書けませんでした（もう一度送ると追加します）' })),
      ],
    },
  }
}
