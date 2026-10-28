// 手動連携（コネクタを使わない）で Claude に渡す依頼文。ワードサーチ（推敲案）・作品批評・戦略の3つ。
// 依頼文と本文（コネクタの novel_read_text と同じ形。src/claude/view.ts）を 50,000 字以内のパートに分けてコピーし、
// Claude には最後に ```novel-studio-v1 のコードブロックで JSON（コネクタの書き込みツールの入力と同じ形）を返してもらう。
// 返ってきた答えは src/claude/paste.ts で読み、同じ作り方（src/claude/records.ts）で記録にする。
import { PROOF_CATEGORIES, PROOF_CATEGORY_LABELS } from './categories'
import { submissionsOf, submissionStatusLabel } from '../domain/entityOps'
import { formatCount } from '../domain/text'
import type { AppData, CritiquePrompt, ID, Title } from '../domain/types'
import { PASTE_FENCE } from './paste'
import { shortId } from './refs'
import { outlineView, readTextPages, type ReadSelection } from './view'

/** 1つのパートの長さの上限（claude.ai の入力欄に貼り付けられる長さ） */
export const MANUAL_PART_CHARS = 50_000

export type ManualTask = 'proofreading' | 'critique' | 'strategy'

export const MANUAL_TASK_LABELS: Record<ManualTask, string> = {
  proofreading: 'ワードサーチ（推敲案）',
  critique: '作品批評',
  strategy: '戦略',
}

const CATEGORY_LINES = PROOF_CATEGORIES.map((c) => `  - ${c} = ${PROOF_CATEGORY_LABELS[c]}`).join('\n')

const TEXT_FORMAT = [
  '## 本文の形',
  '- 各話は「=== #12 第12話　題（第3稿・4,812字・38–40%）[p:3f2a9c1b v:…] ===」の見出しの下にあります（#12 は読む順、% はタイトル全体の中の位置）。',
  '- 幕に分けた話は「--- 第1幕（…）[p:… v:…] ---」の見出しの下に幕ごとにあります（幕は #12.1・#12.2 と指します）。',
  '- ルビは ｜漢字《かんじ》、傍点は 《《強調》》 の記法です（カクヨム式）。文字数は記法とルビの読みを除いて数えています。',
].join('\n')

/** パートの受け取り方（パートが2つ以上の時） */
function partsNotice(n: number): string {
  if (n <= 1) return ''
  return `本文は ${n} 個のパートに分けて送ります。すべてのパートを受け取るまでは「パート k/${n} を受け取りました」とだけ返し、最後のパート（${n}/${n}）を受け取ってから作業を始めてください。`
}

function fence(json: string): string {
  return `\`\`\`${PASTE_FENCE}\n${json}\n\`\`\``
}

const RETURN_RULES = [
  '- JSON はコードブロックの中だけに書き、コードブロックは最後に1つだけにしてください（説明はコードブロックの外に書いてかまいません）。',
  '- 文字列の中の改行は \\n、" は \\" と書いてください。',
].join('\n')

export interface PromptContext {
  title: Pick<Title, 'id' | 'name'>
  /** 範囲の表記（「タイトル全体」「一章」「第1話〜第20話」） */
  rangeLabel: string
  /** パートの数 */
  parts: number
  /** 今日（日本時間の YYYY-MM-DD） */
  today: string
}

