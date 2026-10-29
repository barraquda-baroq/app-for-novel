// ツールの入力の形（zod）。実行時は使わず、scripts/gen-schemas.mjs が JSON Schema（{ io: 'input' }）にして
// schemas.gen.ts に書き出す（Workers で zod から作り直すと CPU を使うため）。test/unit/schemas.test.ts が一致を確かめる。
// 上限の数は src/claude/records.ts の RECORD_LIMITS と同じ（アプリの貼り付けと同じ確かめ方）。
import * as z from 'zod'
import { PROOF_CATEGORIES, PROOF_CATEGORY_GUIDE } from '../../../src/claude/categories'
import { RECORD_LIMITS as L } from '../../../src/claude/records'

const titleId = z
  .string()
  .min(1)
  .max(200)
  .describe('タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる')
const piece = z
  .string()
  .min(1)
  .max(200)
  .describe('話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」')
const fromRef = piece.describe('範囲の最初の話（#1・p:…・「第1話」など。省略時は最初から）')
const toRef = piece.describe('範囲の最後の話（含む。省略時は最後まで）')
const chapter = z.string().min(1).max(200).describe('章だけにする（c:… の短い id か章の名前）')
const cursor = z.string().min(1).max(4000).describe('前の結果の最後にある 続き: cursor="…" の値をそのまま渡す')
const format = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('concise = 要点だけ（既定）、detailed = 日付・理由なども出す')
const runDate = z.string().max(10).describe('YYYY-MM-DD（日本時間）。省略時は今日')
const model = z.string().max(L.model).describe('使ったモデルの名前（任意）')

