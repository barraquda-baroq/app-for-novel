// アイデアのツール（2.8。novel_add_ideas・novel_append_to_idea）の結果の形。テキストに加えて structuredContent に
// 書き込みツールと同じ { created: [{ id, label }], skipped: [{ index, reason, hint }] } を返す（カードの中身は入れない）。
// - アイデアを足す: 入れた場所（タイトル『…』のアイデアか、ホームのアイデア）と、足したアイデアの id（i:…）を必ず書く。
//   2.9: フォルダに入れた時は、フォルダの名前と f:…（もとからあるか・新しく作ったか）と、続けて足す時に渡す f:… も書く。
//   フォルダの外（placement="outside"）の答えは 2.8 と1字も変えない
// - アイデアに追記: コネクタは依頼を作るだけなので、答えの時点ではまだカードに足されていない（アプリが同期した時に足す）。
//   そのことと、Claude からはもう追記した後の中身が見えること、続けて追記する時は読み直すことを書く
import { appendHeader } from '../../../../src/claude/ideaAppend'
import { CLAUDE_PATH_SEP } from '../../../../src/claude/ideaFolders'
import { IDEA_ADD_HINTS, type IdeaAddBuild, type IdeaAppendBuild, type IdeaAppendItemStatus } from '../../../../src/claude/ideaWrite'
import { summarizeItems } from '../../../../src/claude/records'
import { shortId } from '../../../../src/claude/refs'
import { capText, fail, type ToolResult } from './common'

const ADD_STATUS_LABELS = {
  created: '追加',
  duplicate: '重複',
  previously_deleted: '以前に削除',
  invalid: '形が違う',
} as const

/** 送る前の確かめで呼び出し全体を断った */
export function ideaAddError(built: IdeaAddBuild): ToolResult {
  return fail(built.error ?? '入力を受け付けませんでした', built.candidates)
}

/**
 * アイデアを足した結果。created は実際に作った記録（ideas:{id}。試し直しで2回目に「重複」になったアイデアも、1回目に作っていれば
 * 「追加」として返す）。同じ id は1件だけ「追加」にする（1回の呼び出しに同じアイデアが2件あっても、カードは1枚なので2件目は「重複」）。
 * 「重複」は、もうあるカードが Claude に見えている時（そのカードの1行目）と、同じ答えで「追加」にしたカードの時に、その i:… も出す
 */
export function ideaAddResult(built: IdeaAddBuild, created: ReadonlySet<string>): ToolResult {
  const reported = new Set<string>()
  const items = built.items.map((it) => {
    if (!it.id || !created.has(`ideas:${it.id}`)) return it
    if (reported.has(it.id))
      return it.status === 'created' ? { ...it, status: 'duplicate' as const, hint: IDEA_ADD_HINTS.duplicate } : it
    reported.add(it.id)
    return it.status === 'created' ? it : { ...it, status: 'created' as const, hint: undefined }
  })
  const made = items.filter((it) => it.status === 'created' && it.id && created.has(`ideas:${it.id}`))
  const skipped = items.filter((it) => !made.includes(it))
  /** 「重複」の行に出す i:…（見えている・この答えで足したカードだけ。見せないタイトルのカードは出さない） */
  const known = (it: (typeof items)[number]) =>
    it.status === 'duplicate' && it.id && (it.existing || reported.has(it.id)) ? shortId('idea', it.id) : ''
  const lines = [`アイデアを足す: ${summarizeItems(items) || '追加するものはありませんでした'}`]
  for (const it of made) lines.push(`- 追加 ${shortId('idea', it.id!)} ${it.label}`)
  for (const it of skipped) {
    const ref = known(it)
    lines.push(`- ${ADD_STATUS_LABELS[it.status]} ${ref ? `${ref} ` : ''}${it.label}${it.hint ? `: ${it.hint}` : ''}`)
  }
  const home = built.titleId === null
  const folders = built.folders ?? []
  if (made.length && folders.length) {
    // 2.9: フォルダに入れた（「新しく作成」は、この呼び出しで実際に書けたフォルダだけ）
    const wrote = (id: string) => created.has(`ideaFolders:${id}`)
    lines.push(
      `フォルダ: ${folders.map((f) => `${f.name} [${shortId('ideaFolder', f.id)}]（${wrote(f.id) ? '新しく作成' : 'もとからあるフォルダ'}）`).join(CLAUDE_PATH_SEP)}`,
    )
    if (folders.some((f) => wrote(f.id))) for (const note of built.notes ?? []) lines.push(`補足: ${note}`)
    lines.push(
      `入れた場所: ${built.place}（そのフォルダの済みでないアイデアの先頭。カードと、Claude が作ったフォルダに「Claude が作成」の印が付きます）`,
    )
    const path = folders.map((f) => `「${f.name}」`).join(CLAUDE_PATH_SEP)
    const target = folders[folders.length - 1]
    lines.push(
      `${home ? 'アプリのホームのアイデア欄の「どのタイトルにも属さない」の' : `アプリのタイトル『${built.titleName}』の「アイデア」と、ホームのアイデア欄のその仕切りの、`}フォルダ${path}に、各端末が同期すると出ます。同じ相談で続けて足す時は folder に ${shortId('ideaFolder', target.id)} を渡してください。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。`,
    )
  } else if (made.length) {
    // 2.9: 「任せる」で1件だった時は、フォルダの外に入れたことを書く（それ以外は 2.8 と1字も変えない）
    if (built.auto1) lines.push('フォルダ: 入れていません（任せる: 1件なのでフォルダの外）')
    lines.push(
      home
        ? '入れた場所: ホームのアイデア（どのタイトルにも属さないアイデア。済みでないアイデアの先頭。カードに「Claude が作成」の印が付きます）'
        : `入れた場所: ${built.place}（済みでないアイデアの先頭。カードに「Claude が作成」の印が付きます）`,
    )
    lines.push(
      `${home ? 'アプリのホームのアイデア欄の「どのタイトルにも属さない」' : `アプリのタイトル『${built.titleName}』の「アイデア」と、ホームのアイデア欄のその仕切り`}に、各端末が同期すると出ます。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。`,
    )
  } else if (folders.some((f) => f.isNew)) {
    lines.push('フォルダは作りませんでした（足すカードが無いため）。')
  }
  return {
    text: capText(lines.join('\n')),
    isError: !made.length && skipped.some((it) => it.status === 'invalid') ? true : undefined,
    structured: {
      created: made.map((it) => ({ id: shortId('idea', it.id!), label: `${it.label}（${built.place}）` })),
      skipped: skipped.map((it) => {
        const ref = known(it)
        return { index: it.index, reason: it.status, ...(ref ? { id: ref } : {}), ...(it.hint ? { hint: it.hint } : {}) }
      }),
    },
  }
}

