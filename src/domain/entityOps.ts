// タイトル・アイデア・メモ・設定項目・戦略（応募計画）の更新操作。
import { actsOf, adoptedMetrics, adoptedText, episodeNumbers, flatten, isSplit, missingActs, pieceLabel } from './structure'
import { bodyMetrics, textHash } from './text'
import { isValidPageSetup, PAGE_CHARS_MAX, PAGE_CHARS_MIN, PAGE_LINES_MAX, PAGE_LINES_MIN, samePageSetup } from './pageSetup'
import { isIdeaChecked, sortIdeas } from './ideaSort'
import {
  IDEA_FOLDER_NAME_MAX,
  buildIdeaTree,
  effectiveFolderId,
  effectiveParentId,
  folderNameKey,
  folderPathLabel,
  sectionOf,
  type IdeaTree,
} from './ideaFolders'

export { textHash }
import { orderOrigin, putInTrash, trashLabel, type TrashSpec } from './trash'
import { Tx, transact } from './tx'
import {
  TITLE_CLAUDE_TABLES,
  DomainError,
  type AppData,
  type ID,
  type Idea,
  type IdeaFolder,
  type Memo,
  type PageSetup,
  type SettingCategory,
  type SettingEntry,
  type SettingField,
  type SnapshotPiece,
  type SnapshotText,
  type Submission,
  type SubmissionSnapshot,
  type Title,
  type Version,
} from './types'
import { byOrder, newId, nextOrder, now, stepOrder } from './util'

/** 並べ替えで順番が変わったレコードを書き込む（別タブとの競合判定のため更新日時も進める） */
function putAll<T extends 'titles' | 'ideas' | 'memos' | 'settingCategories' | 'settingEntries' | 'submissions'>(
  tx: Tx,
  table: T,
  records: AppData[T][string][],
): void {
  const ts = now()
  for (const r of records) tx.put(table, { ...r, updatedAt: ts })
}

// ---------- タイトル ----------

export const DEFAULT_SETTING_CATEGORIES: { name: string; fieldTemplate: string[] }[] = [
  { name: 'キャラクター', fieldTemplate: ['読み', '年齢', '性別', '立場・役割', '性格', '外見', '背景'] },
  { name: '世界観', fieldTemplate: [] },
]

export function sortedTitles(data: AppData): Title[] {
  return Object.values(data.titles).sort(byOrder)
}

export function createTitle(data: AppData, name: string): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const ts = now()
    const title: Title = {
      id: newId(),
      name: name.trim() || '無題のタイトル',
      synopsis: '',
      chaptersEnabled: false,
      numbering: 'continuous',
      structure: [],
      strategyNote: '',
      order: nextOrder(tx.all('titles')),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('titles', title)
    DEFAULT_SETTING_CATEGORIES.forEach((c, i) => {
      tx.put('settingCategories', {
        id: newId(),
        titleId: title.id,
        name: c.name,
        fieldTemplate: [...c.fieldTemplate],
        order: i,
        createdAt: ts,
        updatedAt: ts,
      })
    })
    return title.id
  })
}

export function updateTitle(
  data: AppData,
  titleId: ID,
  patch: Partial<Pick<Title, 'name' | 'synopsis' | 'strategyNote'>>,
): AppData {
  return transact(data, (tx) => {
    const t = tx.get('titles', titleId)
    if (!t) throw new DomainError('タイトルが見つかりません')
    tx.put('titles', { ...t, ...patch, updatedAt: now() })
  }).data
}

/**
 * 通し読みの縦書きのページ表示の字数×行数（Title.pageSetup）。null = 決めない（既定の 40×32 に戻す）。
 * 範囲の外（字数 10〜60・行数 5〜60 の整数でない）は DomainError。同じ値なら何もしない
 */
export function setTitlePageSetup(data: AppData, titleId: ID, setup: PageSetup | null): AppData {
  if (setup !== null && !isValidPageSetup(setup)) {
    throw new DomainError(
      `字数×行数は、1行 ${PAGE_CHARS_MIN}〜${PAGE_CHARS_MAX}字・1ページ ${PAGE_LINES_MIN}〜${PAGE_LINES_MAX}行で決めてください`,
    )
  }
  const t = data.titles[titleId]
  if (!t) throw new DomainError('タイトルが見つかりません')
  if (setup === null ? t.pageSetup === undefined : isValidPageSetup(t.pageSetup) && samePageSetup(t.pageSetup, setup)) return data
  return transact(data, (tx) => {
    const next: Title = { ...t, updatedAt: now() }
    if (setup === null) delete next.pageSetup
    else next.pageSetup = { chars: setup.chars, lines: setup.lines }
    tx.put('titles', next)
  }).data
}

/** タイトル一覧の index 番目（0始まり）へ移す */
export function moveTitleTo(data: AppData, titleId: ID, index: number): AppData {
  return transact(data, (tx) => {
    const list = tx.all('titles').sort(byOrder)
    const from = list.findIndex((t) => t.id === titleId)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved)
    const ts = now()
    list.forEach((t, i) => {
      if (t.order !== i) tx.put('titles', { ...t, order: i, updatedAt: ts })
    })
  }).data
}

export function moveTitleStep(data: AppData, titleId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => putAll(tx, 'titles', stepOrder(tx.all('titles'), titleId, dir))).data
}

/** タイトルを消した時にホームの1段目と名前が重なったフォルダの名前に付けるタイトル名の上限（字の数。長ければ切って「…」） */
const FOLDER_TITLE_SUFFIX_MAX = 20

/**
 * ホームへ移すフォルダの名前（2.9）。ホームの1段目に同じ名前（folderNameKey）があれば「名前（タイトル名）」にする
 * （全体が40字までになるように名前の側を切る。それでも重なれば「 2」「 3」…を足す）。taken は使えない名前の鍵
 */