export const SCHEMAS = {
  novel_status: z.object({}),
  novel_list_titles: z.object({}),
  novel_get_outline: z.object({
    title_id: titleId,
    chapter: chapter.optional(),
    from: fromRef.optional(),
    to: toRef.optional(),
    include_acts: z.boolean().default(true).describe('幕に分けた話の幕の行も出す（既定 true）'),
    response_format: format,
    cursor: cursor.optional(),
  }),
  novel_read_text: z.object({
    title_id: titleId,
    chapter: chapter.optional(),
    from: fromRef.optional(),
    to: toRef.optional(),
    pieces: z.array(piece).max(50).optional().describe('読む話を並べて指定する（50件まで。幕も指せる）'),
    version_id: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('この稿だけを読む（v:… の短い id。採用していない稿も読める。novel_list_versions で確かめる）'),
    cursor: cursor.optional(),
    char_budget: z
      .number()
      .int()
      .min(2_000)
      .max(60_000)
      .default(20_000)
      .describe('1回に返す文字数の目安（2,000〜60,000。既定 20,000。Claude Code では 12,000）'),
    ruby: z
      .enum(['raw', 'strip'])
      .default('raw')
      .describe('raw = ルビ・傍点の記法のまま（既定。推敲案の引用はこちらから）、strip = 記法と読みを除く（批評で読む時）'),
  }),
  novel_list_versions: z.object({
    title_id: titleId.optional().describe('タイトル（#12・「第12話」で指す時は必要。p:… の短い id なら省略できる）'),
    piece,
  }),
  novel_search_text: z.object({
    title_id: titleId,
    query: z.string().min(1).max(200).describe('探す言葉（200字まで）。ルビの記法と読みを除いた本文で探す'),
    mode: z.enum(['literal', 'regex']).default('literal').describe('literal = そのまま（既定）、regex = 正規表現（JavaScript）'),
    scope: z
      .enum(['adopted', 'all_versions'])
      .default('adopted')
      .describe('adopted = 採用原稿（既定）、all_versions = すべての稿'),
    from: fromRef.optional(),
    to: toRef.optional(),
    context_chars: z.number().int().min(0).max(80).default(25).describe('一致の前後に出す文字数（既定 25）'),
    max_hits: z.number().int().min(1).max(200).default(40).describe('1回に出す一致の数（既定 40）'),
    count_only: z.boolean().default(false).describe('true = 話ごとの件数だけ'),
    cursor: cursor.optional(),
  }),
  novel_get_notes: z.object({
    title_id: titleId,
    kind: z.enum(['settings', 'memos', 'ideas']).describe('settings = 設定項目（キャラクター・世界観など）、memos = メモ、ideas = アイデア'),
    ids: z.array(z.string().min(1).max(200)).max(50).optional().describe('本文まで読む項目（e:・m:・i: の短い id か名前）'),
    full: z.boolean().default(false).describe('true = すべての本文を読む（char_budget まで）'),
    char_budget: z.number().int().min(2_000).max(60_000).default(20_000).describe('本文を返す文字数の上限（既定 20,000）'),
    cursor: cursor.optional(),
  }),
  novel_get_strategy: z.object({
    title_id: titleId,
    submission_id: z.string().min(1).max(200).optional().describe('この応募計画（o:…）を詳しく'),
    note_id: z.string().min(1).max(200).optional().describe('この戦略メモ（g:…）を全文で'),
    revision_idea_id: z.string().min(1).max(200).optional().describe('この改稿案（r:…）を全文で'),
  }),
  novel_get_critique: z.object({
    title_id: titleId,
    prompt_id: z.string().min(1).max(200).optional().describe('この批評プロンプト（q:…）を全文で'),
    result_id: z.string().min(1).max(200).optional().describe('この批評の結果（a:…）を全文で'),
  }),
  novel_list_proofreading: z.object({
    title_id: titleId,
    status: z.enum(['open', 'done', 'all']).default('open').describe('open = チェックしていない案（既定）、done = チェックした案、all = すべて'),
    category: z.enum(PROOF_CATEGORIES as [string, ...string[]]).optional().describe(`種類だけにする（${PROOF_CATEGORY_GUIDE}）`),
    from: fromRef.optional(),
    to: toRef.optional(),
    run_id: z.string().min(1).max(200).optional().describe('この実行（ワードサーチ）の案だけ'),
    response_format: format,
    cursor: cursor.optional(),
  }),
  novel_add_proofreading: z.object({
    title_id: titleId,
    run_label: z.string().max(L.runLabel).optional().describe('一連の推敲の名前（例: ワードサーチ（第1〜20話））'),
    run_date: runDate.optional(),
    covered: z
      .array(piece)
      .max(L.proofCovered)
      .optional()
      .describe('確認し終えた話（推敲案が無かった話も入れる。#12・p:…）'),
    items: z
      .array(
        z.object({
          piece,
          excerpt: z
            .string()
            .min(1)
            .max(L.excerpt)
            .describe('その話・幕の採用原稿から原文どおりに引用した箇所（ルビの記法も含める。100字以内）'),
          context_before: z
            .string()
            .max(L.contextBefore)
            .optional()
            .describe('同じ箇所が何度もある時に区別する、引用の直前の文字（30字以内）'),
          category: z.enum(PROOF_CATEGORIES as [string, ...string[]]).describe(PROOF_CATEGORY_GUIDE),
          category_label: z.string().max(L.categoryLabel).optional().describe('種類の表示名（other の時の名前など）'),
          suggestion: z.string().max(L.suggestion).optional().describe('直し案（無ければ空）'),
          reason: z.string().min(1).max(L.reason).describe('短い説明'),
          important: z.boolean().default(false).describe('true = 重要（アプリでフラグを立てて最上位に出す）'),
        }),
      )
      .max(L.proofItems)
      .describe('推敲案（1回100件まで）'),
    model: model.optional(),
  }),
  novel_add_revision_ideas: z.object({
    title_id: titleId,
    items: z
      .array(
        z.object({
          heading: z.string().min(1).max(L.revisionHeading).describe('改稿案の見出し（80字以内）'),
          body: z.string().min(1).max(L.revisionBody).describe('改稿案の本文（ワンシーン丸ごとでもよい。50,000字まで）'),
          pieces: z.array(piece).max(L.revisionPieces).optional().describe('関係する話（#12・p:…）'),
        }),
      )
      .max(L.revisionItems)
      .describe('改稿案（1回20件まで）'),
  }),
  novel_add_strategy_note: z.object({
    title_id: titleId,
    heading: z.string().min(1).max(L.noteHeading).describe('戦略メモの見出し（80字以内）'),
    body: z.string().min(1).max(L.noteBody).describe('本文（Markdown。30,000字まで）'),
    run_date: runDate.optional(),
    contests: z
      .array(
        z.object({
          name: z.string().min(1).max(L.contestName).describe('コンテスト・賞の名前'),
          organizer: z.string().max(L.contestOrganizer).optional().describe('主催'),
          url: z.string().max(L.url).optional().describe('募集要項の URL（https）'),
          deadline: z.string().max(10).optional().describe('締切（YYYY-MM-DD）'),
          limit: z
            .object({
              min: z.number().int().min(0).optional().describe('下限'),
              max: z.number().int().min(0).optional().describe('上限'),
              unit: z.enum(['chars', 'pages']).optional().describe('chars = 文字数、pages = 400字詰め原稿用紙の枚数'),
            })
            .optional()
            .describe('規定の長さ'),
          fit: z.string().max(L.contestFit).optional().describe('このタイトルとの相性（300字以内）'),
          plan: z.string().max(L.contestPlan).optional().describe('応募までの改稿の方針（2,000字以内）'),
        }),
      )
      .max(L.contests)
      .optional()
      .describe('狙うコンテストの候補（10件まで）。アプリで「応募計画にする」を押すと応募計画になる'),
    model: model.optional(),
  }),
  novel_save_critique_prompt: z.object({
    title_id: titleId.optional().describe('scope が title の時のタイトル'),
    scope: z.enum(['title', 'shared']).describe('title = このタイトルの批評プロンプト、shared = どのタイトルでも使う共通のもの'),
    name: z.string().min(1).max(L.promptName).describe('プロンプトの名前（60字以内）'),
    body: z.string().min(1).max(L.promptBody).describe('プロンプトの本文（20,000字まで）'),
  }),
  novel_add_critique_result: z.object({
    title_id: titleId,
    prompt_id: z.string().min(1).max(200).optional().describe('使った批評プロンプト（q:… か名前）'),
    prompt_text: z.string().max(L.promptBody).optional().describe('実際に使ったプロンプト（省略時は prompt_id の本文）'),
    result_markdown: z.string().max(L.resultMarkdown).optional().describe('批評の結果（Markdown。60,000字まで）'),
    artifact_url: z.string().max(L.url).optional().describe('結果のアーティファクトの URL（https）'),
    run_date: runDate.optional(),
    scope: z
      .object({ from: piece, to: piece })
      .optional()
      .describe('批評した範囲（省略時はタイトル全体）'),
    model: model.optional(),
  }),
} as const

export type ToolName = keyof typeof SCHEMAS

/** 書き込みツールの結果（structuredContent）の形 */
export const WRITE_OUTPUT = z.object({
  created: z.array(z.object({ id: z.string(), label: z.string() })),
  skipped: z.array(z.object({ index: z.number().int(), reason: z.string(), hint: z.string().optional() })),
})
