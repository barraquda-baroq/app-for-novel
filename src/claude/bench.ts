// ベンチ作品（2.5）を Claude に渡す形（コネクタの読むツール・手動連携の依頼文で同じものを使う）と、作品の指し方。
// - 作品は短い id（w:3f2a9c1b）・id・作品名そのもの（前後の空白・Unicode の正規化の違いは問わない）で指せる
// - ベンチ作品はどのタイトルにも属さない利用者の覚え書きなので、タイトルの「Claude に見せる」とは関係なく見せる
import { benchWorkName, sortedBenchWorks, titlesComparing } from '../domain/benchOps'
import { formatCount } from '../domain/text'
import type { AppData, BenchAnalysis, BenchWork, ID } from '../domain/types'
import { benchAnalysesOf, benchViewpointGroups } from './order'
import { matchesId, shortId, type Resolved } from './refs'

const norm = (s: string) => s.normalize('NFC').trim()

/** 作品の指し方（w:… の短い id・id・作品名）から作品を探す */
export function resolveBenchWork(data: Pick<AppData, 'benchWorks'>, ref: string): Resolved<BenchWork> {
  const works = sortedBenchWorks(data)
  const byId = works.filter((w) => matchesId('benchWork', ref, w.id))
  const hits = byId.length ? byId : works.filter((w) => norm(w.name) === norm(ref))
  if (hits.length === 1) return { ok: true, value: hits[0] }
  const candidates = (hits.length ? hits : works).slice(0, 30).map((w) => benchWorkRef(w))
  return hits.length
    ? { ok: false, reason: 'ambiguous', message: `作品名「${ref}」のベンチ作品が${hits.length}件あります。w:… の短い id で指してください`, candidates }
    : { ok: false, reason: 'not_found', message: `ベンチ作品 '${ref}' が見つかりません`, candidates }
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
export function filterByViewpoints(analyses: readonly BenchAnalysis[], viewpoints: readonly string[] | undefined): BenchAnalysis[] {
  const want = new Set((viewpoints ?? []).map(norm).filter(Boolean))
  return want.size ? analyses.filter((a) => want.has(norm(a.viewpoint))) : [...analyses]
}

/** 1つの分析の見出しと本文（「#### 構成（2026-10-30・Claude）[n:…]」＋本文） */
export function analysisText(a: BenchAnalysis): string {
  const by = a.source === 'claude' ? 'Claude' : a.source === 'paste' ? 'Claude（貼り付け）' : '手で記録'
  return `#### ${a.viewpoint.trim() || '観点なし'}（${a.runDate || '日付なし'}・${by}${a.model ? `・${a.model}` : ''}）[${shortId('benchAnalysis', a.id)}]\n${a.body.trim() || '（本文なし）'}`
}

/**
 * 作品の分析を全部つないだ文（手動連携の依頼文と、コネクタで1つの作品の分析を読む時）。観点ごとに、新しい日付から
 */
export function workAnalysesText(data: Pick<AppData, 'benchAnalyses'>, work: BenchWork, viewpoints?: readonly string[]): string {
  const list = filterByViewpoints(benchAnalysesOf(data, work.id), viewpoints)
  const head = `=== ベンチ作品 ${benchWorkRef(work)} ===${benchWorkBiblio(work) ? `\n${benchWorkBiblio(work)}` : ''}`
  if (!list.length) return `${head}\n（${viewpoints?.length ? 'この観点の' : ''}分析はまだありません）`
  const parts: string[] = [head]
  for (const g of benchViewpointGroups(list)) {
    parts.push(`--- 観点「${g.viewpoint}」（${g.items.length}件）---`)
    for (const a of g.items) parts.push(analysisText(a))
  }
  return parts.join('\n')
}

/** 手動連携の作品批評に足す、比べるベンチ作品の分析（無ければ空） */
export function comparisonMaterial(data: AppData, workIds: readonly ID[]): string {
  const works = workIds.map((id) => data.benchWorks[id]).filter((w): w is BenchWork => Boolean(w))
  if (!works.length) return ''
  const lines = [
    `=== 比べるベンチ作品の分析（${works.length}作品）===`,
    '作者が比べたい既存の作品について、以前に Claude が作品の PDF から分析した内容です。批評の中で、これらの作品と比べてください（分析にない内容は推測しないでください）。',
  ]
  for (const w of works) lines.push('', workAnalysesText(data, w))
  return lines.join('\n')
}

/** 作品の1行（一覧用。「w:…『作品名』（著者）分析 3件: 構成 2件（最新 …）・文体 1件（…）／比べるタイトル: 『…』」） */
export function benchWorkLine(data: AppData, w: BenchWork): string {
  const analyses = benchAnalysesOf(data, w.id)
  const titles = titlesComparing(data, w.id)
  const total = analyses.reduce((n, a) => n + Array.from(a.body).length, 0)
  return [
    `${benchWorkRef(w)}${benchWorkBiblio(w) ? ` ${benchWorkBiblio(w)}` : ''}`,
    `  分析 ${analyses.length}件${analyses.length ? `（${formatCount(total)}字）: ${viewpointSummary(analyses)}` : ''}`,
    ...(w.pdfPlace.trim() ? [`  PDF の置き場所: ${w.pdfPlace.trim()}`] : []),
    ...(titles.length ? [`  比べるタイトル: ${titles.map((t) => `『${t.name}』[${shortId('title', t.id)}]`).join('、')}`] : []),
  ].join('\n')
}