function homeFolderName(name: string, titleName: string, taken: ReadonlySet<string>): string {
  const t = Array.from(titleName.trim() || '無題のタイトル')
  const title = t.length > FOLDER_TITLE_SUFFIX_MAX ? `${t.slice(0, FOLDER_TITLE_SUFFIX_MAX - 1).join('')}…` : t.join('')
  for (let n = 1; ; n++) {
    const tail = `（${title}）${n > 1 ? ` ${n}` : ''}`
    const head = Array.from(name)
      .slice(0, IDEA_FOLDER_NAME_MAX - Array.from(tail).length)
      .join('')
      .trimEnd()
    const candidate = `${head}${tail}`
    if (!taken.has(folderNameKey(candidate))) return candidate
  }
}

/**
 * タイトルのフォルダをホーム（どのタイトルにも属さない）へ移す（2.9。カードと同じ）。中のつながり（親・カードの folderId）は
 * そのままなので、木の形も変わらない。1段目はホームの1段目の後ろへもとの順で入れ、2段目の並びはそのまま。
 * ホームの1段目と同じ名前の1段目は「名前（タイトル名）」にする（同じ段に同じ名前を作らない）。タイトルを戻してもフォルダは戻らない
 */
function moveTitleFoldersHome(tx: Tx, title: Title): void {
  const folders = tx.all('ideaFolders').filter((f) => f.titleId === title.id)
  if (!folders.length) return
  // 1段目かどうかは、タイトルがあるうちに見せ方の決まりで決める
  const data = tx.data
  const isTop = (f: IdeaFolder) => effectiveParentId(data, f) === null
  const homeTops = tx.all('ideaFolders').filter((f) => sectionOf(data.titles, f.titleId) === null && isTop(f))
  const homeKeys = new Set(homeTops.map((f) => folderNameKey(f.name)))
  const tops = folders.filter(isTop).sort(byOrder)
  const taken = new Set([...homeKeys, ...tops.map((f) => folderNameKey(f.name))])
  const placed = new Map<ID, Pick<IdeaFolder, 'name' | 'order'>>()
  let order = nextOrder(homeTops)
  for (const f of tops) {
    let name = f.name
    if (homeKeys.has(folderNameKey(f.name))) {
      name = homeFolderName(f.name, title.name, taken)
      taken.add(folderNameKey(name))
    }
    placed.set(f.id, { name, order: order++ })
  }
  const ts = now()
  for (const f of folders) tx.put('ideaFolders', { ...f, titleId: null, ...placed.get(f.id), updatedAt: ts })
}

/**
 * タイトルと配下（章・話・稿・メモ・設定項目・応募計画と、その応募時の原稿の控え、2.3 の推敲案・改稿案・戦略メモ・
 * 作品批評）をまとめてゴミ箱へ移す。共通の批評プロンプト（titleId = null）はほかのタイトルでも使うので残す。
 * タイトルに紐づくアイデアとアイデアのフォルダ（2.9）は「どのタイトルにも属さない」へ移す（ゴミ箱から戻してもアイデア・フォルダは
 * 戻らない）
 */
export function deleteTitle(data: AppData, titleId: ID): AppData {
  return transact(data, (tx) => {
    const title = tx.get('titles', titleId)
    if (!title) return
    moveTitleFoldersHome(tx, title)
    const belongs = (r: { titleId: ID | null }) => r.titleId === titleId
    const submissions = tx.all('submissions').filter(belongs).sort(byOrder)
    const records: TrashSpec['records'] = [
      { table: 'titles', record: title },
      ...tx
        .all('chapters')
        .filter(belongs)
        .map((record) => ({ table: 'chapters' as const, record })),
      ...tx
        .all('pieces')
        .filter(belongs)
        .map((record) => ({ table: 'pieces' as const, record })),
      ...tx
        .all('versions')
        .filter(belongs)
        .map((record) => ({ table: 'versions' as const, record })),
      ...memosOf(tx.data, titleId).map((record) => ({ table: 'memos' as const, record })),
      ...categoriesOf(tx.data, titleId).map((record) => ({ table: 'settingCategories' as const, record })),
      ...tx
        .all('settingEntries')
        .filter(belongs)
        .sort(byOrder)
        .map((record) => ({ table: 'settingEntries' as const, record })),
      ...submissions.map((record) => ({ table: 'submissions' as const, record })),
      ...usedSnapshotTexts(tx, submissions).map((record) => ({ table: 'snapshotTexts' as const, record })),
      ...TITLE_CLAUDE_TABLES.flatMap((table) =>
        (tx.all(table) as { id: ID; titleId: ID | null; createdAt: number }[])
          .filter(belongs)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((record) => ({ table, record }) as TrashSpec['records'][number]),
      ),
    ]
    putInTrash(tx, {
      kind: 'title',
      label: trashLabel.title(title),
      titleName: title.name,
      origin: { titleId: null, ...orderOrigin(tx.all('titles'), titleId) },
      records,
    })
    collectSnapshotTexts(tx)
    // カードは入っているフォルダ（folderId）を持ったまま移すので、フォルダの中の並びも変わらない
    let order = nextOrder(tx.all('ideas').filter((i) => i.titleId === null))
    for (const idea of tx.all('ideas').filter(belongs).sort(byOrder)) {
      tx.put('ideas', { ...idea, titleId: null, order: order++, updatedAt: now() })
    }
  }).data
}