const APPEND_STATUS_LABELS: Record<Exclude<IdeaAppendItemStatus, 'created' | 'pending' | 'applied'>, string> = {
  stale: '読んだ後に中身が変わった',
  not_claude: '作者が書いたアイデア',
  not_writable: '書き込めない場所',
  pending_trash: 'ゴミ箱へ移す依頼中',
  in_trash: 'ゴミ箱にある',
  not_found: '見つからない',
  ambiguous: 'アイデアが決まらない',
  too_long: '長くなりすぎる',
  invalid: '形が違う',
}

/**
 * アイデアに追記した結果。created は実際に作った依頼（ideaAppends:{依頼の id}。試し直しで2回目に「依頼済み」になった依頼も、
 * 1回目に作っていれば、ふつうの「追記」として返す）
 */
export function ideaAppendResult(built: IdeaAppendBuild, created: ReadonlySet<string>): ToolResult {
  const ok = built.status === 'created' || built.status === 'pending' || built.status === 'applied'
  const ref = built.ideaId ? shortId('idea', built.ideaId) : built.ref
  if (!ok) {
    const reason = APPEND_STATUS_LABELS[built.status as keyof typeof APPEND_STATUS_LABELS]
    const lines = [
      'アイデアに追記: 追記しない',
      `- 追記しない ${built.ideaId ? `${ref} ${built.label ?? ''}` : ref}（${reason}）${built.hint ? `: ${built.hint}` : ''}`,
    ]
    if (built.candidates?.length) for (const c of built.candidates.slice(0, 5)) lines.push(`    候補: ${c}`)
    return {
      text: capText(lines.join('\n')),
      isError: true,
      structured: { created: [], skipped: [{ index: 0, reason: built.status, ...(built.hint ? { hint: built.hint } : {}) }] },
    }
  }
  const mine = Boolean(built.requestId && created.has(`ideaAppends:${built.requestId}`))
  const again = mine || built.status === 'created' ? '' : built.status === 'pending' ? '（依頼済み）' : '（もう足されています）'
  const lines = ['アイデアに追記: 追記 1件', `- 追記 ${ref} ${built.label ?? ''}${again}`]
  if (built.status === 'applied' && !mine) {
    lines.push('この内容は、もうアプリがカードの終わりに足しています（novel_get_notes で今の中身を読めます）。本文（稿）は書き換えていません。')
  } else {
    if (built.request)
      lines.push(
        `足す形: カードの終わりに空行を置き、「${appendHeader(built.request.createdAt)}」の行の下に内容（${Array.from(built.text ?? '').length.toLocaleString('ja-JP')}字）`,
      )
    lines.push(
      '追記は依頼として送りました。アプリを開いて同期すると、カードの終わりに足されます（前の中身と作者が直した所は残り、並びの位置と「済み」は変わりません）。Claude からは、もう追記した後の中身が見えます。続けて追記する時は、もう一度 novel_get_notes で読んでから、新しい印（本文の見出しの「印: 」の後ろの8字）を read_mark に渡してください。本文（稿）は書き換えていません。',
    )
  }
  return {
    text: capText(lines.join('\n')),
    structured: { created: [{ id: ref, label: built.label ?? '' }], skipped: [] },
  }
}
