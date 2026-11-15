// タイトルのコピー（第二稿）。要所の改稿ではなく、全体の構成を大きく変えて書き直す時に、元のタイトルに触れずに、
// 同じ内容の新しいタイトルから始められるようにする。元のタイトルとその配下は1つも書き換えない
// （後ろのタイトルの並び順だけを、写しが元のすぐ後ろに入るようにずらす）。
// - 写すもの: タイトルの項目（あらすじ・章管理のオン/オフ・話数の振り方・本編の構成・全体戦略・相対比較する作品・
//   縦書きのページの字数×行数・Claude に見せるか（無ければ無いまま））、本編の章・第n話・特殊ブロック・幕（各レコードの項目は
//   そのまま）、各話・幕の採用稿（採用原稿）だけ（稿の名前・本文・推敲メモもそのまま。「第3稿」なら、次に作る稿は第4稿）、
//   設定項目とそのエントリ、メモ。採用稿のない話・幕は稿なしで写す
// - 写さないもの: 採用していない稿、応募計画と応募時の原稿の控え、2.3 の Claude 連携の記録（推敲案・その実行の記録・改稿案・
//   戦略メモ・批評プロンプト・批評の結果。TITLE_CLAUDE_TABLES）、アイデアとアイデアのフォルダ、ゴミ箱の中のもの
// - id はすべて新しくし（設定エントリの項目の id も）、写したもの同士の参照（本編の構成・章の話の並び・幕の属する話と幕の並び・
//   採用中の稿・稿の複製元・設定エントリの設定項目）を付け替える。写さなかったものを指す参照は残さない（稿の複製元は null）。
//   相対比較する作品は、どのタイトルにも属さない棚の作品なので同じ作品を指す（今ある作品だけ。修復と同じ）
// - 作った時刻・更新した時刻は今。幕だけは、分けた時と同じく作った時刻を読む順に1ずつずらす（acts.ts の newAct。同期の途中で
//   幕が先に届いても、修復が読む順に並べられるように）
// - 写したデータは修復（repair.ts）を通しても変わらない形で作る（本編の構成に載っていない話・章、幕の並びに載っていない幕は写さない）
//
// 幕（2.2）に分けた話:
// - 各幕は幕の採用稿だけを写す。話（幕の親）には、話自身の採用稿（activeVersionId。分ける前に採用していた、幕に分けた元の稿）
//   だけを写す。上位の層（通し読み・文字数・本編タブ・ホームの集計）に出る本文は各幕の採用稿をつないだものなので、元と同じに読める
// - 話自身の採用稿を写すのは、幕に分けた話の画面の「幕に分ける前の稿」に出し、セパレート解除で作る稿の番号
//   （第n稿（幕をつないだ稿）。n は写した稿の続き。写さないと第1稿から数え直す）・複製元・指紋（分けた元の稿の本文）を、
//   元のタイトルと同じ決まりで付けられるように
// - 次の幕とつなぐ・セパレート解除は、元のタイトルと同じ条件で使える（どちらも各幕の採用稿だけを使う）。採用稿のない幕は写しでも
//   採用稿がないので、その幕を含むつなぐ・解除は元と同じ理由で断る。採用していない稿は写さないので、つないだ・解除した時に
//   ゴミ箱へ入る稿も無い
// - 稿の sourceHash（幕の操作で作った稿の、元の稿の本文の指紋。同期で、元の稿が別の端末で書き換えられていたのに気付くため）は、
//   複製元の稿も写した時だけ残す（本文が同じなので、指紋はそのまま写しの複製元のもの）。複製元を写さなかった稿は、
//   複製元を null にして指紋も外す（指す稿の無い指紋は使い道が無い）
import { categoriesOf, entriesOf, memosOf } from './entityOps'
import { actsOf, isSplit } from './structure'
import { transact, type Tx } from './tx'
import { DomainError, type AppData, type Chapter, type ID, type NodeRef, type Piece, type Title, type Version } from './types'
import { byOrder, newId, now } from './util'
import { draftNumeral } from './versionNumber'

/** 名前の終わりの「（第n稿）」（n は半角・全角の数字か漢数字。括弧は全角・半角のどちらでも）。1 = 開き括弧、2 = n、3 = 閉じ括弧 */
const DRAFT_TAIL = /([（(])第([0-9]+|[０-９]+|[〇零一二三四五六七八九十百千]+)稿([）)])$/

const KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 漢数字（十・百・千を使う書き方。1〜9999。それより大きい数は半角の数字） */
function kanjiNumeral(n: number): string {
  if (n < 1 || n > 9999) return String(n)
  let out = ''
  for (const [unit, mark] of [
    [1000, '千'],
    [100, '百'],
    [10, '十'],
  ] as const) {
    const d = Math.floor(n / unit) % 10
    if (d > 0) out += `${d === 1 ? '' : KANJI_DIGITS[d]}${mark}`
  }
  const ones = n % 10
  return ones > 0 ? out + KANJI_DIGITS[ones] : out
}