export interface TitleSummary {
  episodes: number
  specials: number
  /** 採用原稿がない話・特殊ブロックの合計 */
  missingActive: number
  /** 採用原稿がない第n話の数 */
  missingEpisodes: number
  /** 採用原稿がない特殊ブロックの数 */
  missingSpecials: number
  /** 幕に分けた話のうち、採用稿がない幕の数（missingActive にも入る） */
  missingActs: number
  activeChars: number
}

export function titleSummary(data: AppData, titleId: ID): TitleSummary {
  const summary: TitleSummary = {
    episodes: 0,
    specials: 0,
    missingActive: 0,
    missingEpisodes: 0,
    missingSpecials: 0,
    missingActs: 0,
    activeChars: 0,
  }
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    if (p.kind === 'episode') summary.episodes += 1
    else summary.specials += 1
    const m = adoptedMetrics(data, p)
    if (m) summary.activeChars += m.chars
    if (isSplit(p)) {
      // 幕に分けた話は、採用稿のない幕を採用原稿のないものとして数える
      const acts = missingActs(data, p)
      summary.missingActs += acts
      summary.missingActive += acts
    } else if (m === null) {
      summary.missingActive += 1
      if (p.kind === 'episode') summary.missingEpisodes += 1
      else summary.missingSpecials += 1
    }
  }
  return summary
}

/** 「採用原稿なし 2話＋特殊1」のような表記（話と特殊ブロック・幕を分けて数える）。どれも0なら空文字 */
export function missingActiveLabel(missingEpisodes: number, missingSpecials: number, missingActs = 0): string {
  const parts: string[] = []
  if (missingEpisodes > 0) parts.push(`${missingEpisodes}話`)
  if (missingSpecials > 0) parts.push(`特殊${missingSpecials}`)
  if (missingActs > 0) parts.push(`${missingActs}幕`)
  return parts.length > 0 ? `採用原稿なし ${parts.join('＋')}` : ''
}

/** タイトル配下のどれかが最後に編集された日時（原稿の編集も含む） */
export function titleLastEdited(data: AppData, titleId: ID): number {
  let latest = data.titles[titleId]?.updatedAt ?? 0
  const tables = ['chapters', 'pieces', 'versions', 'memos', 'settingCategories', 'settingEntries', 'submissions'] as const
  for (const table of tables) {
    for (const r of Object.values(data[table]) as { titleId: ID; updatedAt: number }[]) {
      if (r.titleId === titleId && r.updatedAt > latest) latest = r.updatedAt
    }
  }
  return latest
}

// ---------- アイデア ----------

export interface IdeaSection {
  /** null = どのタイトルにも属さない */
  titleId: ID | null
  name: string
  /** 仕切りのすべてのカード（フォルダの中も。並び（sortIdeas）: 済みでないもの → 済み）。件数・目次・書きとめる先に使う */
  ideas: Idea[]
  /** 2.9: 仕切りの木（フォルダ（2段まで）とフォルダの外のカード。src/domain/ideaFolders.ts の buildIdeaTree） */
  tree: IdeaTree
}

// 済みと並び（isIdeaChecked・sortIdeas）は ideaSort.ts にある（フォルダの見せ方・ゴミ箱からも使う）。前からの読み込みのために、
// ここからも同じ名前で出す
export { isIdeaChecked, sortIdeas }

/** ideaSections の最後の答え（アイデア・フォルダ・タイトルの表が同じなら作り直さない。ほかの表の変更では木を組み直さない） */
let sectionsMemo: {
  ideas: AppData['ideas']
  ideaFolders: AppData['ideaFolders']
  titles: AppData['titles']
  sections: IdeaSection[]
} | null = null

/**
 * アイデア領域の仕切り。タイトルの数だけ仕切りがあり、最後に「どのタイトルにも属さない」（タイトルが無いカード・フォルダもここ）。
 * 同じ表に対しては同じ答え（配列）を返すので、呼び出し側で並べ替えたり書き換えたりしない
 */
export function ideaSections(data: AppData): IdeaSection[] {
  const memo = sectionsMemo
  if (memo && memo.ideas === data.ideas && memo.ideaFolders === data.ideaFolders && memo.titles === data.titles) {
    return memo.sections
  }
  const ideas = sortIdeas(Object.values(data.ideas))
  const bySection = new Map<ID | null, Idea[]>()
  for (const i of ideas) {
    const key = sectionOf(data.titles, i.titleId)
    const list = bySection.get(key)
    if (list) list.push(i)
    else bySection.set(key, [i])
  }
  const sections: IdeaSection[] = sortedTitles(data).map((t) => ({
    titleId: t.id,
    name: t.name,
    ideas: bySection.get(t.id) ?? [],
    tree: buildIdeaTree(data, t.id),
  }))
  sections.push({
    titleId: null,
    name: 'どのタイトルにも属さない',
    ideas: bySection.get(null) ?? [],
    tree: buildIdeaTree(data, null),
  })
  sectionsMemo = { ideas: data.ideas, ideaFolders: data.ideaFolders, titles: data.titles, sections }
  return sections
}

/** カードの入れ物（仕切り＋入っているフォルダ。フォルダの外は null）。見せ方の決まり（ideaFolders.ts）で決める */
function ideaContainer(data: AppData, idea: Idea): { section: ID | null; folderId: ID | null } {
  return { section: sectionOf(data.titles, idea.titleId), folderId: effectiveFolderId(data, idea) }
}

/** 同じ入れ物（仕切り＋フォルダ）のカードか */
function inContainer(data: AppData, idea: Idea, section: ID | null, folderId: ID | null): boolean {
  return sectionOf(data.titles, idea.titleId) === section && effectiveFolderId(data, idea) === folderId
}

