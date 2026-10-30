// 手動連携の「結果を貼り付け」。Claude の答えの最後の ```novel-studio-v1 のコードブロックの JSON を読み、
// コネクタと同じ作り方（src/claude/records.ts）で記録にする（source = 'paste'。id は内容から作るので、2回貼り付けても増えない）。
// JSON の形は、コネクタの書き込みツールの呼び出し {"tool": "novel_add_proofreading", "input": {…}}、またはその配列。
// 作品批評は、コードブロックが無ければ答えの Markdown をそのまま結果として受け付ける（URL は画面で入れる。コードブロックの
// 結果に artifact_url が無い時も、画面で入れた URL を使う）。
// 相対比較の作品の画面（2.5）では、novel_add_bench_analysis の work をその作品にして受け付ける（new_work は使わない）。
import type { AppData, ClaudeTableName, ID } from '../domain/types'
import {
  buildToolCall,
  isWriteTool,
  summarizeItems,
  trashedBenchNamesOf,
  trashedIdsOf,
  WRITE_TOOL_LABELS,
  type BuildResult,
  type NewRecord,
  type WriteTool,
  type WriteToolCall,
} from './records'

/** コードブロックの名前（```novel-studio-v1） */
export const PASTE_FENCE = 'novel-studio-v1'

/** 1回に貼り付けられる呼び出しの数 */
export const MAX_PASTE_CALLS = 20

export type ExtractResult = { ok: true; json: string; fenced: boolean } | { ok: false; error: string }

/**
 * 貼り付けた文から、最後の ```novel-studio-v1 のコードブロックの中身を取り出す（~~~ のコードブロックも可。
 * 閉じていなければ終わりまで）。コードブロックが無く、文全体が JSON（{ か [ で始まる）ならそれを使う
 */
export function extractBlock(text: string): ExtractResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let open = -1
  let marker = ''
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(lines[i])
    if (m && m[2].toLowerCase() === PASTE_FENCE) {
      open = i
      marker = m[1]
    }
  }
  if (open < 0) {
    const t = text.trim()
    if (t.startsWith('{') || t.startsWith('[')) return { ok: true, json: t, fenced: false }
    return {
      ok: false,
      error: `\`\`\`${PASTE_FENCE} のコードブロックが見つかりません。Claude の答えを最後までコピーして貼り付けてください`,
    }
  }
  const body: string[] = []
  for (let i = open + 1; i < lines.length; i++) {
    const close = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
    if (close.test(lines[i])) return { ok: true, json: body.join('\n'), fenced: true }
    body.push(lines[i])
  }
  return { ok: true, json: body.join('\n'), fenced: true }
}

export type ParseCallsResult = { ok: true; calls: WriteToolCall[] } | { ok: false; error: string }

/** JSON を書き込みツールの呼び出しの並びにする（{tool, input}・その配列・{calls: […]}。input が無ければ tool 以外の項目を input に） */
export function parseCalls(json: string): ParseCallsResult {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch (e) {
    return {
      ok: false,
      error: `JSON として読めません（${e instanceof Error ? e.message : String(e)}）。コードブロックが途中で切れていないか確かめてください`,
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { calls?: unknown }).calls))
    v = (v as { calls: unknown[] }).calls
  const list = Array.isArray(v) ? v : [v]
  if (!list.length) return { ok: false, error: '呼び出しが1つもありません' }
  if (list.length > MAX_PASTE_CALLS) return { ok: false, error: `1回に貼り付けられるのは ${MAX_PASTE_CALLS} 個までです` }
  const calls: WriteToolCall[] = []
  for (const [i, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ok: false, error: `${i + 1}つ目の形が違います（{"tool": …, "input": {…}}）` }
    const o = raw as Record<string, unknown>
    if (!isWriteTool(o.tool))
      return {
        ok: false,
        error: `${i + 1}つ目の tool '${String(o.tool)}' は使えません（使えるもの: ${Object.keys(WRITE_TOOL_LABELS).join(', ')}）`,
      }
    let input = o.input
    if (input === undefined) {
      const { tool: _tool, ...rest } = o
      void _tool
      input = rest
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return { ok: false, error: `${i + 1}つ目の input の形が違います` }
    calls.push({ tool: o.tool, input } as WriteToolCall)
  }
  return { ok: true, calls }
}

export interface PasteOptions {
  /** 貼り付けたタイトル（JSON の title_id はこれに置き換える）。相対比較の作品の画面では無い */
  titleId?: ID
  /** 貼り付けた相対比較の作品（JSON の work はこれに置き換える。作品の画面） */
  benchWorkId?: ID
  now: number
  /** 受け付ける書き込みツール（省略ですべて） */
  expect?: readonly WriteTool[]
  /**
   * 作品批評: コードブロックが無ければ、貼り付けた文を Markdown の結果として受け付ける（promptId はその批評プロンプト、
   * artifactUrl は画面で入れた URL）。コードブロックがあっても、作品批評の結果に artifact_url が無ければ artifactUrl を使う
   */
  plainCritique?: { promptId?: ID | null; artifactUrl?: string; runDate?: string }
}

export interface PasteCallPreview {
  tool: WriteTool
  /** 「推敲案を追加」 */
  label: string
  result: BuildResult
  /** 「追加 12件・重複 3件」 */
  summary: string
}