/** 全角の数字 */
function fullWidthDigits(n: number): string {
  return Array.from(String(n), (c) => String.fromCharCode(c.charCodeAt(0) - 0x30 + 0xff10)).join('')
}

/**
 * コピーで作るタイトルの名前の候補。名前が「（第n稿）」で終わっていれば次の番号にし（「（第二稿）」→「（第三稿）」、
 * 「（第3稿）」→「（第4稿）」。数字の書き方（漢数字・半角・全角）と括弧はそのまま）、そうでなければ「（第二稿）」を付ける
 */
export function copyTitleName(name: string): string {
  const base = name.trim() || '無題のタイトル'
  const m = DRAFT_TAIL.exec(base)
  const n = m ? draftNumeral(m[2]) : null
  if (!m || n === null || !Number.isSafeInteger(n + 1)) return `${base}（第二稿）`
  const raw = m[2]
  const next = /^[0-9]+$/.test(raw) ? String(n + 1) : /^[０-９]+$/.test(raw) ? fullWidthDigits(n + 1) : kanjiNumeral(n + 1)
  return `${base.slice(0, m.index)}${m[1]}第${next}稿${m[3]}`
}

/**
 * コピーのダイアログに出す名前の候補。copyTitleName の名前が今あるタイトルの名前（taken）と同じなら、空くまで番号を進める
 * （同じタイトルを2回コピーすると、2回目は「（第二稿）」ではなく「（第三稿）」。同じ名前のカードが並んで見分けがつかなくならないように）
 */
export function suggestCopyTitleName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.trim()))
  let next = copyTitleName(name)
  // 候補は1つ進めるごとに違う名前になるので、使われている名前の数だけ進めれば必ず空いた名前に当たる
  for (let i = 0; i < used.size && used.has(next); i++) next = copyTitleName(next)
  return next
}

/** 話・幕の採用稿（その話・幕の稿として採用しているもの。参照切れ・別の話の稿なら null） */
function adoptedVersion(tx: Tx, piece: Piece): Version | null {
  const v = tx.get('versions', piece.activeVersionId)
  return v && v.pieceId === piece.id ? v : null
}

/**
 * タイトルを丸ごとコピーする（第二稿）。name は新しいタイトルの名前（前後の空白は除く。空なら DomainError）。
 * 写す・写さないものと幕の扱いはこのファイルの先頭。写しはタイトルの一覧で元のすぐ後ろに入る。戻り値は新しいタイトルの id
 */