/** 同じ入れ物（仕切り＋フォルダ。null = フォルダの外）の、済みでないアイデア（order の順） */
function openIdeasIn(tx: Tx, section: ID | null, folderId: ID | null, exceptId?: ID): Idea[] {
  return tx
    .all('ideas')
    .filter((i) => i.id !== exceptId && !isIdeaChecked(i) && inContainer(tx.data, i, section, folderId))
    .sort(byOrder)
}

/** 入れ物の末尾の order（済みのものも含めた最大の次。済みでないアイデアの末尾になる） */
function nextIdeaOrder(tx: Tx, section: ID | null, folderId: ID | null, exceptId?: ID): number {
  return nextOrder(tx.all('ideas').filter((i) => i.id !== exceptId && inContainer(tx.data, i, section, folderId)))
}

/**
 * 入っているフォルダを付け替える（2.9）。null = フォルダの外（項目ごと消す。null は書かない: 同期の3者マージで、項目の無い古い
 * カードと同じに見えるように）
 */
export function withIdeaFolder(idea: Idea, folderId: ID | null): Idea {
  const { folderId: _f, ...rest } = idea
  void _f
  return folderId === null ? rest : { ...rest, folderId }
}

/** 移す先・足す先の入れ物を確かめる（タイトルがある・フォルダがあり同じ仕切り） */
function requireContainer(tx: Tx, titleId: ID | null, folderId: ID | null): void {
  if (titleId !== null && !tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
  if (folderId === null) return
  const f = tx.get('ideaFolders', folderId)
  if (!f || sectionOf(tx.data.titles, f.titleId) !== titleId) throw new DomainError('フォルダが見つかりません')
}

/**
 * アイデアを足す（入れ物の済みでないものの末尾）。folderId（2.9）を渡すと、そのフォルダ（どちらの段でもよい。同じ仕切り）に入れる。
 * 今の版の画面からは見出しを渡さない（heading は古い形のデータを作るテスト用）
 */
export function addIdea(
  data: AppData,
  titleId: ID | null,
  heading = '',
  body = '',
  folderId: ID | null = null,
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireContainer(tx, titleId, folderId)
    const ts = now()
    const idea: Idea = {
      id: newId(),
      titleId,
      heading,
      body,
      checked: false,
      checkedAt: null,
      order: nextIdeaOrder(tx, titleId, folderId),
      ...(folderId === null ? {} : { folderId }),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('ideas', idea)
    return idea.id
  })
}

/**
 * 見出し・内容を書き換える。何も変わらない時は書き込まず、同じデータを返す（updatedAt も進めない。2.8: 何も変えずに保存しても、
 * Claude が作ったアイデアを「作者が直した」にしない。同期で送るものも増やさない）
 */
export function updateIdea(data: AppData, ideaId: ID, patch: Partial<Pick<Idea, 'heading' | 'body'>>): AppData {
  const r = transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) throw new DomainError('アイデアが見つかりません')
    if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => patch[k] === i[k])) return false
    tx.put('ideas', { ...i, ...patch, updatedAt: now() })
    return true
  })
  return r.result ? r.data : data
}

/**
 * 済みにする・外す。済みにすると斜線＋グレーで入れ物（仕切り・フォルダ）の下へ沈む（並びは sortIdeas）。
 * 外すと、入れ物の済みでないアイデアの末尾に戻る。削除（ゴミ箱）とは別
 */
export function setIdeaChecked(data: AppData, ideaId: ID, checked: boolean): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) throw new DomainError('アイデアが見つかりません')
    if (isIdeaChecked(i) === checked) return
    const ts = now()
    const { section, folderId } = ideaContainer(tx.data, i)
    tx.put('ideas', {
      ...i,
      checked,
      checkedAt: checked ? ts : null,
      ...(checked ? {} : { order: nextIdeaOrder(tx, section, folderId, i.id) }),
      updatedAt: ts,
    })
  }).data
}

/**
 * 別の仕切り（タイトル or どのタイトルにも属さない）のフォルダの外へ移す（「この案でタイトルを作る」など）。移動先の末尾に入る
 * （済みのものは済みのまま）。入っていたフォルダからは出す（2.9。フォルダは仕切りの中のもの）
 */
export function moveIdeaToSection(data: AppData, ideaId: ID, titleId: ID | null): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i) throw new DomainError('アイデアが見つかりません')
    if (titleId !== null && !tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    if (i.titleId === titleId && effectiveFolderId(tx.data, i) === null) return
    tx.put('ideas', { ...withIdeaFolder(i, null), titleId, order: nextIdeaOrder(tx, titleId, null, i.id), updatedAt: now() })
  }).data
}

/**
 * アイデアを指定の入れ物（仕切り（null = どのタイトルにも属さない）＋フォルダ（2.9。null = フォルダの外））の、済みでないアイデアの
 * 中の index 番目（0始まり）へ移す。フォルダは移す先の仕切りのもの（どちらの段でもよい）。フォルダの外へ移すと項目ごと消す。
 * 済みのアイデアは位置を選べない（移動先でも済みのまま下にまとまる）ので、index は使わず入れ物だけ移す
 */
export function moveIdeaTo(data: AppData, ideaId: ID, titleId: ID | null, index: number, folderId: ID | null = null): AppData {
  return transact(data, (tx) => {
    const idea = tx.get('ideas', ideaId)
    if (!idea) throw new DomainError('アイデアが見つかりません')
    requireContainer(tx, titleId, folderId)
    const moved = idea.titleId !== titleId || effectiveFolderId(tx.data, idea) !== folderId
    const placed: Idea = moved ? { ...withIdeaFolder(idea, folderId), titleId } : idea
    if (isIdeaChecked(idea)) {
      if (moved) tx.put('ideas', { ...placed, order: nextIdeaOrder(tx, titleId, folderId, ideaId), updatedAt: now() })
      return
    }
    const list = openIdeasIn(tx, titleId, folderId, ideaId)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, placed)
    const ts = now()
    list.forEach((it, i) => {
      if (it.order !== i || (it.id === ideaId && moved)) tx.put('ideas', { ...it, order: i, updatedAt: ts })
    })
  }).data
}

