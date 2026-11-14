// 相対比較（2.5。内部名は bench）の作品と分析を Claude に渡す形（コネクタの読むツール・手動連携の依頼文で同じものを使う）と、作品の指し方。
// - 作品は短い id（w:3f2a9c1b）・id・作品名そのもの（前後や続く空白・全角と半角・Unicode の正規化の違いは問わない。refs.ts の
//   refKey。タイトル名で指す時と同じ）で指せる
// - ベンチ作品はどのタイトルにも属さない利用者の覚え書きなので、タイトルの「Claude に見せる」とは関係なく見せる
// - 作品のタグ（ジャンル。2.7）は「タグ: 恋愛・青春」の行で見せる。「14 検索用タグ」からアプリがまだ付けていない自動のタグも
//   含める（benchTags.ts の benchWorkTagsWithAuto。どの端末もアプリを開く前でも、アプリが付けるものと同じタグが見える）
import { benchWorkName, sortedBenchWorks, titlesComparing } from '../domain/benchOps'
import { benchWorkTagsWithAuto } from '../domain/benchTags'
import { formatCount } from '../domain/text'
import type { AppData, BenchAnalysis, BenchWork, ID } from '../domain/types'
import { benchAnalysesOf, benchViewpointGroups } from './benchOrder'
import { matchesId, refKey, shortId, type Resolved } from './refs'
import { joinBlocks, type TextBlock } from './resume'
import { pendingTrashCount, pendingTrashLine } from './trashTargets'

const norm = (s: string) => s.normalize('NFC').trim()

/** 作品の指し方（w:… の短い id・id・作品名）から作品を探す */
export function resolveBenchWork(data: Pick<AppData, 'benchWorks'>, ref: string): Resolved<BenchWork> {
  const works = sortedBenchWorks(data)
  const byId = works.filter((w) => matchesId('benchWork', ref, w.id))
  const key = refKey(ref)
  const hits = byId.length ? byId : works.filter((w) => refKey(w.name) === key)
  if (hits.length === 1) return { ok: true, value: hits[0] }
  const candidates = (hits.length ? hits : works).slice(0, 30).map((w) => benchWorkRef(w))
  return hits.length
    ? {
        ok: false,
        reason: 'ambiguous',
        message: `相対比較に作品名「${ref}」の作品が${hits.length}件あります。w:… の短い id で指してください`,
        candidates,
      }
    : { ok: false, reason: 'not_found', message: `相対比較の作品 '${ref}' が見つかりません`, candidates }
}

/** 「w:3f2a9c1b『作品名』（著者）」 */
export function benchWorkRef(w: Pick<BenchWork, 'id' | 'name' | 'author'>): string {
  return `${shortId('benchWork', w.id)}『${benchWorkName(w)}』${w.author.trim() ? `（${w.author.trim()}）` : ''}`
}

/** 作品の書誌（「著者・出版社・2019・ミステリー」。無い項目は飛ばす） */
export function benchWorkBiblio(w: BenchWork): string {
  return [w.author, w.publisher, w.year, w.genre]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .join('・')
}

/** 作品のタグ（付けた順。アプリがまだ付けていない「14 検索用タグ」の自動のタグも含める） */
export function benchWorkTagList(data: Pick<AppData, 'benchAnalyses'>, w: BenchWork): string[] {
  return benchWorkTagsWithAuto(data, w)
}

/** 「タグ: 恋愛・青春・喪失」（タグが無ければ空） */
export function benchWorkTagsLine(data: Pick<AppData, 'benchAnalyses'>, w: BenchWork): string {
  const tags = benchWorkTagList(data, w)
  return tags.length ? `タグ: ${tags.join('・')}` : ''
}

/** 観点ごとの数と最新の日付（「構成 2件（最新 2026-10-30）」） */
export function viewpointSummary(analyses: readonly BenchAnalysis[]): string {
  return benchViewpointGroups(analyses)
    .map((g) => `${g.viewpoint} ${g.items.length}件（最新 ${g.items[0]?.runDate || '日付なし'}）`)
    .join('・')
}

/** 観点の名前だけ（「構成・文体・人物」） */
export function viewpointNames(analyses: readonly BenchAnalysis[]): string[] {
  return benchViewpointGroups(analyses).map((g) => g.viewpoint)
}

/** 観点で絞る（前後の空白・正規化の違いは問わない。空なら絞らない） */
export function filterByViewpoints(
  analyses: readonly BenchAnalysis[],
  viewpoints: readonly string[] | undefined,
): BenchAnalysis[] {
  const want = new Set((viewpoints ?? []).map(norm).filter(Boolean))
  return want.size ? analyses.filter((a) => want.has(norm(a.viewpoint))) : [...analyses]
}