export type PastePreview =
  | {
      ok: true
      calls: PasteCallPreview[]
      /** ［追加］で作る記録（重なりを除いたもの） */
      records: NewRecord[]
      /** 作る記録の数 */
      created: number
      /** コードブロックが無く、文全体を作品批評の結果にした */
      plain: boolean
    }
  | { ok: false; error: string }

/**
 * 貼り付けた文を読み、作る記録と1件ごとの結果（created / duplicate / previously_deleted / not_found / ambiguous / invalid）を返す。
 * データは変えない（［追加］でストアの addClaudeRecords に records を渡す）
 */
export function previewPaste(data: AppData, text: string, opts: PasteOptions): PastePreview {
  if (opts.titleId !== undefined && !data.titles[opts.titleId]) return { ok: false, error: 'タイトルが見つかりません' }
  if (opts.benchWorkId !== undefined && !data.benchWorks[opts.benchWorkId])
    return { ok: false, error: '相対比較の作品が見つかりません' }
  let calls: WriteToolCall[]
  let plain = false
  const block = extractBlock(text)
  if (block.ok) {
    const parsed = parseCalls(block.json)
    if (!parsed.ok) return parsed
    // 作品批評: 答えに artifact_url が無ければ、画面で入れた URL を使う（https かは1件ごとの確かめで見る）
    const typedUrl = opts.plainCritique?.artifactUrl?.trim()
    calls = typedUrl
      ? parsed.calls.map((c) => {
          if (c.tool !== 'novel_add_critique_result') return c
          const u = (c.input as { artifact_url?: unknown }).artifact_url
          return u === undefined || u === null || u === ''
            ? ({ ...c, input: { ...c.input, artifact_url: typedUrl } } as WriteToolCall)
            : c
        })
      : parsed.calls
  } else if (opts.plainCritique && opts.titleId && (text.trim() || opts.plainCritique.artifactUrl?.trim())) {
    plain = true
    calls = [
      {
        tool: 'novel_add_critique_result',
        input: {
          title_id: opts.titleId,
          ...(opts.plainCritique.promptId ? { prompt_id: opts.plainCritique.promptId } : {}),
          ...(text.trim() ? { result_markdown: text.trim() } : {}),
          ...(opts.plainCritique.artifactUrl?.trim() ? { artifact_url: opts.plainCritique.artifactUrl.trim() } : {}),
          ...(opts.plainCritique.runDate ? { run_date: opts.plainCritique.runDate } : {}),
        },
      },
    ]
  } else return { ok: false, error: block.error }
  if (opts.expect) {
    const bad = calls.find((c) => !opts.expect!.includes(c.tool))
    if (bad)
      return {
        ok: false,
        error: `ここでは「${opts.expect.map((t) => WRITE_TOOL_LABELS[t]).join('」「')}」だけを貼り付けられます（貼り付けた答えは「${WRITE_TOOL_LABELS[bad.tool]}」）`,
      }
  }
  const ctx = {
    source: 'paste' as const,
    now: opts.now,
    wasDeleted: trashedIdsOf(data),
    trashedBenchWorkNamed: trashedBenchNamesOf(data),
  }
  const previews: PasteCallPreview[] = []
  const records: NewRecord[] = []
  const seen = new Set<string>()
  for (const call of calls) {
    let result: BuildResult
    if (call.tool === 'novel_add_bench_analysis') {
      // 相対比較の作品の画面ではその作品に書く（相対比較に無い作品を作る new_work は使わない）
      const input = opts.benchWorkId ? { ...call.input, work: opts.benchWorkId, new_work: undefined } : call.input
      result = buildToolCall(data, { tool: call.tool, input } as WriteToolCall, ctx)
    } else if (opts.titleId) {
      // 貼り付けた画面のタイトルに書く（共通の批評プロンプトは title_id を使わない）
      const input = { ...call.input, title_id: opts.titleId } as typeof call.input
      result = buildToolCall(data, { tool: call.tool, input } as WriteToolCall, ctx)
    } else {
      result = {
        ok: false,
        error: `「${WRITE_TOOL_LABELS[call.tool]}」は、タイトルの画面の「結果を貼り付け」で貼り付けてください`,
        records: [],
        items: [],
        notes: [],
      }
    }
    for (const r of result.records) {
      const key = `${r.table}:${r.record.id}`
      if (seen.has(key)) {
        const item = result.items.find((x) => x.id === r.record.id && x.status === 'created')
        if (item) {
          item.status = 'duplicate'
          item.hint = '同じ貼り付けの中で重なっています'
        }
        continue
      }
      seen.add(key)
      records.push(r)
    }
    previews.push({
      tool: call.tool,
      label: WRITE_TOOL_LABELS[call.tool],
      result,
      summary: result.ok ? summarizeItems(result.items) : (result.error ?? ''),
    })
  }
  // 推敲案の実行の記録・分析と一緒に作る相対比較の作品は数えない（追加する推敲案・分析などの数）
  const created = records.filter((r) => r.table !== 'proofBatches' && r.table !== 'benchWorks').length
  return { ok: true, calls: previews, records, created, plain }
}

/** 作る記録の id（表ごと）。［追加］の後に「n件を追加しました」を出すのに使う */
export function recordKeys(records: readonly NewRecord[]): { table: ClaudeTableName; id: ID }[] {
  return records.map((r) => ({ table: r.table, id: r.record.id }))
}