/** 同じ入れ物（仕切り＋フォルダ）の済みでないアイデアの中で1つ上（-1）・下（+1）へ。済みのアイデアは動かさない */
export function moveIdeaStep(data: AppData, ideaId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const i = tx.get('ideas', ideaId)
    if (!i || isIdeaChecked(i)) return
    const { section, folderId } = ideaContainer(tx.data, i)
    putAll(tx, 'ideas', stepOrder(openIdeasIn(tx, section, folderId), ideaId, dir))
  }).data
}

/** アイデアをゴミ箱へ移す（済みかどうかもそのまま控え、戻すと同じ状態に戻る） */
export function deleteIdea(data: AppData, ideaId: ID): AppData {
  return transact(data, (tx) => {
    const idea = tx.get('ideas', ideaId)
    if (!idea) return
    trashIdea(tx, idea)
  }).data
}

/** ゴミ箱へ入れる時の決まり（2.8: Claude の依頼で移す時の時刻・ゴミ箱の id・印。src/domain/claudeTrash.ts） */
export type IdeaTrashOptions = Pick<TrashSpec, 'at' | 'entryId' | 'recordId' | 'by'>

/**
 * アイデア1つをゴミ箱の1件にする（作者の削除と Claude の依頼で同じ形。仕切りのタイトル名と、戻す位置を控える）。
 * 2.9: 戻す位置は入れ物（仕切り＋フォルダ）の中で控え、フォルダの中なら場所の表記（「新作の相談 › 雨の駅」）も控える。
 * 戻すと、Claude が作ったアイデアの項目（source・claudeHash・appendIds など）と入っていたフォルダもそのまま戻る
 */
export function trashIdea(tx: Tx, idea: Idea, opts: IdeaTrashOptions = {}): ID {
  // 存在しないタイトルを指すアイデアは「どのタイトルにも属さない」に表示されているので、そこにあったものとして控える
  const { section, folderId } = ideaContainer(tx.data, idea)
  const title = section === null ? undefined : tx.get('titles', section)
  // 戻す位置は、同じ入れ物の同じ側（済みでないもの・済みのもの）の並びの中で控える（済みのものは並び順を使わないため）
  const checked = isIdeaChecked(idea)
  const peers = tx.all('ideas').filter((i) => isIdeaChecked(i) === checked && inContainer(tx.data, i, section, folderId))
  return putInTrash(tx, {
    kind: 'idea',
    label: trashLabel.idea(idea),
    titleName: title?.name ?? '',
    ...(folderId === null ? {} : { parentLabel: folderPathLabel(tx.data, folderId) }),
    origin: { titleId: section, ...orderOrigin(peers, idea.id) },
    records: [{ table: 'ideas', record: idea }],
    ...opts,
  })
}

// ---------- メモ（付箋。タイトル内で常に一番下に表示） ----------

export function memosOf(data: AppData, titleId: ID): Memo[] {
  return Object.values(data.memos)
    .filter((m) => m.titleId === titleId)
    .sort(byOrder)
}

export function addMemo(data: AppData, titleId: ID, name = '新しいメモ'): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const memo: Memo = {
      id: newId(),
      titleId,
      name: name.trim() || '新しいメモ',
      body: '',
      order: nextOrder(tx.all('memos').filter((m) => m.titleId === titleId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('memos', memo)
    return memo.id
  })
}

export function updateMemo(data: AppData, memoId: ID, patch: Partial<Pick<Memo, 'name' | 'body'>>): AppData {
  return transact(data, (tx) => {
    const m = tx.get('memos', memoId)
    if (!m) throw new DomainError('メモが見つかりません')
    tx.put('memos', { ...m, ...patch, updatedAt: now() })
  }).data
}

export function moveMemoStep(data: AppData, memoId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const m = tx.get('memos', memoId)
    if (!m) return
    putAll(
      tx,
      'memos',
      stepOrder(
        tx.all('memos').filter((x) => x.titleId === m.titleId),
        memoId,
        dir,
      ),
    )
  }).data
}

/** メモをゴミ箱へ移す */
export function deleteMemo(data: AppData, memoId: ID): AppData {
  return transact(data, (tx) => {
    const memo = tx.get('memos', memoId)
    if (!memo) return
    putInTrash(tx, {
      kind: 'memo',
      label: trashLabel.memo(memo),
      titleName: tx.get('titles', memo.titleId)?.name ?? '',
      origin: { titleId: memo.titleId, ...orderOrigin(memosOf(tx.data, memo.titleId), memoId) },
      records: [{ table: 'memos', record: memo }],
    })
  }).data
}

// ---------- 設定項目 ----------

export function categoriesOf(data: AppData, titleId: ID): SettingCategory[] {
  return Object.values(data.settingCategories)
    .filter((c) => c.titleId === titleId)
    .sort(byOrder)
}

export function entriesOf(data: AppData, categoryId: ID): SettingEntry[] {
  return Object.values(data.settingEntries)
    .filter((e) => e.categoryId === categoryId)
    .sort(byOrder)
}