/** ワードサーチ（推敲案）の依頼文 */
export function proofreadingPrompt(c: PromptContext): string {
  const tid = shortId('title', c.title.id)
  const example = JSON.stringify({
    tool: 'novel_add_proofreading',
    input: {
      title_id: tid,
      run_label: `ワードサーチ（${c.rangeLabel}）`,
      run_date: c.today,
      covered: ['#1', '#2'],
      items: [
        {
          piece: '#2',
          excerpt: '見れる',
          context_before: '窓から',
          category: 'ra_nuki',
          suggestion: '見られる',
          reason: 'ら抜き言葉',
          important: false,
        },
      ],
    },
  })
  return [
    `あなたは日本語の小説の推敲を手伝う編集者です。これから『${c.title.name}』の採用原稿（${c.rangeLabel}）を送ります。${partsNotice(c.parts)}`,
    '',
    '## 依頼',
    '本文から次のものを洗い出し、推敲案として一覧にしてください。直すかどうかは作者が決めるので、迷うものも挙げてください。',
    '- 作者の癖になっている語・表現（同じ言い回しの多用など）',
    '- 既成表現・手垢のついた表現',
    '- 誤字脱字・変換ミス、ら抜き、い抜き',
    '- 近接重複、表記ゆれ、記号の作法（……・――は偶数個、！？の後の全角空白など）、ルビ・傍点の記法、文法・係り受け',
    '',
    TEXT_FORMAT,
    '',
    '## 返し方',
    `最後に、次の形の JSON を \`\`\`${PASTE_FENCE} のコードブロックに入れて返してください（Novel Studio に貼り付けて取り込みます）。`,
    fence(example),
    '- piece: 見出しの #番号（幕は #12.2）か [p:…] の id',
    '- excerpt: 本文から原文どおりに引用（言い換えない。ルビの記法も含めて100字以内）。アプリが本文の中で場所を探します',
    '- context_before: 同じ箇所が同じ話に何度もある時だけ、その直前の文字（30字以内）',
    '- category: 次の英字のどれか（category_label で名前を変えられます。20字以内）',
    CATEGORY_LINES,
    '- suggestion: 直し方の案（500字以内。無ければ省略）。reason: 短い理由（300字以内）',
    '- important: 特に直した方がよいものだけ true（一覧の一番上に出ます）',
    '- covered: 最後まで確かめた話（指摘が無かった話も含む）',
    `- items は1つの呼び出しで100件まで。多い時はコードブロックの中を [{"tool":…,"input":…}, {"tool":…,"input":…}] の配列にして分けてください。`,
    RETURN_RULES,
  ].join('\n')
}

/** 作品批評の依頼文（批評プロンプトの本文を中に入れる） */
export function critiqueManualPrompt(c: PromptContext & { prompt: Pick<CritiquePrompt, 'id' | 'name' | 'body'> | null; scope?: { from: string; to: string } }): string {
  const example = JSON.stringify({
    tool: 'novel_add_critique_result',
    input: {
      title_id: shortId('title', c.title.id),
      ...(c.prompt ? { prompt_id: shortId('critiquePrompt', c.prompt.id) } : {}),
      run_date: c.today,
      result_markdown: '## 総評\\n…',
      ...(c.scope ? { scope: c.scope } : {}),
    },
  })
  return [
    `これから『${c.title.name}』の採用原稿（${c.rangeLabel}）を送ります。${partsNotice(c.parts)}`,
    '',
    '## 批評の依頼',
    c.prompt ? c.prompt.body.trim() || '（依頼文が空です）' : 'この作品を批評してください。',
    '',
    TEXT_FORMAT,
    '',
    '## 返し方',
    `批評は Markdown で書いてください。最後に、批評の全文を result_markdown に入れた次の形の JSON を \`\`\`${PASTE_FENCE} のコードブロックで返してください（Novel Studio に貼り付けて、作品批評の結果として残します）。`,
    'アーティファクトにした時は、その URL（https）が分かれば artifact_url に入れてください（分からなければ省略。後でアプリから入れられます）。',
    fence(example),
    RETURN_RULES,
  ].join('\n')
}