/** 1つの分析の見出しと本文（「#### 構成（2026-10-30・Claude）[n:…]」＋本文） */
export function analysisText(a: BenchAnalysis): string {
  const by = a.source === 'claude' ? 'Claude' : a.source === 'paste' ? 'Claude（貼り付け）' : '手で記録'
  return `#### ${a.viewpoint.trim() || '観点なし'}（${a.runDate || '日付なし'}・${by}${a.model ? `・${a.model}` : ''}）[${shortId('benchAnalysis', a.id)}]\n${a.body.trim() || '（本文なし）'}`
}

/**
 * 作品の分析を全部つないだ文（手動連携の依頼文と、コネクタで1つの作品の分析を読む時）。観点ごとに、新しい日付から。
 * 頭は見出し・書誌の行・タグの行（タグは書誌の行に入れず、別の行にする。書誌の行は「著者・出版社・刊行年・ジャンル」のまま）
 */
export function workAnalysesText(data: Pick<AppData, 'benchAnalyses'>, work: BenchWork, viewpoints?: readonly string[]): string {
  return workAnalysesBlocks(data, work, viewpoints).text
}

/**
 * workAnalysesText と同じ文と、その中の分析ごとの位置（コネクタで続きを読む時に、読んでいた分析を id で探し直す。resume.ts）。
 * 頭（見出し・書誌・タグの行）は key '' の区切り
 */
export function workAnalysesBlocks(
  data: Pick<AppData, 'benchAnalyses'>,
  work: BenchWork,
  viewpoints?: readonly string[],
): { text: string; blocks: TextBlock[] } {
  const list = filterByViewpoints(benchAnalysesOf(data, work.id), viewpoints)
  const head = [`=== 相対比較の作品 ${benchWorkRef(work)} ===`, benchWorkBiblio(work), benchWorkTagsLine(data, work)]
    .filter(Boolean)
    .join('\n')
  if (!list.length)
    return {
      text: `${head}\n（${viewpoints?.length ? 'この観点の' : ''}分析はまだありません）`,
      blocks: [{ key: '', from: 0, start: 0, text: head }],
    }
  return joinBlocks(
    head,
    benchViewpointGroups(list).map((g) => ({
      title: `--- 観点「${g.viewpoint}」（${g.items.length}件）---`,
      items: g.items.map((a) => ({ key: a.id, text: analysisText(a) })),
    })),
  )
}

/** 手動連携の作品批評に足す、相対比較する作品の分析（無ければ空） */
export function comparisonMaterial(data: AppData, workIds: readonly ID[]): string {
  const works = workIds.map((id) => data.benchWorks[id]).filter((w): w is BenchWork => Boolean(w))
  if (!works.length) return ''
  const lines = [
    `=== 相対比較する作品の分析（${works.length}作品）===`,
    '作者が比べたい既存の作品について、以前に Claude が作品の PDF から分析した内容です。批評の中で、これらの作品と比べてください（分析にない内容は推測しないでください）。',
  ]
  for (const w of works) lines.push('', workAnalysesText(data, w))
  return lines.join('\n')
}

/**
 * 作品の1行（一覧用。「w:…『作品名』（著者）…」の下に、タグがあれば「  タグ: 恋愛・青春」、「  分析 3件: 構成 2件（最新 …）・…」、
 * ゴミ箱へ移す依頼中のカードの数、PDF の置き場所、比べるタイトル）。data が Claude に見せる内容（claudeView）なら、
 * 依頼中の分析は分析の数に入らない
 */
export function benchWorkLine(data: AppData, w: BenchWork): string {
  const analyses = benchAnalysesOf(data, w.id)
  const titles = titlesComparing(data, w.id)
  // 「  分析 n件（n字）」の字数だけは、空白・改行も数えたコードポイントのまま（名作分析のプロンプト V30 が読む行なので、2.7 から
  // 1字も変えない。アプリの「合計 n字」・資料の「  記録 n件（n字）」・追加の答えの「字数: 」はアプリの数え方）
  const total = analyses.reduce((n, a) => n + Array.from(a.body).length, 0)
  const tags = benchWorkTagsLine(data, w)
  const pending = pendingTrashLine(pendingTrashCount(data, 'benchAnalyses', w.id))
  return [
    `${benchWorkRef(w)}${benchWorkBiblio(w) ? ` ${benchWorkBiblio(w)}` : ''}`,
    ...(tags ? [`  ${tags}`] : []),
    `  分析 ${analyses.length}件${analyses.length ? `（${formatCount(total)}字）: ${viewpointSummary(analyses)}` : ''}`,
    ...(pending ? [pending] : []),
    ...(w.pdfPlace.trim() ? [`  PDF の置き場所: ${w.pdfPlace.trim()}`] : []),
    ...(titles.length ? [`  比べるタイトル: ${titles.map((t) => `『${t.name}』[${shortId('title', t.id)}]`).join('、')}`] : []),
  ].join('\n')
}
