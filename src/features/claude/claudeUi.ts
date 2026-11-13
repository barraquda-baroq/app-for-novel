// Claude 連携の画面で使う、表示用の純粋な計算（データは変えない）。
import type { ReadSelection } from '../../claude/view'
import type { ItemStatus } from '../../claude/records'
import type { ManualTask } from '../../claude/prompts'
import { chaptersOf } from '../../domain/structure'
import { TRASH_RETENTION_DAYS } from '../../domain/trash'
import type { AppData, ClaudeSource, ID } from '../../domain/types'
import { readingOrder } from '../../claude/refs'

/** 記録を作ったものの表記（Claude のバッジ）。手で書いたものは出さない */
export function sourceLabel(source: ClaudeSource | string | undefined): string | null {
  if (source === 'claude') return 'Claude'
  if (source === 'paste') return 'Claude（貼り付け）'
  return null
}

/** 貼り付けの1件ごとの結果の表記 */
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  created: '追加',
  duplicate: '重複（もうあります）',
  previously_deleted: '以前に削除',
  not_found: '見つからない',
  ambiguous: '場所が決まらない',
  invalid: '形が違う',
}

/** 貼り付けの1件ごとの結果の色（badge の種類） */
export function itemStatusTone(status: ItemStatus): 'ok' | 'skip' | 'warn' {
  if (status === 'created') return 'ok'
  if (status === 'duplicate' || status === 'previously_deleted') return 'skip'
  return 'warn'
}

/** 手動連携で読む範囲 */
export type RangeKind = 'all' | 'chapter' | 'pieces'

export interface RangeChoice {
  kind: RangeKind
  /** kind = chapter の時の章 */
  chapterId?: ID | null
  /** kind = pieces の時の読む順の番号（1から。'#12' の 12） */
  from?: number
  to?: number
}

export interface ResolvedRange {
  selection?: Omit<ReadSelection, 'versionId' | 'ruby'>
  /** 「タイトル全体」「一章」「第1話〜第20話」 */
  rangeLabel: string
  /** 作品批評の範囲（話の範囲の時だけ。'#1'〜'#20'） */
  scope?: { from: string; to: string }
}

/** 範囲の選び方を、依頼文・本文を作る形にする（章が無い・番号が範囲の外なら、できるだけ近い範囲にする） */
export function resolveRange(data: AppData, titleId: ID, range: RangeChoice): ResolvedRange {
  if (range.kind === 'chapter' && range.chapterId) {
    const chapter = chaptersOf(data, titleId).find((c) => c.id === range.chapterId)
    if (chapter) return { selection: { chapter: chapter.id }, rangeLabel: chapter.name.trim() || '無題の章' }
  }
  if (range.kind === 'pieces') {
    const order = readingOrder(data, titleId)
    if (order.length) {
      const clamp = (n: number | undefined, fallback: number) =>
        Math.min(order.length, Math.max(1, Number.isFinite(n) ? Math.trunc(n as number) : fallback))
      let from = clamp(range.from, 1)
      let to = clamp(range.to, order.length)
      if (from > to) [from, to] = [to, from]
      const a = order[from - 1]
      const b = order[to - 1]
      const rangeLabel = from === to ? a.label : `${a.label}〜${b.label}`
      return { selection: { from: `#${from}`, to: `#${to}` }, rangeLabel, scope: { from: `#${from}`, to: `#${to}` } }
    }
  }
  return { rangeLabel: 'タイトル全体' }
}

const TASK_FILE_LABELS: Record<ManualTask, string> = {
  proofreading: 'ワードサーチの依頼',
  critique: '作品批評の依頼',
  strategy: '戦略の依頼',
}

/** 「.txt で保存」のファイル名（20261028タイトル名_作品批評の依頼.txt） */
export function manualFileName(titleName: string, task: ManualTask, today: string): string {
  const name = (titleName.trim() || '無題のタイトル').replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 60)
  return `${today.replace(/-/g, '')}${name}_${TASK_FILE_LABELS[task]}.txt`
}

/** Claude（コネクタ）ができること（設定の Claude 連携・連携の画面） */
export const CLAUDE_CAN: readonly string[] = [
  '「Claude に見せる」タイトルの採用原稿と、採用していない稿を含むすべての稿（推敲メモの書き出しも）・目次・文字数・設定項目・メモ・アイデア・戦略・応募計画・作品批評・推敲案を読む',
  '本文を検索する（採用原稿か、すべての稿から。ルビを除いて探します）',
  '推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果・アイデアを新しく足す（「書き込みを許可」と、タイトルの「読む＋書き込む」の時だけ）',
  'ホームの「相対比較」（比べるために読む既存の作品）の作品と分析を読み、相対比較に分析を追加する（タイトルの設定とは関係なく。足すのは「書き込みを許可」の時だけ）',
  'ホームの「資料」（創作のために読む資料）の資料と記録を読み、資料に記録を追加する（タイトルの設定とは関係なく。足すのは「書き込みを許可」の時だけ）',
  'どのタイトルにも属さないホームのアイデアにアイデアを足す（作者がタイトルを言わない時。「書き込みを許可」の時だけ）。読めるホームのアイデアは Claude が作ったものだけ。Claude が足したアイデアには「Claude が作成」の印が付きます',
  'Claude が足したアイデアの終わりに、日付の行を付けて追記する（前の中身は消さず、並びの位置と「済み」も変えません。アプリが同期した時に足されます。タイトルのアイデアは「読む＋書き込む」の時だけ。「書き込みを許可」の時だけ）',
  'アイデアを足す時に、フォルダ（2段まで）に入れる。言われたフォルダが無ければ作る（作者がフォルダを言わない時は、書き込む前にどのフォルダに入れるかを聞きます）。Claude が作ったフォルダにも「Claude が作成」の印が付きます。どのタイトルにも属さないフォルダは名前だけが見えます',
  `作者が頼んだ時だけ、Claude がコネクタで足した相対比較の分析・資料の記録・アイデア（作者が直していないもの。Claude の追記は直したことに数えません）をアプリのゴミ箱へ移す（${TRASH_RETENTION_DAYS}日はゴミ箱から戻せます。「書き込みを許可」の時だけ）`,
]

/** Claude（コネクタ）ができないこと */
export const CLAUDE_CANNOT: readonly string[] = [
  '本文・稿・話・設定などを書き換える・削除する（ゴミ箱へ移すこと以外の削除はできません。作者が書いた・直したカード、作品・資料そのもの、推敲案などほかの記録は移せず、足した記録の書き換えもアプリでだけ。アイデアは Claude が足したものに追記できるだけで、前の中身は消せません）',
  '作者が書いたアイデアに追記する',
  'フォルダの名前の変更・削除・移動と、カードの移動（整理はアプリで作者がする）',
  '「見せない」にしたタイトル・ゴミ箱・応募時の原稿の控え・作者が書いたどのタイトルにも属さないアイデアを読む',
  'あなたの Google アカウントを使う（コネクタは自分専用の匿名のアカウントで、ルールで許された所だけを読み書きします）',
]

/** 「286,400字」のような字数の目安（パートの長さ） */
export function partSizeLabel(chars: number): string {
  return `${chars.toLocaleString('ja-JP')}字`
}