/** 戦略の依頼文 */
export function strategyPrompt(c: PromptContext): string {
  const tid = shortId('title', c.title.id)
  const example = JSON.stringify([
    {
      tool: 'novel_add_strategy_note',
      input: {
        title_id: tid,
        run_date: c.today,
        heading: '今後の応募戦略',
        body: '## 狙い\\n…',
        contests: [
          {
            name: '〇〇小説大賞',
            organizer: '〇〇',
            url: 'https://example.com/contest',
            deadline: '2027-03-31',
            limit: { min: 80000, max: 150000, unit: 'chars' },
            fit: 'この作品と合う理由',
            plan: '応募までの改稿の方針',
          },
        ],
      },
    },
    { tool: 'novel_add_revision_ideas', input: { title_id: tid, items: [{ heading: '改稿案の見出し', body: '案の中身', pieces: ['#12'] }] } },
  ])
  return [
    `これから『${c.title.name}』の目次・あらすじ・全体戦略・応募計画と、採用原稿（${c.rangeLabel}）を送ります。今日は ${c.today}（日本時間）です。${partsNotice(c.parts)}`,
    '',
    '## 依頼',
    'この作品の今後の戦略（狙うコンテスト・レーベル、応募までの改稿の方針、締切から逆算した予定など）を考えてください。',
    'コンテストの締切・規定（文字数・枚数）は、できるだけ最新の公式の情報を確かめ、URL を添えてください。確かめられない時はそう書いてください。',
    '',
    TEXT_FORMAT,
    '',
    '## 返し方',
    `戦略は Markdown で書き、最後に次の形の JSON を \`\`\`${PASTE_FENCE} のコードブロックで返してください（Novel Studio の戦略に「戦略メモ」として残り、コンテストは応募計画にできます）。`,
    '改稿の具体的な案があれば、例のように novel_add_revision_ideas も配列に足してください（無ければ省略）。',
    fence(example),
    '- contests は10件まで。limit の unit は chars（文字数）か pages（400字詰め原稿用紙の枚数）。分からない項目は省略',
    RETURN_RULES,
  ].join('\n')
}

/** 戦略の材料（全体戦略・応募計画）。目次とあらすじは outlineView */
function strategyMaterial(data: AppData, title: Title): string {
  const lines: string[] = ['=== 全体戦略 ===', title.strategyNote.trim() || '（まだ書いていません）', '=== 応募計画 ===']
  const subs = submissionsOf(data, title.id)
  if (!subs.length) lines.push('（まだありません）')
  for (const s of subs) {
    const limit =
      s.minChars !== null || s.maxChars !== null
        ? `・規定 ${s.minChars !== null ? formatCount(s.minChars) : ''}〜${s.maxChars !== null ? formatCount(s.maxChars) : ''}${s.limitUnit === 'pages' ? '枚' : '字'}`
        : ''
    lines.push(`- ${s.contestName.trim() || '（コンテスト名未設定）'}（${submissionStatusLabel(s.status)}${s.deadline ? `・締切 ${s.deadline}` : ''}${limit}）${s.url ? ` ${s.url}` : ''}`)
  }
  return lines.join('\n')
}

export interface ManualPartsOptions {
  task: ManualTask
  /** 読む範囲（省略でタイトル全体） */
  selection?: Omit<ReadSelection, 'versionId'>
  /** 範囲の表記（「タイトル全体」「一章」「第1話〜第20話」） */
  rangeLabel?: string
  /** 作品批評の範囲（批評の結果の scope。省略時は selection の from・to） */
  scope?: { from: string; to: string }
  /** 作品批評のプロンプト */
  prompt?: Pick<CritiquePrompt, 'id' | 'name' | 'body'> | null
  /** 今日（日本時間の YYYY-MM-DD） */
  today: string
  /** 戦略で本文も送るか（既定 true。false なら目次・戦略だけ） */
  includeText?: boolean
  /** パートの長さの上限（既定 50,000） */
  partChars?: number
}

export type ManualPartsResult =
  | { ok: true; parts: string[]; totalChars: number; rangeLabel: string }
  | { ok: false; error: string; candidates?: string[] }

/** パートの見出し・終わりの印に使う長さの見込み */
const PART_OVERHEAD = 200

function chunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + size)
    // サロゲートペアの途中で切らない
    const c = text.charCodeAt(end)
    if (end < text.length && c >= 0xdc00 && c <= 0xdfff) end -= 1
    out.push(text.slice(i, end))
    i = end
  }
  return out.length ? out : ['']
}

/**
 * 依頼文と本文をパートに分ける（各パートは partChars 字以内）。1つ目のパートに依頼文を入れ、
 * 各パートの先頭に「【Novel Studio パート 1/6】」、終わりに「【パート 1/6 の終わり。続きがあります】」
 * （最後のパートは「【全 6 パートの終わり。…】」）を付ける。本文の形は novel_read_text と同じ
 */