export function addCategory(
  data: AppData,
  titleId: ID,
  name: string,
  fieldTemplate: string[] = [],
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const cat: SettingCategory = {
      id: newId(),
      titleId,
      name: name.trim() || '新しい設定項目',
      fieldTemplate,
      order: nextOrder(tx.all('settingCategories').filter((c) => c.titleId === titleId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('settingCategories', cat)
    return cat.id
  })
}

export function updateCategory(
  data: AppData,
  categoryId: ID,
  patch: Partial<Pick<SettingCategory, 'name' | 'fieldTemplate'>>,
): AppData {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) throw new DomainError('設定項目が見つかりません')
    tx.put('settingCategories', { ...c, ...patch, updatedAt: now() })
  }).data
}

export function moveCategoryStep(data: AppData, categoryId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) return
    putAll(
      tx,
      'settingCategories',
      stepOrder(
        tx.all('settingCategories').filter((x) => x.titleId === c.titleId),
        categoryId,
        dir,
      ),
    )
  }).data
}

/** 設定項目と、その中のエントリをまとめてゴミ箱へ移す */
export function deleteCategory(data: AppData, categoryId: ID): AppData {
  return transact(data, (tx) => {
    const cat = tx.get('settingCategories', categoryId)
    if (!cat) return
    putInTrash(tx, {
      kind: 'settingCategory',
      label: trashLabel.category(cat),
      titleName: tx.get('titles', cat.titleId)?.name ?? '',
      origin: { titleId: cat.titleId, ...orderOrigin(categoriesOf(tx.data, cat.titleId), categoryId) },
      records: [
        { table: 'settingCategories', record: cat },
        ...entriesOf(tx.data, categoryId).map((record) => ({ table: 'settingEntries' as const, record })),
      ],
    })
  }).data
}

export function addEntry(data: AppData, categoryId: ID, name = ''): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const c = tx.get('settingCategories', categoryId)
    if (!c) throw new DomainError('設定項目が見つかりません')
    const ts = now()
    const entry: SettingEntry = {
      id: newId(),
      titleId: c.titleId,
      categoryId,
      name,
      fields: c.fieldTemplate.map((key): SettingField => ({ id: newId(), key, value: '' })),
      body: '',
      order: nextOrder(tx.all('settingEntries').filter((e) => e.categoryId === categoryId)),
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('settingEntries', entry)
    return entry.id
  })
}

export function updateEntry(data: AppData, entryId: ID, patch: Partial<Pick<SettingEntry, 'name' | 'body' | 'fields'>>): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    if (!e) throw new DomainError('エントリが見つかりません')
    tx.put('settingEntries', { ...e, ...patch, updatedAt: now() })
  }).data
}

export function moveEntryStep(data: AppData, entryId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    if (!e) return
    putAll(
      tx,
      'settingEntries',
      stepOrder(
        tx.all('settingEntries').filter((x) => x.categoryId === e.categoryId),
        entryId,
        dir,
      ),
    )
  }).data
}

export function moveEntryToCategory(data: AppData, entryId: ID, categoryId: ID): AppData {
  return transact(data, (tx) => {
    const e = tx.get('settingEntries', entryId)
    const c = tx.get('settingCategories', categoryId)
    if (!e || !c) throw new DomainError('移動先が見つかりません')
    if (c.titleId !== e.titleId) throw new DomainError('別タイトルの設定項目には移動できません')
    if (e.categoryId === categoryId) return
    const order = nextOrder(tx.all('settingEntries').filter((x) => x.categoryId === categoryId))
    tx.put('settingEntries', { ...e, categoryId, order, updatedAt: now() })
  }).data
}

/** 設定エントリをゴミ箱へ移す */
export function deleteEntry(data: AppData, entryId: ID): AppData {
  return transact(data, (tx) => {
    const entry = tx.get('settingEntries', entryId)
    if (!entry) return
    const cat = tx.get('settingCategories', entry.categoryId)
    putInTrash(tx, {
      kind: 'settingEntry',
      label: trashLabel.entry(entry),
      titleName: tx.get('titles', entry.titleId)?.name ?? '',
      parentLabel: cat ? trashLabel.category(cat) : undefined,
      origin: {
        titleId: entry.titleId,
        categoryId: entry.categoryId,
        ...orderOrigin(entriesOf(tx.data, entry.categoryId), entryId),
      },
      records: [{ table: 'settingEntries', record: entry }],
    })
  }).data
}

// ---------- 戦略（応募計画・結果・改稿/再応募方針） ----------

export const SUBMISSION_STATUSES: { value: Submission['status']; label: string }[] = [
  { value: 'considering', label: '検討中' },
  { value: 'planned', label: '応募予定' },
  { value: 'submitted', label: '応募済み' },
  { value: 'reviewing', label: '選考中' },
  { value: 'passed', label: '選考通過' },
  { value: 'won', label: '受賞' },
  { value: 'rejected', label: '落選' },
  { value: 'withdrawn', label: '取り下げ' },
]

export function submissionStatusLabel(status: Submission['status']): string {
  return SUBMISSION_STATUSES.find((s) => s.value === status)?.label ?? status
}

export function submissionsOf(data: AppData, titleId: ID): Submission[] {
  return Object.values(data.submissions)
    .filter((s) => s.titleId === titleId)
    .sort(byOrder)
}

export function addSubmission(data: AppData, titleId: ID, contestName = ''): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    if (!tx.get('titles', titleId)) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const s: Submission = {
      id: newId(),
      titleId,
      order: nextOrder(tx.all('submissions').filter((x) => x.titleId === titleId)),
      contestName,
      organizer: '',
      url: '',
      deadline: '',
      submittedOn: '',
      resultOn: '',
      status: 'considering',
      stage: '',
      overview: '',
      minChars: null,
      maxChars: null,
      limitUnit: 'chars',
      limitNote: '',
      synopsis: '',
      synopsisMin: null,
      synopsisMax: null,
      catchphrase: '',
      catchphraseMin: null,
      catchphraseMax: null,
      specialNotes: '',
      result: '',
      revisionPlan: '',
      resubmissionPlan: '',
      snapshot: null,
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('submissions', s)
    return s.id
  })
}