export function copyTitle(data: AppData, titleId: ID, name: string): { data: AppData; result: ID } {
  const newName = name.trim()
  if (!newName) throw new DomainError('新しいタイトルの名前を入れてください')
  return transact(data, (tx) => {
    const src = tx.get('titles', titleId)
    if (!src) throw new DomainError('タイトルが見つかりません')
    const ts = now()
    const newTitleId = newId()
    // 元の id → 写しの id（表ごと）
    const chapterIds = new Map<ID, ID>()
    const pieceIds = new Map<ID, ID>()
    const versionIds = new Map<ID, ID>()

    // 1. 写す章・話（本編の構成に載っているもの。読む順。修復と同じく、ほかのタイトルの話・幕・重なった参照は飛ばす）と幕
    const placed = new Set<ID>()
    const takePiece = (id: unknown): Piece | null => {
      if (typeof id !== 'string' || placed.has(id)) return null
      const p = tx.get('pieces', id)
      if (!p || p.titleId !== titleId || p.kind === 'act') return null
      placed.add(id)
      pieceIds.set(id, newId())
      return p
    }
    const chapters: { chapter: Chapter; pieces: Piece[] }[] = []
    const pieces: Piece[] = []
    const structure: NodeRef[] = []
    for (const node of src.structure) {
      if (node.type === 'chapter') {
        const ch = tx.get('chapters', node.id)
        if (!ch || ch.titleId !== titleId || chapterIds.has(ch.id)) continue
        const inside = ch.pieceIds.map(takePiece).filter((p): p is Piece => p !== null)
        const id = newId()
        chapterIds.set(ch.id, id)
        chapters.push({ chapter: ch, pieces: inside })
        pieces.push(...inside)
        structure.push({ type: 'chapter', id })
      } else if (node.type === 'piece') {
        const p = takePiece(node.id)
        if (!p) continue
        pieces.push(p)
        structure.push({ type: 'piece', id: pieceIds.get(p.id)! })
      }
    }
    // 幕に分けた話の幕（話の幕の並びに載っていて、その話を指している幕。読む順）
    const actsByParent = new Map<ID, Piece[]>()
    for (const p of pieces) {
      if (!isSplit(p)) continue
      const acts = actsOf(tx.data, p).filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i)
      for (const a of acts) pieceIds.set(a.id, newId())
      actsByParent.set(p.id, acts)
    }
    const allPieces = [...pieces, ...[...actsByParent.values()].flat()]

    // 2. 写す稿（各話・幕の採用稿だけ）
    const adopted = new Map<ID, Version>()
    for (const p of allPieces) {
      const v = adoptedVersion(tx, p)
      if (!v) continue
      adopted.set(p.id, v)
      versionIds.set(v.id, newId())
    }

    // 3. 書き込む
    const title: Title = { ...src, id: newTitleId, name: newName, structure, order: src.order + 1, createdAt: ts, updatedAt: ts }
    if (src.benchWorkIds !== undefined) {
      const raw: unknown[] = Array.isArray(src.benchWorkIds) ? src.benchWorkIds : []
      title.benchWorkIds = raw.filter(
        (id, i): id is ID => typeof id === 'string' && Boolean(tx.get('benchWorks', id)) && raw.indexOf(id) === i,
      )
    }
    // ページの字数×行数は値ごと写す（壊れた値はそのまま。読む所で既定の 40×32 として扱う。pageSetup.ts）
    if (src.pageSetup && typeof src.pageSetup === 'object') title.pageSetup = { ...src.pageSetup }
    placeAfter(tx, src, title.order, ts)
    tx.put('titles', title)

    for (const { chapter, pieces: inside } of chapters) {
      tx.put('chapters', {
        ...chapter,
        id: chapterIds.get(chapter.id)!,
        titleId: newTitleId,
        pieceIds: inside.map((p) => pieceIds.get(p.id)!),
        createdAt: ts,
        updatedAt: ts,
      })
    }

    const copyPiece = (p: Piece, createdAt: number, parentId?: ID): void => {
      const v = adopted.get(p.id)
      const vid = v ? versionIds.get(v.id)! : null
      const next: Piece = {
        ...p,
        id: pieceIds.get(p.id)!,
        titleId: newTitleId,
        activeVersionId: vid,
        versionIds: vid ? [vid] : [],
        createdAt,
        updatedAt: ts,
      }
      // 幕の属する話は写しの話へ。幕でない話の属する話（使わない値）は、元のタイトルを指さないように外す
      if (parentId !== undefined) next.parentId = parentId
      else if (typeof p.parentId === 'string') delete next.parentId
      // 幕の並びは写した幕へ（分けていない話・解除した話の [] はそのまま [] に）
      if (Array.isArray(p.actIds)) next.actIds = (actsByParent.get(p.id) ?? []).map((a) => pieceIds.get(a.id)!)
      else delete next.actIds
      tx.put('pieces', next)
    }
    for (const p of pieces) {
      copyPiece(p, ts)
      ;(actsByParent.get(p.id) ?? []).forEach((a, i) => copyPiece(a, ts + i, pieceIds.get(p.id)!))
    }

    for (const p of allPieces) {
      const v = adopted.get(p.id)
      if (!v) continue
      const source = v.sourceVersionId ? (versionIds.get(v.sourceVersionId) ?? null) : null
      const next: Version = {
        ...v,
        id: versionIds.get(v.id)!,
        pieceId: pieceIds.get(p.id)!,
        titleId: newTitleId,
        sourceVersionId: source,
        createdAt: ts,
        updatedAt: ts,
      }
      if (source === null) delete next.sourceHash
      tx.put('versions', next)
    }

    for (const m of memosOf(tx.data, titleId)) {
      tx.put('memos', { ...m, id: newId(), titleId: newTitleId, createdAt: ts, updatedAt: ts })
    }
    for (const c of categoriesOf(tx.data, titleId)) {
      const categoryId = newId()
      tx.put('settingCategories', {
        ...c,
        id: categoryId,
        titleId: newTitleId,
        fieldTemplate: [...c.fieldTemplate],
        createdAt: ts,
        updatedAt: ts,
      })
      for (const e of entriesOf(tx.data, c.id)) {
        if (e.titleId !== titleId) continue
        tx.put('settingEntries', {
          ...e,
          id: newId(),
          titleId: newTitleId,
          categoryId,
          fields: e.fields.map((f) => ({ ...f, id: newId() })),
          createdAt: ts,
          updatedAt: ts,
        })
      }
    }
    return newTitleId
  })
}

/**
 * 写し（order）が元のタイトル（src）のすぐ後ろに並ぶように、元より後ろのタイトルの order をずらす。書き換えるのは、
 * 写し（とその前にずらしたタイトル）より後ろに並ばなくなるものだけ（1つずつ大きくして、後ろのタイトル同士の順も保つ）。
 * order の空いた所に入る時は何も書き換えない。元のタイトルと、元より前のタイトルは書き換えない
 */
function placeAfter(tx: Tx, src: Title, order: number, ts: number): void {
  const sorted = tx.all('titles').sort(byOrder)
  let prev = order
  for (const t of sorted.slice(sorted.findIndex((x) => x.id === src.id) + 1)) {
    // これより後ろは、このタイトルの order 以上なので、もう写しより後ろに並ぶ
    if (t.order > prev) break
    prev += 1
    tx.put('titles', { ...t, order: prev, updatedAt: ts })
  }
}
