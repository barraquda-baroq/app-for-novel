// 章管理のオン/オフ・話数の振り方の変更など、確認ダイアログを挟む操作。
// 本編タブと章ページの両方から使う。
import type { ID, NumberingMode } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { confirmDialog } from '../../../ui/dialogs'

/** 章管理をオン/オフする（確認つき）。変更したら true */
export async function toggleChapters(titleId: ID, enabled: boolean): Promise<boolean> {
  const data = getData()
  const title = data.titles[titleId]
  if (!title || title.chaptersEnabled === enabled) return false
  const chapterCount = title.structure.filter((n) => n.type === 'chapter').length

  if (enabled) {
    const firstTime = chapterCount === 0
    const ok = await confirmDialog({
      title: '章で管理しますか？',
      message: firstTime
        ? '「第1章」を作成し、今ある話をすべてその中に入れます。並び順と話数は変わりません。\n\n章はあとから追加・名前の変更・並べ替え・解除ができます。'
        : `以前の章の構成（${chapterCount}章）に戻して表示します。並び順は変わりません。`,
      confirmLabel: '章で管理する',
    })
    if (!ok) return false
    attempt(() => actions.setChaptersEnabled(titleId, true))
    notify(firstTime ? '「第1章」を作成しました' : '章の構成に戻しました')
    return true
  }

  const perChapter = title.numbering === 'perChapter'
  const ok = await confirmDialog({
    title: '章での管理をやめますか？',
    message:
      '章の構成は削除されずに保存され、一覧は章なしの平坦な表示になります。もう一度オンにすると元の章の構成に戻ります。' +
      (perChapter
        ? '\n\n章がない間は、話数は「章ごとに第1話から」ではなく通し番号で表示されます。'
        : '\n\n話数は通し番号のままです。'),
    confirmLabel: '章をオフにする',
  })
  if (!ok) return false
  attempt(() => actions.setChaptersEnabled(titleId, false))
  return true
}

export const NUMBERING_LABELS: Record<NumberingMode, string> = {
  continuous: '通し番号',
  perChapter: '章ごとに第1話から',
}

/** 話数の振り方を変える（確認つき） */
export async function changeNumbering(titleId: ID, mode: NumberingMode): Promise<boolean> {
  const title = getData().titles[titleId]
  if (!title || title.numbering === mode) return false
  const ok = await confirmDialog({
    title: `話数を「${NUMBERING_LABELS[mode]}」にしますか？`,
    message:
      (mode === 'perChapter'
        ? '各章の中で第1話から数え直します（章に入っていない話は、それだけで第1話から数えます）。'
        : 'タイトル全体で第1話から通して数え直します。') +
      '\n\nすべての話数が並び順どおりに振り直されます。話の中身・話の題・並び順は変わりません。',
    confirmLabel: '振り直す',
  })
  if (!ok) return false
  attempt(() => actions.setNumbering(titleId, mode))
  notify(`話数を「${NUMBERING_LABELS[mode]}」で振り直しました`)
  return true
}