export type SubmissionPatch = Partial<Omit<Submission, 'id' | 'titleId' | 'order' | 'createdAt' | 'updatedAt'>>

export function updateSubmission(data: AppData, submissionId: ID, patch: SubmissionPatch): AppData {
  return transact(data, (tx) => {
    const s = tx.get('submissions', submissionId)
    if (!s) throw new DomainError('応募計画が見つかりません')
    tx.put('submissions', { ...s, ...patch, updatedAt: now() })
  }).data
}

export function moveSubmissionStep(data: AppData, submissionId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const s = tx.get('submissions', submissionId)
    if (!s) return
    putAll(
      tx,
      'submissions',
      stepOrder(
        tx.all('submissions').filter((x) => x.titleId === s.titleId),
        submissionId,
        dir,
      ),
    )
  }).data
}

/** 応募計画をゴミ箱へ移す。応募時の原稿の控えも写しを入れるので、戻せば応募した原稿もまた読める */
export function deleteSubmission(data: AppData, submissionId: ID): AppData {
  return transact(data, (tx) => {
    const s = tx.get('submissions', submissionId)
    if (!s) return
    putInTrash(tx, {
      kind: 'submission',
      label: trashLabel.submission(s),
      titleName: tx.get('titles', s.titleId)?.name ?? '',
      origin: { titleId: s.titleId, ...orderOrigin(submissionsOf(tx.data, s.titleId), submissionId) },
      records: [
        { table: 'submissions', record: s },
        ...usedSnapshotTexts(tx, [s]).map((record) => ({ table: 'snapshotTexts' as const, record })),
      ],
    })
    collectSnapshotTexts(tx)
  }).data
}

/** 応募記録が使っている本文の控え（重複なし） */
function usedSnapshotTexts(tx: Tx, submissions: Submission[]): SnapshotText[] {
  const out = new Map<ID, SnapshotText>()
  for (const s of submissions) {
    for (const p of Object.values(s.snapshot?.pieces ?? {})) {
      const text = p.textKey ? tx.get('snapshotTexts', p.textKey) : undefined
      if (text) out.set(text.id, text)
    }
  }
  return [...out.values()]
}

/** 本文の控えの保存キー。指紋と長さを組み合わせ、万一衝突したら連番を付ける */
function snapshotTextKey(data: AppData, body: string, hash: string, pending: Map<ID, string>): ID {
  const base = `${hash}-${body.length.toString(36)}`
  for (let n = 0; ; n++) {
    const key = n === 0 ? base : `${base}-${n}`
    const existing = pending.get(key) ?? data.snapshotTexts[key]?.body
    if (existing === undefined || existing === body) return key
  }
}

/**
 * 現在の採用原稿の状態（どの話にどの稿を採用しているか・総文字数・本文の指紋）。
 * texts には記録用の本文の控え（キー → 本文）が入る。
 */
export function takeSnapshot(data: AppData, titleId: ID, withTexts = true): SubmissionSnapshot & { texts: Map<ID, string> } {
  const activeVersions: Record<ID, ID | null> = {}
  const pieces: Record<ID, SnapshotPiece> = {}
  const order: ID[] = []
  const texts = new Map<ID, string>()
  const numbers = episodeNumbers(data, titleId)
  let charCount = 0
  let pages = 0
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    const v = adoptedText(data, p)
    const m = v ? bodyMetrics(v) : null
    // 幕に分けた話は各幕の採用稿をつないだ本文を記録する。稿の印は話自身の（分けた時の）採用稿
    // （分けても本文は変わらないので、分けただけでは「稿が変わった」にならない）
    const split = isSplit(p)
    const versionId = !v ? null : split ? (p.activeVersionId ?? `${p.id}:acts`) : (v as Version).id
    const versionName = !v ? null : split ? `${actsOf(data, p).length}幕に分けた原稿` : (v as Version).name
    activeVersions[p.id] = versionId
    order.push(p.id)
    let textKey: ID | null = null
    if (v && m && withTexts) {
      textKey = snapshotTextKey(data, v.body, m.hash, texts)
      texts.set(textKey, v.body)
    }
    pieces[p.id] = {
      kind: p.kind,
      label: pieceLabel(data, p, numbers),
      subtitle: p.subtitle,
      versionId,
      versionName,
      chars: m ? m.chars : 0,
      textKey,
      hash: m ? m.hash : textHash(''),
    }
    if (m) {
      charCount += m.chars
      pages += m.manuscriptPages
    }
  }
  return { at: now(), charCount, activeVersions, pages, order, pieces, texts }
}

/** どの応募記録からも参照されなくなった本文の控えを消す */
function collectSnapshotTexts(tx: Tx): void {
  const used = new Set<ID>()
  for (const s of tx.all('submissions')) {
    for (const p of Object.values(s.snapshot?.pieces ?? {})) if (p.textKey) used.add(p.textKey)
  }
  for (const t of tx.all('snapshotTexts')) if (!used.has(t.id)) tx.delete('snapshotTexts', t.id)
}

/** 記録した本文の控え（古い記録は記録内の本文、採用原稿がなかった話は null） */
export function snapshotPieceBody(data: AppData, piece: SnapshotPiece): string | null {
  if (piece.textKey) return data.snapshotTexts[piece.textKey]?.body ?? null
  return piece.body ?? null
}