export function buildManualParts(data: AppData, titleId: ID, opts: ManualPartsOptions): ManualPartsResult {
  const title = data.titles[titleId]
  if (!title) return { ok: false, error: 'タイトルが見つかりません' }
  const partChars = Math.max(5_000, opts.partChars ?? MANUAL_PART_CHARS)
  const room = partChars - PART_OVERHEAD
  const rangeLabel = opts.rangeLabel?.trim() || 'タイトル全体'
  // 批評はルビの読みを除いて読む（読みやすさのため）。推敲案は記法込みのまま（抜き出しが本文と合うように）
  const sel: ReadSelection = { ...(opts.selection ?? {}), ruby: opts.task === 'critique' ? 'strip' : 'raw' }
  const scope = opts.scope ?? (sel.from && sel.to ? { from: sel.from, to: sel.to } : undefined)
  // 戦略は目次・全体戦略・応募計画を本文の前に入れる
  let material = ''
  if (opts.task === 'strategy') {
    const outline = outlineView(data, titleId, { maxRows: 100_000, includeActs: false })
    material = `=== 目次 ===\n${outline.ok ? outline.text : ''}\n${strategyMaterial(data, title)}`
  }
  const headOf = (parts: number) => {
    const c: PromptContext = { title, rangeLabel, parts, today: opts.today }
    const prompt =
      opts.task === 'proofreading'
        ? proofreadingPrompt(c)
        : opts.task === 'critique'
          ? critiqueManualPrompt({ ...c, prompt: opts.prompt ?? null, scope })
          : strategyPrompt(c)
    return material ? `${prompt}\n\n${material}` : prompt
  }
  const withText = opts.task !== 'strategy' || opts.includeText !== false
  // パートの数で依頼文の長さが数字の分だけ変わるので、多めの数で見積もる
  const estimate = headOf(999)
  /** 依頼文の後に本文を入れる余裕が無ければ、依頼文だけのパートにする */
  const headAlone = estimate.length + 2 + 2_000 > room
  let pages: string[] = []
  if (withText) {
    const r = readTextPages(data, titleId, sel, room, headAlone ? room : room - estimate.length - 2)
    if (!r.ok) return r
    pages = r.pages
  }
  let bodies: string[] = []
  let n = headAlone ? chunks(estimate, room).length + pages.length : Math.max(1, pages.length)
  for (let tries = 0; tries < 3; tries++) {
    const head = headOf(n)
    bodies = headAlone ? [...chunks(head, room), ...pages] : [pages.length ? `${head}\n\n${pages[0]}` : head, ...pages.slice(1)]
    if (bodies.length === n) break
    n = bodies.length
  }
  const total = bodies.length
  const parts = bodies.map((b, i) => {
    const top = `【Novel Studio パート ${i + 1}/${total}】`
    const end =
      i === total - 1 ? `【全 ${total} パートの終わり。依頼に取りかかってください】` : `【パート ${i + 1}/${total} の終わり。続きがあります】`
    return `${top}\n${b}\n${end}`
  })
  return { ok: true, parts, totalChars: parts.reduce((a, p) => a + p.length, 0), rangeLabel }
}

/**
 * コネクタを使う時に Claude へ渡す批評の依頼（作品批評の「Claude 用にコピー」）。本文はコネクタで読んでもらい、
 * 結果は novel_add_critique_result で記録してもらう
 */
export function critiqueConnectorPrompt(title: Pick<Title, 'id' | 'name'>, prompt: Pick<CritiquePrompt, 'id' | 'name' | 'body'>): string {
  return [
    `Novel Studio コネクタで『${title.name}』[${shortId('title', title.id)}] の採用原稿を読み（novel_read_text。ruby は strip で）、次の依頼のとおりに批評してください。`,
    '',
    '## 批評の依頼',
    prompt.body.trim() || '（依頼文が空です）',
    '',
    '## 記録',
    `批評が終わったら、novel_add_critique_result で結果を記録してください（prompt_id は ${shortId('critiquePrompt', prompt.id)}、result_markdown に批評の全文）。`,
    'タイトル全体が一度に読めない時は、範囲（scope）ごとに記録してから、まとめの批評も記録してください。',
    '',
    `（コネクタを使わない時は、Novel Studio の「Claude に頼む（手動）」でコピーした本文と一緒に送ってください。結果は最後に \`\`\`${PASTE_FENCE} のコードブロックで返してもらいます）`,
  ].join('\n')
}
