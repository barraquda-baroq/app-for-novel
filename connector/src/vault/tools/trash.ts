// ゴミ箱へ移すツール（novel_move_cards_to_trash。2.7）の結果の形。テキストに加えて structuredContent に
// { requested: [{ id, label }], skipped: [{ ref, reason, hint }] } を返す（カードの本文は入れない）。
// コネクタは依頼を作るだけなので、答えの時点ではまだゴミ箱へ移っていない（アプリが同期した時に移る）。そのことと、
// 30日はアプリのゴミ箱から戻せることを必ず書く。
import { cardShortId, TRASH_SHELF_LABELS, type TrashBuild, type TrashItem, type TrashItemStatus } from '../../../../src/claude/trashRequest'
import { TRASH_RETENTION_DAYS } from '../../../../src/domain/trash'
import { capText, fail, type ToolResult } from './common'

const STATUS_LABELS: Record<Exclude<TrashItemStatus, 'requested' | 'pending'>, string> = {
  repeated: '同じ指定',
  not_claude: 'Claude が作ったカードでない',
  edited: '作者が直したカード',
  shelf_item: '作品・資料そのもの',
  not_card: '移せない種類',
  not_found: '見つからない',
  ambiguous: 'カードが決まらない',
  in_trash: 'もうゴミ箱にある',
  invalid: '形が違う',
}

/** 移さなかったうち、Claude が直して呼び直せる・作者に伝える理由（これだけで1件も移さなければ失敗として返す） */
const NEEDS_FIX = new Set<TrashItemStatus>(['not_claude', 'edited', 'shelf_item', 'not_card', 'not_found', 'ambiguous', 'invalid'])

/** 送る前の確かめで呼び出し全体を断った */
export function trashBuildError(built: TrashBuild): ToolResult {
  return fail(built.error ?? '入力を受け付けませんでした')
}

/**
 * 結果を作る。created は実際に作った依頼のカード（{表名}:{カードの id}。試し直しで2回目に「依頼中」になったカードも、
 * 1回目に作っていれば「移す」として返す）。dailyLeft は作った後の、今日（日本時間）あと何件頼めるか
 */
export function trashResult(built: TrashBuild, created: ReadonlySet<string>, dailyLeft: number): ToolResult {
  const isMine = (it: TrashItem) => Boolean(it.table && it.id && created.has(`${it.table}:${it.id}`))
  const moving = built.items.filter((it) => it.status === 'requested' || it.status === 'pending')
  const skipped = built.items.filter((it) => !moving.includes(it))
  const lines = [`カードをゴミ箱へ移す: 移す ${moving.length}件・移さない ${skipped.length}件`]
  for (const it of moving) {
    const again = it.status === 'pending' && !isMine(it) ? '（依頼済み）' : ''
    lines.push(`- 移す ${cardShortId(it.table!, it.id!)} ${TRASH_SHELF_LABELS[it.table!]}${it.label ?? ''}${again}`)
  }
  for (const it of skipped) {
    const what = it.table && it.id ? `${cardShortId(it.table, it.id)}${it.label ? ` ${it.label}` : ''}` : it.ref
    const reason = STATUS_LABELS[it.status as keyof typeof STATUS_LABELS]
    lines.push(`- 移さない ${what}（${reason}）${it.hint ? `: ${it.hint}` : ''}`)
    if (it.candidates?.length) for (const c of it.candidates.slice(0, 5)) lines.push(`    候補: ${c}`)
  }
  if (moving.length)
    lines.push(
      `移すカードは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）。移した後${TRASH_RETENTION_DAYS}日は、作者がアプリのゴミ箱から元に戻せます。`,
    )
  lines.push(`今日（日本時間）はあと ${Math.max(0, dailyLeft)}件移せます。本文（稿）は書き換えていません。`)
  return {
    text: capText(lines.join('\n')),
    isError: !moving.length && skipped.some((it) => NEEDS_FIX.has(it.status)) ? true : undefined,
    structured: {
      requested: moving.map((it) => ({
        id: cardShortId(it.table!, it.id!),
        label: `${TRASH_SHELF_LABELS[it.table!]}${it.label ?? ''}`,
      })),
      skipped: skipped.map((it) => ({ ref: it.ref, reason: it.status, ...(it.hint ? { hint: it.hint } : {}) })),
    },
  }
}