/** 応募時の記録の文字数・枚数（今の数え方で数え直したもの） */
export interface SnapshotCounts {
  /** 総文字数（空白・改行、ルビ・傍点の記号とルビの読みを除く） */
  charCount: number
  /** 400字詰め原稿用紙換算の枚数（古い記録で数えられなければ null） */
  pages: number | null
  /** pieceId -> 文字数（話ごとの内容がない古い記録は空） */
  chars: Record<ID, number>
}

/** 本文の控えのレコード（古い記録は記録の中の本文）。採用原稿がなかった話・控えがまだ届いていない話は null */
function snapshotPieceRecord(data: Pick<AppData, 'snapshotTexts'>, p: SnapshotPiece): { body: string } | null {
  if (p.textKey) return data.snapshotTexts[p.textKey] ?? null
  return typeof p.body === 'string' ? (p as { body: string }) : null
}

/**
 * 記録の文字数・枚数を今の数え方で。記録に残した数は 2.0 までの数え方（ルビの記号と読みも数えていた）のことがあるので、
 * 本文の控えがあれば数え直す（記録そのものは書き換えない）。控えのない話は記録した数のまま。
 * 数え直しは本文の控えのレコードごとに1回だけ（bodyMetrics のキャッシュ）。
 */
export function snapshotCounts(data: Pick<AppData, 'snapshotTexts'>, s: SubmissionSnapshot): SnapshotCounts {
  if (!s.pieces) return { charCount: s.charCount, pages: s.pages ?? null, chars: {} }
  let charCount = 0
  let pages = 0
  /** どの話も本文の控えから数えられた（採用原稿があった話の控えが欠けていない） */
  let complete = true
  const chars: Record<ID, number> = {}
  for (const [id, p] of Object.entries(s.pieces)) {
    const rec = snapshotPieceRecord(data, p)
    const m = rec ? bodyMetrics(rec) : null
    if (!m && p.versionId !== null) complete = false
    chars[id] = m ? m.chars : p.chars
    charCount += chars[id]
    if (m) pages += m.manuscriptPages
  }
  // 控えが欠けている時の枚数は、記録した枚数（なければ数えられた分だけ）
  return { charCount, pages: complete || typeof s.pages !== 'number' ? pages : s.pages, chars }
}

export interface SnapshotDiff {
  /** 採用する稿が変わった話（追加・削除された話は added / removed に入る） */
  switched: ID[]
  /** 同じ稿のまま本文が変わった話 */
  edited: ID[]
  /** 記録時より後に追加された話 */
  added: ID[]
  /** 記録時にはあったが今はない話 */
  removed: ID[]
  charDelta: number
}

/**
 * 記録した時点と今の採用原稿を比べる（本文の指紋で比べるので、稿の名前やメモの変更は数えない）。
 * 文字数の差は、記録の文字数を今の数え方で数え直して比べる（snapshotCounts）
 */
export function compareSnapshotWithCurrent(data: AppData, titleId: ID, snapshot: SubmissionSnapshot): SnapshotDiff {
  const current = takeSnapshot(data, titleId, false)
  const diff: SnapshotDiff = {
    switched: [],
    edited: [],
    added: [],
    removed: [],
    charDelta: current.charCount - snapshotCounts(data, snapshot).charCount,
  }
  const recordedIds = Object.keys(snapshot.activeVersions)
  for (const id of recordedIds) {
    if (!(id in current.activeVersions)) {
      diff.removed.push(id)
      continue
    }
    if (current.activeVersions[id] !== snapshot.activeVersions[id]) {
      diff.switched.push(id)
      continue
    }
    const before = snapshot.pieces?.[id]
    const now_ = current.pieces![id]
    if (before ? before.hash !== now_.hash : false) diff.edited.push(id)
  }
  for (const id of Object.keys(current.activeVersions)) if (!(id in snapshot.activeVersions)) diff.added.push(id)
  return diff
}

/** この稿を「応募時の原稿」として記録している応募先 */
export function submissionsReferencingVersion(data: AppData, versionId: ID): Submission[] {
  return Object.values(data.submissions)
    .filter((s) => s.snapshot && Object.values(s.snapshot.activeVersions).includes(versionId))
    .sort(byOrder)
}

/** 応募時に記録した原稿をテキストにする（記録に本文の控えがある場合のみ） */
export function snapshotText(data: AppData, snapshot: SubmissionSnapshot, titleName: string): string | null {
  if (!snapshot.pieces || !snapshot.order) return null
  const parts: string[] = [titleName, '']
  for (const id of snapshot.order) {
    const p = snapshot.pieces[id]
    if (!p) continue
    parts.push(p.subtitle.trim() ? `${p.label}　${p.subtitle.trim()}` : p.label, '')
    parts.push(snapshotPieceBody(data, p) ?? '採用原稿がありません。', '', '')
  }
  return parts.join('\n').trimEnd() + '\n'
}

/**
 * 応募時の原稿を記録する。採用原稿のほか、その時の応募計画の梗概・あらすじとキャッチコピーも
 * 提出したものとして控える（後から書き直しても、応募した時の内容を見返せる）
 */
export function recordSubmissionSnapshot(data: AppData, submissionId: ID): AppData {
  const s = data.submissions[submissionId]
  if (!s) throw new DomainError('応募計画が見つかりません')
  const { texts, ...manuscript } = takeSnapshot(data, s.titleId)
  const snapshot: SubmissionSnapshot = { ...manuscript, synopsis: s.synopsis ?? '', catchphrase: s.catchphrase ?? '' }
  return transact(data, (tx) => {
    for (const [id, body] of texts) if (!tx.get('snapshotTexts', id)) tx.put('snapshotTexts', { id, body })
    tx.put('submissions', { ...s, snapshot, updatedAt: now() })
    collectSnapshotTexts(tx)
  }).data
}
