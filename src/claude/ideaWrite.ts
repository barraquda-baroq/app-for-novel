// Claude がコネクタでアイデア欄に書く（2.8）ための組み立て: novel_add_ideas（アイデアを足す）と novel_append_to_idea（アイデアに追記）。
// コネクタだけが使う（手動連携の貼り付けでは使えない。records.ts の WRITE_TOOLS・WRITE_TOOL_LABELS には入れない）。
// - 本文・id・追記の形・確かめ方は ideaAppend.ts と derivedId.ts の部品で作る（アプリの処理・Claude に見せる内容と同じもの）
// - raw は修復した内容（見せないタイトル・作者が書いたホームのアイデア・ゴミ箱へ移す依頼の出ているアイデアも含む）、view は Claude に
//   見せる内容（claudeView。まだアプリが足していない追記の依頼も当てた形）。重複・並び・依頼済みは raw で、指す先・読んだ印は view で
//   見る（見せないものは「見つからない」と答え、中身を出さない）
// - カードは Markdown を変換せずにそのまま出すので、Markdown の記号がある中身は足さずに、その行を返す（自動では直さない）
import { isIdeaChecked } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import {
  effectiveFolderId,
  effectiveParentId,
  folderNameKey,
  folderPathLabel,
  ideaFolderName,
  sectionOf,
  tidyFolderName,
} from '../domain/ideaFolders'
import type { AppData, ID, Idea, IdeaAppend, IdeaFolder, Title } from '../domain/types'
import { stableStringify } from '../sync/merge'
import { canClaudeWrite } from './access'
import { jstDate, jstSlashDate } from './dates'
import { claudeFolderId, claudeIdeaId, ideaAppendId } from './derivedId'
import {
  CLAUDE_PATH_SEP,
  datedFolderName,
  folderCandidateLines,
  folderChildren,
  IDEA_FOLDER_RECORD_VERSION,
  ideaPathLabel,
  sectionSubfolders,
} from './ideaFolders'
import {
  appendIdsOf,
  appendedBody,
  claudeIdeaBody,
  IDEA_APPEND_VERSION,
  IDEA_LIMITS,
  IDEA_RECORD_VERSION,
  ideaHeadLine,
  ideaPlaceLabel,
  ideaReadMark,
  ideaSectionWritable,
  isClaudeIdea,
  normalizeIdeaName,
  normalizeIdeaText,
  normalizeReadMark,
  READ_MARK,
} from './ideaAppend'
import { RECORD_LIMITS } from './records'
import { matchesId, resolveTitle, shortId } from './refs'
import { isTrashedClaudeIdea } from './trashRequest'
import { liveTrashRequests } from './trashTargets'

/** ツールの名前 */
export const IDEA_ADD_TOOL = 'novel_add_ideas'
export const IDEA_APPEND_TOOL = 'novel_append_to_idea'

export type IdeaTool = typeof IDEA_ADD_TOOL | typeof IDEA_APPEND_TOOL

export function isIdeaTool(v: unknown): v is IdeaTool {
  return v === IDEA_ADD_TOOL || v === IDEA_APPEND_TOOL
}

/** 頼み直しの通し番号の上限（trashRequest.ts と同じ） */
const MAX_GENERATION = 100

/** 文字の数（サロゲートペアを1字に数える） */
const charCount = (s: string) => Array.from(s).length

const fmt = (n: number) => n.toLocaleString('ja-JP')

/** 短く切る（max 字を超えれば「…」） */
function cut(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

// ---------- Markdown の記号 ----------

/** 行の頭の Markdown の記号（見出し・箇条書き・引用・コードの囲み・表・区切り線）。「1. 」「#12」「・」【】は使える */
const MARKDOWN_LINE = [
  /^\s{0,3}#{1,6}\s/,
  /^\s*[-*+]\s+\S/,
  /^\s*>\s/,
  /^\s*```/,
  /^\s*\|.*\|\s*$/,
  /^\s*\|?\s*:?-{3,}:?\s*\|/,
  /^\s*([-*_])(\s*\1){2,}\s*$/,
]

/** 行の中の Markdown の記号（太字・リンク） */
const MARKDOWN_INLINE = [/\*\*[^*\n]+\*\*/, /__[^_\n]+__/, /\[[^\]\n]+\]\((https?:|#)/]

export interface MarkdownLine {
  /** 何行目か（1から） */
  line: number
  text: string
}

/** Markdown の記号がある行（何行目か・その行）。改行は LF・CRLF・CR のどれでもよい */
export function ideaMarkdownLines(text: string): MarkdownLine[] {
  const out: MarkdownLine[] = []
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      if (MARKDOWN_LINE.some((re) => re.test(l)) || MARKDOWN_INLINE.some((re) => re.test(l))) out.push({ line: i + 1, text: l })
    })
  return out
}

/** Markdown の記号がある時の直し方（3行まで。1行は20字まで） */
export function markdownHint(lines: readonly MarkdownLine[]): string {
  const shown = lines
    .slice(0, 3)
    .map((l) => `${l.line}行目「${cut(l.text.trim(), 20)}」`)
    .join('・')
  const more = lines.length > 3 ? `・ほか${lines.length - 3}行` : ''
  return `Markdown の記号があります（${shown}${more}）。カードは Markdown を変換せずにそのまま出すので、記号を使わず、箇条書きは「・」、小見出しは【】で書き直して送ってください`
}

// ---------- アイデアを足す（novel_add_ideas） ----------

export interface AddIdeasInput {
  /** タイトル（t:… かタイトル名）。省くとどのタイトルにも属さないホームのアイデア */
  title_id?: unknown
  /** 2.9: 入れるフォルダ（名前か f:…。作者がフォルダを言った時だけ） */
  folder?: unknown
  /** 2.9: folder の中の2段目のフォルダ（名前か f:…。作者が2段とも言った時） */
  subfolder?: unknown
  /** 2.9: 相談のテーマ（コネクタがフォルダの名前「2026/11/12　テーマ」を付ける時） */
  theme?: unknown
  /** 2.9: 作者がフォルダを言わなかった時（"auto" = 任せる、"outside" = フォルダに入れない） */
  placement?: unknown
  items?: unknown
  model?: unknown
}

export interface IdeaWriteContext {
  /** 作った時刻（ms）。1行目の日付と時刻・id の日付もこの時刻の日本時間 */
  now: number
  /**
   * 以前に削除された記録か（コネクタ: クラウドの削除の印・ゴミ箱の中身・ゴミ箱へ移す依頼の出ているカード）。
   * 追記の依頼は、クラウドの削除の印（アプリが処理して消した依頼）だけを見る。フォルダ（2.9）はクラウドの削除の印とゴミ箱の中身
   */
  wasDeleted: (table: 'ideas' | 'ideaAppends' | 'ideaFolders', id: ID) => boolean
}

/**
 * 1件の結果。created = 足す、duplicate = 同じ日に同じ場所・名前・中身のアイデアがもうある、previously_deleted = 以前に削除された
 * （ゴミ箱にある・ゴミ箱へ移す依頼中も）、invalid = 形が違う・長すぎる・Markdown の記号がある
 */
export type IdeaAddStatus = 'created' | 'duplicate' | 'previously_deleted' | 'invalid'

export interface IdeaAddItem {
  /** 入力の items の何番目か（0から） */
  index: number
  status: IdeaAddStatus
  /** 足す・足したアイデアの id（invalid は無い） */
  id?: ID
  /**
   * 「2026/11/12 14:32　第3章の動機」（1行目。入力から作る。名前が無い時は日付と時刻の後ろに中身の最初の行。ideaHeadLine）。
   * 重複で、もうあるカードが Claude に見えている時は、そのカードの1行目。形が違う時は「アイデア（2件目）」
   */
  label: string
  hint?: string
  /** 重複: もうあるカード（Claude が作ったもの）が Claude に見えている（答えにその i:… を出せる） */
  existing?: boolean
}

/** 2.9: 入れるフォルダ（外から順に、1段目・2段目） */
export interface IdeaAddFolder {
  id: ID
  name: string
  depth: 1 | 2
  /** この組み立てで作る（カードを1件以上足す時だけ。答えの「新しく作成」は、実際に書けたかで決める） */
  created: boolean
  /** まだ無いフォルダ（カードを足さなければ作らない） */
  isNew: boolean
}

export interface IdeaAddBuild {
  /** false = 呼び出し全体を断った（error に理由） */
  ok: boolean
  error?: string
  candidates?: string[]
  /** 入れる場所（タイトルの id。null = ホームのアイデア） */
  titleId: ID | null
  /** 「ホームのアイデア」か「タイトル『星の庭』のアイデア」（2.9: フォルダに入れる時は「＞新作の相談＞2026/11/12　港町」も） */
  place: string
  /** タイトルの名前（ホームのアイデアは空） */
  titleName: string
  /** 2.9: 作るフォルダが先、カードが後（1回の書き込みで、まとめて成功か失敗） */
  records: ({ table: 'ideas'; record: Idea } | { table: 'ideaFolders'; record: IdeaFolder })[]
  items: IdeaAddItem[]
  /** 2.9: 入れるフォルダ（外から順に）。フォルダの外なら空 */
  folders: IdeaAddFolder[]
  /** 2.9: フォルダの場所（「新作の相談＞2026/11/12　港町」。フォルダの外なら空） */
  folderPath: string
  /** 2.9: カードを入れるフォルダ（いちばん内側） */
  targetFolderId?: ID
  /** 2.9: 補足（フォルダを作る時だけ。ゴミ箱・ほかの場所に同じ名前のフォルダがある） */
  notes: string[]
  /** 2.9: 1段目の中にフォルダを作れない形だったので、その1段目にじかに入れた（答えの補足。フォルダを作ったかによらず出す） */
  directNote?: string
  /** 2.9: 「任せる」で1件だったのでフォルダの外に入れた */
  auto1?: true
}

export const IDEA_ADD_HINTS = {
  duplicate: '同じ内容のアイデアがもうあります（追加しません）',
  previously_deleted: '以前に削除されたアイデアです（追加しません。作者はアプリのゴミ箱から戻せます）',
} as const

/** 2.9: フォルダの決め方の断りの文 */
export const IDEA_FOLDER_TEXTS = {
  none: (place: string) =>
    `フォルダが決まっていないので、何も足していません。書き込む前に作者に「どのフォルダに入れますか」と聞き、候補のフォルダの名前も出してください（${place}のフォルダは下のとおり）。作者がフォルダを言えば folder に（2段とも言えば subfolder にも）、「任せる」なら placement="auto"、フォルダに入れないなら placement="outside" を渡して、もう一度呼んでください。`,
  noneYet: (place: string) => `（${place}にはまだフォルダがありません。作者が名前を言えば、その名前で作ります）`,
  both: 'folder と placement は一緒に渡せません（作者がフォルダを言った時は folder だけ、言わなかった時は placement だけ）',
  subfolderAlone: 'subfolder は folder（1段目のフォルダ）と一緒に渡してください',
  placement: 'placement は "auto"（任せる）か "outside"（フォルダに入れない）にしてください',
  name: 'フォルダの名前は1行・40字までにしてください',
  theme: `theme（相談のテーマ）は1行・${IDEA_LIMITS.theme}字までにしてください（フォルダの名前「日付　テーマ」が40字までのため）`,
  themeForFolder: (day: string) =>
    `folder だけの時は、その中に「${day}　テーマ」の2段目のフォルダを作るので、theme（相談のテーマ。短く）も渡してください（作者が2段目の名前を言った時は subfolder に渡す）`,
  themeForAuto: (day: string) =>
    `placement="auto" で2件以上の時は、新しいフォルダ「${day}　テーマ」にまとめるので、theme（相談のテーマ。短く）も渡してください`,
  notFound: (ref: string) => `フォルダが見つかりません: ${ref}`,
  ambiguousRef: (ref: string) => `${ref} がいくつかのフォルダに当たります（id を長く指定してください）`,
  ambiguousName: (name: string) => `「${name}」という名前のフォルダが2つ以上あり、決まりません。f:… で指してください`,
  inTitle: (ref: string, title: string, titleRef: string) =>
    `${ref} はタイトル『${title}』のフォルダです（そこに入れる時は title_id に ${titleRef} を渡してください）`,
  inHome: (ref: string) => `${ref} はホームのアイデアのフォルダです（title_id を省いてください）`,
  noThird: (ref: string) =>
    `${ref} は2段目のフォルダなので、中にフォルダは作れません（3段目は作れません。subfolder を省くと、そのフォルダにじかに入れます）`,
  notChild: (ref: string, parent: string) => `${ref} は「${parent}」の中のフォルダではありません`,
  stuck: (name: string) =>
    `フォルダ「${name}」は、アプリでの移動がぶつかって中にフォルダを作れない状態なので、そのフォルダにじかに入れました（作者がアプリでそのフォルダの「移動…」から「1段目にする」を選ぶと直ります）`,
  exhausted: 'このフォルダはもう作れません（同じ名前のフォルダの削除と作り直しが多すぎます）。別の名前にしてください',
  trashed: (name: string) =>
    `ゴミ箱にも同じ名前のフォルダ「${name}」があります（新しく作りました。前のフォルダは作者がアプリのゴミ箱から戻せます）`,
  elsewhere: (place: string, name: string, ref: string) =>
    `${place}にも同じ名前のフォルダ「${name}」[${ref}] があります（違う場所だった時は、作者がアプリで移せます）`,
} as const

/** 長すぎる中身の直し方（いくつに分ければよいか） */
function splitHint(chars: number): string {
  const k = Math.max(2, Math.ceil(chars / IDEA_LIMITS.content))
  return `${k}つのアイデアに分け、name に「（1/${k}）」のような番号を付けて足してください`
}

const modelOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? Array.from(v.trim()).slice(0, RECORD_LIMITS.model).join('') : undefined

/** タイトルの表記（空の名前は「無題のタイトル」） */
const titleName = (t: Pick<Title, 'name'>) => (typeof t.name === 'string' ? t.name.trim() : '') || '無題のタイトル'

/** f:… の形（アイデアのフォルダの短い id） */
const FOLDER_REF = /^f:/i

/**
 * 1段目として見せているのに、記録に親へのつながりが残るフォルダ（同期で C→A→B・A↔B になった・親が消えた）。中に2段目を作ると、
 * その2段目は今すぐ（C→A→B・輪）か、つながりが生き返った時（親が戻った）に、このフォルダの外の1段目に見える。コネクタは作者の
 * フォルダを書き換えない（つながりを消せない）ので、中にフォルダを作らずに、このフォルダにじかに入れる
 */
const stuckTop = (f: IdeaFolder) => typeof f.parentId === 'string'

/** 決めたフォルダ（もうあるもの・新しく作るもの） */
type FolderPick = { folder: IdeaFolder } | { name: string }

/** 入れるフォルダの決め方の結果（top だけ = 1段目にじかに、sub も = 2段目に） */
type FolderPlan = { top: FolderPick; sub: FolderPick | null }

/** 1行・max 字までにそろえた名前（そろえて空・長すぎれば null） */
function folderNameOf(v: string, max: number): string | null {
  const t = tidyFolderName(v)
  const n = Array.from(t).length
  return n > 0 && n <= max ? t : null
}

/**
 * アイデアを足す記録を作る。title_id を省くとどのタイトルにも属さないホームのアイデア（コネクタが「書き込みを許可」を確かめる）、
 * 渡すとそのタイトル（「読む＋書き込む」の時だけ）。足すアイデアは、その場所の済みでないアイデアの先頭に、入力の順で並ぶ
 * （raw の済みでないアイデアの最小の order より前。見せないアイデアも数える）。
 * 2.9: フォルダに入れる（folder・subfolder・theme）か、作者がフォルダを言わなかった時の placement（"auto" = 任せる・
 * "outside" = フォルダの外）のどちらかが要る（どちらも無ければ、何も書かずに候補のフォルダと「どのフォルダに入れますか」を返す）。
 * folder に1段目の f:… だけ（theme・subfolder 無し）を渡すとその1段目にじかに入れ（前の答えの f:… で続けて足す）、1段目を名前で
 * 言われた時（と f:… に theme を付けた時）はその中に2段目「日付　theme」を作る。中にフォルダを作れない1段目（stuckTop）には、
 * じかに入れて補足（directNote）で言う。
 * フォルダの名前は見せる内容で探し（書ける仕切りのフォルダはすべて見えている）、並びと作り直しの番号は raw で決める。
 * 新しいフォルダ（cf-…）は、カードを1件以上足す時だけ、カードと同じ1回の書き込みで作る（空のフォルダは作らない）
 */
export function buildAddIdeas(raw: AppData, view: AppData, input: AddIdeasInput, ctx: IdeaWriteContext): IdeaAddBuild {
  const fail = (error: string, candidates?: string[]): IdeaAddBuild => ({
    ok: false,
    error,
    ...(candidates ? { candidates } : {}),
    titleId: null,
    place: '',
    titleName: '',
    records: [],
    items: [],
    folders: [],
    folderPath: '',
    notes: [],
  })
  const x: AddIdeasInput = input && typeof input === 'object' ? input : {}
  let title: Title | null = null
  if (x.title_id !== undefined) {
    if (typeof x.title_id !== 'string' || !x.title_id.trim())
      return fail('title_id が空です（ホームのアイデアに入れる時は省いてください）')
    const r = resolveTitle(view, x.title_id)
    if (!r.ok)
      return fail(
        `${r.message}（Claude に見せていないタイトルは使えません。アプリのタイトル画面の「Claude に見せる」を確かめてください）`,
        r.candidates,
      )
    if (!canClaudeWrite(r.value))
      return fail(
        `タイトル『${titleName(r.value)}』は「Claude に見せる」が「読むだけ」なので書き込めません（アプリのタイトル画面で「読む＋書き込む」にすると書き込めます。ホームのアイデアに入れる時は、作者に確かめてから title_id を省いて送ってください）`,
      )
    title = r.value
  }
  const items = x.items
  if (!Array.isArray(items) || !items.length) return fail('items がありません（足すアイデアを1件以上渡してください）')
  if (items.length > IDEA_LIMITS.perCall)
    return fail(`1回に足せるアイデアは${IDEA_LIMITS.perCall}件までです（いま ${items.length}件。分けて呼んでください）`)
  const section = title ? title.id : null
  const sectionPlace = ideaPlaceLabel(view.titles, { titleId: section })
  const model = modelOf(x.model)
  const day = jstDate(ctx.now)
  const slashDay = jstSlashDate(ctx.now)

  // ---- 2.9: どのフォルダに入れるか（何も書かない断りは、ここまでに決める） ----
  const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  if (x.folder !== undefined && !strOrNull(x.folder)) return fail('folder が空です（フォルダの名前か f:… を渡してください）')
  if (x.subfolder !== undefined && !strOrNull(x.subfolder))
    return fail('subfolder が空です（2段目のフォルダの名前か f:… を渡してください）')
  if (x.theme !== undefined && !strOrNull(x.theme)) return fail(IDEA_FOLDER_TEXTS.theme)
  if (x.placement !== undefined && x.placement !== 'auto' && x.placement !== 'outside') return fail(IDEA_FOLDER_TEXTS.placement)
  const folderRef = strOrNull(x.folder)
  const subRef = strOrNull(x.subfolder)
  const placement = x.placement as 'auto' | 'outside' | undefined
  const candidates = () => {
    const lines = folderCandidateLines(view, section)
    return lines.length ? lines : [IDEA_FOLDER_TEXTS.noneYet(sectionPlace)]
  }
  if (!folderRef && !placement) return fail(IDEA_FOLDER_TEXTS.none(sectionPlace), candidates())
  if (folderRef && placement) return fail(IDEA_FOLDER_TEXTS.both)
  if (subRef && !folderRef) return fail(IDEA_FOLDER_TEXTS.subfolderAlone)
  let theme: string | null = null
  if (x.theme !== undefined) {
    theme = folderNameOf(x.theme as string, IDEA_LIMITS.theme)
    if (!theme) return fail(IDEA_FOLDER_TEXTS.theme)
  }
  const ref = (f: IdeaFolder) => shortId('ideaFolder', f.id)
  const keyOf = (name: string) => folderNameKey(name)
  const sameKey = (list: readonly IdeaFolder[], name: string) => list.filter((f) => keyOf(ideaFolderName(f)) === keyOf(name))
  /** f:… を、見せる内容のフォルダから探す（この仕切りのものだけ。ほかの場所のものは場所を言って断る） */
  const byRef = (r: string): IdeaFolder | IdeaAddBuild => {
    const all = Object.values(view.ideaFolders).filter((f) => f && typeof f === 'object' && matchesId('ideaFolder', r, f.id))
    const here = all.filter((f) => sectionOf(view.titles, f.titleId) === section)
    if (here.length > 1)
      return fail(
        IDEA_FOLDER_TEXTS.ambiguousRef(r),
        here.slice(0, 10).map((f) => `${ref(f)} ${folderPathLabel(view, f.id, CLAUDE_PATH_SEP)}`),
      )
    if (here.length === 1) return here[0]
    const other = all[0]
    if (other) {
      const t = sectionOf(view.titles, other.titleId)
      return fail(
        t
          ? IDEA_FOLDER_TEXTS.inTitle(ref(other), titleName(view.titles[t]), shortId('title', t))
          : IDEA_FOLDER_TEXTS.inHome(ref(other)),
      )
    }
    return fail(IDEA_FOLDER_TEXTS.notFound(r), candidates())
  }
  const isBuild = (v: unknown): v is IdeaAddBuild => typeof v === 'object' && v !== null && 'ok' in v
  /** 2段目の決め方（1段目 top の中。subfolder の名前か f:…、無ければ「日付　theme」） */
  const pickSub = (top: FolderPick): FolderPick | IdeaAddBuild => {
    const children = 'folder' in top ? folderChildren(view, section, top.folder.id) : []
    const topName = 'folder' in top ? ideaFolderName(top.folder) : top.name
    if (subRef && FOLDER_REF.test(subRef)) {
      const f = byRef(subRef)
      if (isBuild(f)) return f
      return children.some((c) => c.id === f.id) ? { folder: f } : fail(IDEA_FOLDER_TEXTS.notChild(ref(f), topName))
    }
    let name: string | null
    if (subRef) {
      name = folderNameOf(subRef, IDEA_LIMITS.folderName)
      if (!name) return fail(IDEA_FOLDER_TEXTS.name)
    } else {
      if (!theme) return fail(IDEA_FOLDER_TEXTS.themeForFolder(slashDay))
      name = datedFolderName(ctx.now, theme)
    }
    const hits = sameKey(children, name)
    if (hits.length > 1)
      return fail(
        IDEA_FOLDER_TEXTS.ambiguousName(name),
        hits.slice(0, 10).map((f) => `${ref(f)} ${folderPathLabel(view, f.id, CLAUDE_PATH_SEP)}`),
      )
    return hits.length ? { folder: hits[0] } : { name }
  }
  let plan: FolderPlan | null = null
  let directNote: string | undefined
  /** 1段目の中（2段目）の決め方。中にフォルダを作れない1段目は、そこにじかに入れて補足で言う */
  const inTop = (top: FolderPick): FolderPlan | IdeaAddBuild => {
    if ('folder' in top && stuckTop(top.folder)) {
      directNote = IDEA_FOLDER_TEXTS.stuck(ideaFolderName(top.folder))
      return { top, sub: null }
    }
    const sub = pickSub(top)
    return isBuild(sub) ? sub : { top, sub }
  }
  if (folderRef) {
    if (FOLDER_REF.test(folderRef)) {
      const f = byRef(folderRef)
      if (isBuild(f)) return f
      const parentId = effectiveParentId(view, f)
      if (parentId) {
        // 2段目のフォルダ: そこにじかに入れる（中にフォルダは作れない。theme は使わない）
        if (subRef) return fail(IDEA_FOLDER_TEXTS.noThird(ref(f)))
        plan = { top: { folder: view.ideaFolders[parentId] }, sub: { folder: f } }
      } else if (!subRef && !theme) {
        // 1段目の f:…（前の答えに出たもの）だけ: そのフォルダにじかに入れる（名前で言われた1段目だけが「日付　theme」を作る）
        plan = { top: { folder: f }, sub: null }
      } else {
        const p = inTop({ folder: f })
        if (isBuild(p)) return p
        plan = p
      }
    } else {
      const name = folderNameOf(folderRef, IDEA_LIMITS.folderName)
      if (!name) return fail(IDEA_FOLDER_TEXTS.name)
      const tops = sameKey(folderChildren(view, section, null), name)
      const subs = tops.length ? [] : sameKey(sectionSubfolders(view, section), name)
      const many = tops.length > 1 ? tops : subs.length > 1 ? subs : null
      if (many)
        return fail(
          IDEA_FOLDER_TEXTS.ambiguousName(name),
          many.slice(0, 10).map((f) => `${ref(f)} ${folderPathLabel(view, f.id, CLAUDE_PATH_SEP)}`),
        )
      if (subs.length === 1) {
        // 1段目に無く、2段目に1つだけある名前: その2段目にじかに入れる
        if (subRef) return fail(IDEA_FOLDER_TEXTS.noThird(ref(subs[0])))
        plan = { top: { folder: view.ideaFolders[effectiveParentId(view, subs[0])!] }, sub: { folder: subs[0] } }
      } else {
        const p = inTop(tops.length ? { folder: tops[0] } : { name })
        if (isBuild(p)) return p
        plan = p
      }
    }
  } else if (placement === 'auto' && items.length >= 2) {
    // 任せる・2件以上: 新しい1段目「日付　theme」（同じ名前があればそこ）にまとめる。数は渡した items の数で決める
    if (!theme) return fail(IDEA_FOLDER_TEXTS.themeForAuto(slashDay))
    const name = datedFolderName(ctx.now, theme)
    const tops = sameKey(folderChildren(view, section, null), name)
    if (tops.length > 1)
      return fail(
        IDEA_FOLDER_TEXTS.ambiguousName(name),
        tops.slice(0, 10).map((f) => `${ref(f)} ${folderPathLabel(view, f.id, CLAUDE_PATH_SEP)}`),
      )
    plan = { top: tops.length ? { folder: tops[0] } : { name }, sub: null }
  }

  // 新しいフォルダの id（作り直しの番号: raw にある id（名前を変えた・移したもの）・削除の印・ゴミ箱の中身・この呼び出しで使った id を飛ばす）
  const used = new Set<ID>()
  const newId = (parentId: ID | null, name: string): ID | null => {
    for (let g = 1; g <= MAX_GENERATION; g++) {
      const id = claudeFolderId(section, parentId, name, g)
      if (Object.prototype.hasOwnProperty.call(raw.ideaFolders, id) || ctx.wasDeleted('ideaFolders', id) || used.has(id)) continue
      used.add(id)
      return id
    }
    return null
  }
  /** 作るフォルダの記録（並びは raw の兄弟の最小 − 1。兄弟が無ければ 0） */
  const newFolder = (id: ID, parentId: ID | null, name: string): IdeaFolder => {
    const siblings =
      parentId && !Object.prototype.hasOwnProperty.call(raw.ideaFolders, parentId) ? [] : folderChildren(raw, section, parentId)
    const orders = siblings.map((f) => f.order).filter((n) => typeof n === 'number' && Number.isFinite(n))
    return {
      id,
      titleId: section,
      parentId,
      name,
      order: orders.length ? Math.min(...orders) - 1 : 0,
      source: 'claude',
      v: IDEA_FOLDER_RECORD_VERSION,
      ...(model ? { model } : {}),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }
  }
  const chain: { folder: IdeaFolder; isNew: boolean }[] = []
  if (plan) {
    for (const pick of [plan.top, plan.sub]) {
      if (!pick) continue
      if ('folder' in pick) {
        chain.push({ folder: pick.folder, isNew: false })
        continue
      }
      const parentId = chain.length ? chain[0].folder.id : null
      const id = newId(parentId, pick.name)
      if (!id) return fail(IDEA_FOLDER_TEXTS.exhausted)
      chain.push({ folder: newFolder(id, parentId, pick.name), isNew: true })
    }
  }
  const target = chain.length ? chain[chain.length - 1].folder.id : null

  // ---- カード ----
  const out: IdeaAddItem[] = []
  /** 足すアイデア（入力の順。並びの位置は後で決める） */
  const made: { item: IdeaAddItem; record: Idea }[] = []
  const seen = new Set<ID>()
  items.forEach((it, index) => {
    const bad = (hint: string) => out.push({ index, status: 'invalid', label: `アイデア（${index + 1}件目）`, hint })
    const o = it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null
    if (!o) return bad('アイデアの形が違います（name と content のオブジェクトにしてください）')
    if (o.name !== undefined && o.name !== null && typeof o.name !== 'string') return bad('name は文字列にしてください')
    const name = normalizeIdeaName(typeof o.name === 'string' ? o.name : '')
    if (typeof o.content !== 'string') return bad('content がありません')
    const content = normalizeIdeaText(o.content)
    if (!content) return bad('content が空です')
    const chars = charCount(content)
    if (chars > IDEA_LIMITS.content)
      return bad(`content は${fmt(IDEA_LIMITS.content)}字までです（いま ${fmt(chars)}字）。${splitHint(chars)}`)
    // 行の番号はカードと同じ（1行目は日付と時刻・名前、2行目から中身）
    const md = ideaMarkdownLines(`${name}\n${content}`)
    if (md.length) return bad(markdownHint(md))
    const body = claudeIdeaBody(ctx.now, name, content)
    // id にフォルダは入れない（同じ日に同じ場所・名前・中身のアイデアは、フォルダが違っても重複）
    const id = claudeIdeaId(section, day, name, content)
    const label = `「${ideaHeadLine({ heading: '', body }, 40)}」`
    if (ctx.wasDeleted('ideas', id)) {
      out.push({ index, status: 'previously_deleted', id, label, hint: IDEA_ADD_HINTS.previously_deleted })
      return
    }
    // 見せないタイトルへ移したアイデアも raw で見る（中身は出さず、入力から作った表記だけを返す）。Claude に見えているカードなら、
    // そのカードの1行目と i:…（作った時刻は、送り直した時刻ではなく、もうあるカードのもの）。フォルダに入っていれば場所も
    if (Object.prototype.hasOwnProperty.call(raw.ideas, id) || seen.has(id)) {
      const known = Object.prototype.hasOwnProperty.call(view.ideas, id) ? view.ideas[id] : undefined
      out.push(
        known && isClaudeIdea(known)
          ? {
              index,
              status: 'duplicate',
              id,
              label: `「${ideaHeadLine(known, 40)}」`,
              hint: effectiveFolderId(view, known)
                ? `${IDEA_ADD_HINTS.duplicate}（場所: ${ideaPathLabel(view, known)}）`
                : IDEA_ADD_HINTS.duplicate,
              existing: true,
            }
          : { index, status: 'duplicate', id, label, hint: IDEA_ADD_HINTS.duplicate },
      )
      return
    }
    seen.add(id)
    const record: Idea = {
      id,
      titleId: section,
      heading: '',
      body,
      checked: false,
      checkedAt: null,
      order: 0,
      ...(target ? { folderId: target } : {}),
      source: 'claude',
      v: IDEA_RECORD_VERSION,
      ...(model ? { model } : {}),
      claudeHash: hashJson(body),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }
    const item: IdeaAddItem = { index, status: 'created', id, label }
    out.push(item)
    made.push({ item, record })
  })
  // 並びの位置: 入れる入れ物（仕切り＋フォルダ）の済みでないアイデアの最小の order から、足す数だけ前（入力の順。raw の作者の
  // カードも数える）。大きさは決めた位置で確かめる
  const open = Object.values(raw.ideas).filter(
    (i) =>
      i &&
      typeof i === 'object' &&
      sectionOf(raw.titles, i.titleId) === section &&
      effectiveFolderId(raw, i) === target &&
      !isIdeaChecked(i) &&
      typeof i.order === 'number' &&
      Number.isFinite(i.order),
  )
  const top = open.length ? Math.min(...open.map((i) => i.order)) : 0
  const place = (list: typeof made) => list.forEach((m, j) => (m.record.order = top - list.length + j))
  place(made)
  const fits = made.filter((m) => {
    const length = stableStringify(m.record).length
    if (length <= IDEA_LIMITS.recordJson) return true
    m.item.status = 'invalid'
    m.item.id = undefined
    m.item.hint = `アイデアが大きすぎます（1件は JSON にして ${fmt(IDEA_LIMITS.recordJson)}字まで。いま ${fmt(length)}字）。${splitHint(charCount(m.record.body))}`
    return false
  })
  if (fits.length !== made.length) place(fits)
  // フォルダは、カードを1件以上足す時だけ作る（外から順に、カードより先）
  const writeFolders = fits.length > 0
  const folders: IdeaAddFolder[] = chain.map((c, i) => ({
    id: c.folder.id,
    name: ideaFolderName(c.folder),
    depth: i === 0 ? 1 : 2,
    created: writeFolders && c.isNew,
    isNew: c.isNew,
  }))
  const folderPath = folders.map((f) => f.name).join(CLAUDE_PATH_SEP)
  const notes: string[] = []
  if (writeFolders)
    for (const c of chain) {
      if (!c.isNew) continue
      const name = ideaFolderName(c.folder)
      const key = keyOf(name)
      const parentName = c.folder.parentId ? ideaFolderName(chain[0].folder) : null
      // N1: ゴミ箱に同じ場所・同じ名前のフォルダ（2段目は親の名前も同じ）
      const trashed = Object.values(raw.trashEntries).some(
        (e) =>
          e &&
          e.kind === 'ideaFolder' &&
          (e.origin?.titleId ?? null) === section &&
          keyOf(String(e.label ?? '')) === key &&
          (parentName === null ? !e.parentLabel : keyOf(String(e.parentLabel ?? '')) === keyOf(parentName)),
      )
      if (trashed) notes.push(IDEA_FOLDER_TEXTS.trashed(name))
      // N2: 見えているほかの仕切りに同じ名前のフォルダ
      const other = Object.values(view.ideaFolders).find(
        (f) => f && typeof f === 'object' && sectionOf(view.titles, f.titleId) !== section && keyOf(ideaFolderName(f)) === key,
      )
      if (other) {
        const t = sectionOf(view.titles, other.titleId)
        notes.push(
          IDEA_FOLDER_TEXTS.elsewhere(t ? `タイトル『${titleName(view.titles[t])}』` : 'ホームのアイデア', name, ref(other)),
        )
      }
    }
  return {
    ok: true,
    titleId: section,
    place: folderPath ? `${sectionPlace}${CLAUDE_PATH_SEP}${folderPath}` : sectionPlace,
    titleName: title ? titleName(title) : '',
    records: [
      ...(writeFolders ? chain.filter((c) => c.isNew).map((c) => ({ table: 'ideaFolders' as const, record: c.folder })) : []),
      ...fits.map((m) => ({ table: 'ideas' as const, record: m.record })),
    ],
    items: out.sort((a, b) => a.index - b.index),
    folders,
    folderPath,
    ...(target ? { targetFolderId: target } : {}),
    notes,
    ...(directNote ? { directNote } : {}),
    ...(placement === 'auto' && !target ? { auto1: true as const } : {}),
  }
}

// ---------- アイデアに追記（novel_append_to_idea） ----------

export interface AppendIdeaInput {
  /** 追記するアイデア（i:…） */
  idea_id?: unknown
  /** 読んだ印（novel_get_notes の本文の見出しの「印: 」の後ろの8字。「印: …」のまま・英大文字でもよい。normalizeReadMark） */
  read_mark?: unknown
  content?: unknown
}

/**
 * 結果。created = 依頼を作る、pending = 同じ依頼がもう出ている（書かない）、applied = 同じ依頼をもうアプリが足した（書かない）、
 * stale = 読んだ後に中身が変わった、not_claude = 作者が書いたアイデア、not_writable = 「読む＋書き込む」でないタイトルのアイデア、
 * pending_trash = ゴミ箱へ移す依頼中、in_trash = ゴミ箱にある、not_found = 見つからない（作者が書いたホームのアイデア・見せない
 * タイトルのアイデアも同じ）、ambiguous = 短い id が何枚にも当たる、too_long = 足すと1枚が長くなりすぎる、invalid = 形が違う
 */
export type IdeaAppendItemStatus =
  | 'created'
  | 'pending'
  | 'applied'
  | 'stale'
  | 'not_claude'
  | 'not_writable'
  | 'pending_trash'
  | 'in_trash'
  | 'not_found'
  | 'ambiguous'
  | 'too_long'
  | 'invalid'

export interface IdeaAppendBuild {
  status: IdeaAppendItemStatus
  /** 入力のまま（短く切る） */
  ref: string
  /** 指したアイデア（見つかった時） */
  ideaId?: ID
  /** 「「2026/11/12 14:32　第3章の動機」（ホームのアイデア）」 */
  label?: string
  hint?: string
  candidates?: string[]
  /** 作る依頼・もう出ている依頼（created・pending）と、その id（applied も） */
  request?: IdeaAppend
  requestId?: ID
  /** 足す内容（そろえた後） */
  text?: string
  records: { table: 'ideaAppends'; record: IdeaAppend }[]
}

/** 追記できる時の印の行・答えの表記（「「1行目」（場所）」。2.9: フォルダに入っていれば場所にフォルダも「＞」でつなぐ） */
function ideaLabel(view: AppData, idea: Idea): string {
  return `「${ideaHeadLine(idea, 40)}」（${ideaPathLabel(view, idea)}）`
}

export const IDEA_APPEND_HINTS = {
  stale:
    '読んだ後にこのアイデアの中身が変わりました（作者がアプリで直した・ほかの追記が入った）。novel_get_notes で読み直し、今の中身を踏まえて書いてから、新しい印（本文の見出しの「印: 」の後ろの8字）を read_mark に渡して送ってください',
  read_mark_missing:
    'read_mark がありません（novel_get_notes で今の中身を読み、本文の見出しの「印: 」の後ろの8字を渡してください）',
  read_mark_format:
    'read_mark の形が違います（novel_get_notes（kind=ideas・ids にこの id）の本文の見出しの「印: 」の後ろの8字を渡してください。例 1i30lfcq）',
  not_claude: '作者が書いたアイデアには追記できません（追記できるのは、Claude がこのコネクタで作ったアイデアだけ）',
  pending_trash: 'ゴミ箱へ移す依頼の出ているアイデアです（追記できません）',
  in_trash: 'アプリのゴミ箱にあります（作者がゴミ箱から戻すと追記できます）',
  not_found:
    '見つかりません（novel_get_notes の kind=ideas で id を確かめてください。作者が書いたホームのアイデアと「見せない」タイトルのアイデアは見えません）',
  ambiguous: '短い id が何枚ものアイデアに当たります（id を長く指定してください）',
} as const

/**
 * アイデアに追記する依頼を作る。指せるのは Claude に見せているアイデアだけ（view。追記の依頼を当てた形）。
 * 同じ内容をもう一度送っても増えない（依頼の id は、アイデア・読んだ印・内容から作る。読んだ印を確かめる前に見る）
 */
export function buildIdeaAppend(raw: AppData, view: AppData, input: AppendIdeaInput, ctx: IdeaWriteContext): IdeaAppendBuild {
  const x: AppendIdeaInput = input && typeof input === 'object' ? input : {}
  const rawRef = typeof x.idea_id === 'string' ? x.idea_id.trim() : ''
  const ref = cut(rawRef || String(x.idea_id ?? ''), IDEA_LIMITS.ref)
  const refuse = (status: IdeaAppendItemStatus, hint: string, more: Partial<IdeaAppendBuild> = {}): IdeaAppendBuild => ({
    status,
    ref,
    hint,
    records: [],
    ...more,
  })
  if (!rawRef || charCount(rawRef) > IDEA_LIMITS.ref) return refuse('invalid', 'idea_id の形が違います（i:… を渡してください）')
  if (typeof x.read_mark !== 'string' || !x.read_mark.trim()) return refuse('invalid', IDEA_APPEND_HINTS.read_mark_missing)
  if (typeof x.content !== 'string') return refuse('invalid', 'content がありません')
  // 「印: 1i30lfcq」・全角のコロン・英大文字でも、印の8字にそろえる（依頼の id と読んだ印の比べ方はそろえた後の印で。形は下で確かめる）
  const mark = charCount(x.read_mark) > IDEA_LIMITS.mark ? '' : normalizeReadMark(x.read_mark)
  const hits = Object.values(view.ideas).filter((i) => matchesId('idea', rawRef, i.id))
  if (hits.length > 1)
    return refuse('ambiguous', IDEA_APPEND_HINTS.ambiguous, {
      candidates: hits.slice(0, 10).map((i) => `${shortId('idea', i.id)} ${ideaLabel(view, i)}`),
    })
  if (!hits.length) {
    if (liveTrashRequests(raw).some((r) => r.table === 'ideas' && matchesId('idea', rawRef, r.targetId)))
      return refuse('pending_trash', IDEA_APPEND_HINTS.pending_trash)
    const trashed = Object.values(raw.trashRecords).some((r) => {
      const id = (r.record as { id?: unknown } | undefined)?.id
      return r.table === 'ideas' && typeof id === 'string' && isTrashedClaudeIdea(r.record) && matchesId('idea', rawRef, id)
    })
    return trashed ? refuse('in_trash', IDEA_APPEND_HINTS.in_trash) : refuse('not_found', IDEA_APPEND_HINTS.not_found)
  }
  const idea = hits[0]
  const found = { ideaId: idea.id, label: ideaLabel(view, idea) }
  if (!isClaudeIdea(idea)) return refuse('not_claude', IDEA_APPEND_HINTS.not_claude, found)
  if (!ideaSectionWritable(view.titles, idea)) {
    const t = view.titles[idea.titleId ?? '']
    return refuse(
      'not_writable',
      `タイトル『${t ? titleName(t) : ''}』は「Claude に見せる」が「読むだけ」なので追記できません（作者がタイトル画面で「読む＋書き込む」にすると追記できます）`,
      found,
    )
  }
  const text = normalizeIdeaText(x.content)
  if (!text) return refuse('invalid', 'content が空です', found)
  const chars = charCount(text)
  if (chars > IDEA_LIMITS.appendText)
    return refuse(
      'invalid',
      `content は${fmt(IDEA_LIMITS.appendText)}字までです（いま ${fmt(chars)}字。分けて追記してください）`,
      found,
    )
  const md = ideaMarkdownLines(text)
  if (md.length) return refuse('invalid', markdownHint(md), found)
  // 印の形が違う（8字の英小文字と数字でない）: 中身が変わったのではないので、読み直しではなく形を直すように答える
  if (!READ_MARK.test(mark)) return refuse('invalid', IDEA_APPEND_HINTS.read_mark_format, found)
  // 同じ依頼（同じアイデア・読んだ印・内容）。読んだ印を確かめる前に見る（送り直しは、当てた後の印が変わっていても同じ答え）
  const rawIdea = Object.prototype.hasOwnProperty.call(raw.ideas, idea.id) ? raw.ideas[idea.id] : undefined
  const applied = new Set(rawIdea ? appendIdsOf(rawIdea) : [])
  let id: ID | null = null
  for (let g = 1; g <= MAX_GENERATION; g++) {
    const candidate = ideaAppendId(idea.id, mark, text, g)
    if (Object.prototype.hasOwnProperty.call(raw.ideaAppends ?? {}, candidate)) {
      const request = raw.ideaAppends[candidate]
      return { status: 'pending', ref, ...found, request, requestId: candidate, text, records: [] }
    }
    if (applied.has(candidate)) return { status: 'applied', ref, ...found, requestId: candidate, text, records: [] }
    // アプリが当てずに消した依頼（削除の印だけ残る）: 次の番号で頼み直す
    if (ctx.wasDeleted('ideaAppends', candidate)) continue
    id = candidate
    break
  }
  if (!id)
    return refuse('invalid', 'このアイデアには、もうこの内容で頼み直せません（作者にアプリで直してもらってください）', found)
  if (mark !== ideaReadMark(idea.body)) return refuse('stale', IDEA_APPEND_HINTS.stale, found)
  const nextBody = appendedBody(idea.body, { createdAt: ctx.now, text })
  if (charCount(nextBody) > IDEA_LIMITS.body)
    return refuse(
      'too_long',
      `カードが長くなりすぎます（1枚 ${fmt(IDEA_LIMITS.body)}字まで。いま ${fmt(charCount(idea.body))}字・追記 ${fmt(chars)}字）。新しいアイデアとして novel_add_ideas で足してください`,
      found,
    )
  const record: IdeaAppend = {
    id,
    ideaId: idea.id,
    text,
    readMark: mark,
    source: 'claude',
    v: IDEA_APPEND_VERSION,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
  const length = stableStringify(record).length
  if (length > IDEA_LIMITS.appendJson)
    return refuse(
      'invalid',
      `追記の依頼が大きすぎます（1件は JSON にして ${fmt(IDEA_LIMITS.appendJson)}字まで。いま ${fmt(length)}字。分けて追記してください）`,
      found,
    )
  return {
    status: 'created',
    ref,
    ...found,
    request: record,
    requestId: id,
    text,
    records: [{ table: 'ideaAppends', record }],
  }
}
