import { describe, expect, it } from 'vitest'
import { addChapter, movePiece, setChaptersEnabled, updateChapter, updateVersion } from '../domain/storyOps'
import { addPrologue, novel, splitEpisode } from '../test/claudeFixture'
import { shortId } from './refs'
import { cutPoint, decodeCursor, encodeCursor, outlineView, readTextPages, readTextView, searchTextView } from './view'

function sample() {
  const n = novel(
    ['窓から見れる景色は美しい。\n二段落目。', '猫が来た。\n猫が来た。', '第一幕の本文。\n第二幕の｜東京《とうきょう》駅。'],
    {
      subtitles: ['出発', '', '雨'],
    },
  )
  const { acts } = splitEpisode(n, n.ids[2], [8])
  return { ...n, acts }
}

/** 章のあるタイトル: 第一章に第1話、第二章に第2話（長い）・第3話 */
function chaptered() {
  const long = Array.from({ length: 4 }, (_, k) => `二章の本文${k}。${'い'.repeat(900)}`).join('\n')
  const n = novel(['一章の本文。', long, '二章の二話目。'])
  n.data = setChaptersEnabled(n.data, n.titleId, true)
  const first = n.data.titles[n.titleId].structure[0].id
  n.data = updateChapter(n.data, first, { name: '第一章' })
  const second = addChapter(n.data, n.titleId, '第二章')
  n.data = movePiece(second.data, n.ids[1], { chapterId: second.result, index: 0 })
  n.data = movePiece(n.data, n.ids[2], { chapterId: second.result, index: 1 })
  return n
}

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r as Extract<T, { ok: true }>
}

describe('cursor', () => {
  it('日本語を含む値も戻せる。壊れたものは null', () => {
    const c = encodeCursor({ k: 'read', sel: { pieces: ['第3話 第2幕'] }, u: 1 })
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(c)).toEqual({ k: 'read', sel: { pieces: ['第3話 第2幕'] }, u: 1 })
    expect(decodeCursor('@@@')).toBeNull()
  })
})

describe('目次（outlineView）', () => {
  it('タイトルの見出し・話ごとの文字数・進捗・採用稿・幕の行', () => {
    const n = sample()
    const r = ok(outlineView(n.data, n.titleId))
    const lines = r.text.split('\n')
    expect(lines[0]).toBe(`『星の庭』採用原稿 43字（原稿用紙3枚）第n話3・特殊0 [${shortId('title', n.titleId)}]`)
    expect(lines[1]).toBe(`#1 第1話　出発 [${shortId('piece', n.ids[0])}] 18字 0–42% 第1稿/全1稿`)
    expect(lines[2]).toMatch(/^#2 第2話 \[p:[0-9a-z]{8}\] 10字 42–65% 第1稿\/全1稿$/)
    expect(lines[3]).toMatch(/^#3 第3話　雨 \[p:[0-9a-z]{8}\] 15字 65–100% 幕×2$/)
    expect(lines[4]).toMatch(/^ {2}#3\.1 第1幕 \[p:[0-9a-z]{8}\] 7字 65–81% 第1稿\/全1稿$/)
    expect(lines[5]).toMatch(/^ {2}#3\.2 第2幕 /)
    expect(r.nextCursor).toBeNull()
  })
  it('行が多ければ cursor で続きを出す', () => {
    const n = novel(Array.from({ length: 30 }, (_, i) => `本文${i}`))
    const first = ok(outlineView(n.data, n.titleId, { maxRows: 10 }))
    expect(first.text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(10)
    expect(first.text).toContain('続き: cursor=')
    const second = ok(outlineView(n.data, n.titleId, { maxRows: 10, cursor: first.nextCursor! }))
    expect(second.text.split('\n')[0]).toMatch(/^#11 第11話/)
    expect(outlineView(n.data, n.titleId, { cursor: 'xxx' }).ok).toBe(false)
  })
  it('続きは cursor だけで、最初に選んだ範囲の続きから出す（範囲・章を渡し直さなくても）', () => {
    const n = novel(Array.from({ length: 30 }, (_, i) => `本文${i}`))
    const first = ok(outlineView(n.data, n.titleId, { from: '#2', maxRows: 10 }))
    const m = /→ #(\d+) /.exec(first.text)
    expect(m?.[1]).toBe('12')
    const second = ok(outlineView(n.data, n.titleId, { maxRows: 10, cursor: first.nextCursor! }))
    expect(second.text.split('\n')[0]).toMatch(/^#12 第12話/)
    // 章で絞った目次も、続きは同じ章の中
    const c = chaptered()
    const only = ok(outlineView(c.data, c.titleId, { chapter: '第二章', maxRows: 10 }))
    expect(only.text).not.toContain('#1 第1話')
    expect(only.text).toContain('#2 第2話')
  })
})

describe('採用原稿（readTextView）', () => {
  it('章を選ぶと、その章の話だけを読む（続きのページも同じ章の中）', () => {
    const n = chaptered()
    const r = ok(readTextView(n.data, n.titleId, { chapter: '第二章' }))
    expect(r.text).toContain('二章の本文0')
    expect(r.text).not.toContain('一章の本文')
    let cursor: string | null = null
    let all = ''
    for (let i = 0; i < 20; i++) {
      const page: { text: string; nextCursor: string | null } = ok(
        readTextView(n.data, n.titleId, cursor ? { cursor } : { chapter: '第二章', charBudget: 2_000 }),
      )
      expect(page.text).not.toContain('一章の本文')
      all += page.text
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(cursor).toBeNull()
    expect(all).toContain('二章の本文3')
    expect(all).toContain('二章の二話目。')
    const unknown = readTextView(n.data, n.titleId, { chapter: '第九章' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.candidates?.join(' ')).toContain('第二章')
  })
  it('話の見出しと本文。幕に分けた話は幕ごと', () => {
    const n = sample()
    const r = ok(readTextView(n.data, n.titleId))
    const p = (id: string) => shortId('piece', id)
    expect(r.text).toContain(`=== #1 第1話　出発（第1稿・18字・0–42%）[${p(n.ids[0])} v:`)
    expect(r.text).toContain('窓から見れる景色は美しい。\n二段落目。')
    expect(r.text).toContain(
      `=== #3 第3話　雨（幕に分けた話・2幕・15字・65–100%）[${p(n.ids[2])}] ===\n--- 第1幕（第1稿・7字・65–81%）[${p(n.acts[0])} v:`,
    )
    expect(r.text).toContain('第二幕の｜東京《とうきょう》駅。')
    expect(r.nextCursor).toBeNull()
    const strip = ok(readTextView(n.data, n.titleId, { ruby: 'strip', from: '#3' }))
    expect(strip.text).toContain('第二幕の東京駅。')
    expect(strip.text).toContain('ルビを除く')
    expect(strip.text).not.toContain('#1 第1話')
  })
  it('予算を超える話は段落の切れ目で分け、cursor で続きを読む。本文が変わっていれば知らせて段落の始めから', () => {
    const para = (k: number) => `${'あ'.repeat(900)}${k}`
    const body = Array.from({ length: 6 }, (_, k) => para(k)).join('\n')
    const n = novel([body, '短い話'])
    const first = ok(readTextView(n.data, n.titleId, { charBudget: 2_000 }))
    expect(first.nextCursor).not.toBeNull()
    expect(first.text).toMatch(/続き: cursor=".+" → #1 第1話の途中から（残り2話・約[\d,]+字）$/)
    const body1 = first.text.split('\n').slice(1, -1).join('\n')
    expect(body1.endsWith('\n') || /\d$/.test(body1)).toBe(true)
    // 次のページは続きの見出しから
    const second = ok(readTextView(n.data, n.titleId, { cursor: first.nextCursor! }))
    expect(second.text.split('\n')[0]).toMatch(/^=== #1 第1話（続き・第1稿）/)
    // 全部読むと元の本文がそろう
    let cursor: string | null = null
    let text = ''
    for (let i = 0; i < 20; i++) {
      const r: { text: string; nextCursor: string | null } = ok(
        readTextView(n.data, n.titleId, { charBudget: 2_000, ...(cursor ? { cursor } : {}) }),
      )
      text += `${r.text.replace(/\n続き: cursor=.*$/, '')}\n`
      cursor = r.nextCursor
      if (!cursor) break
    }
    expect(text.replace(/^===.*===\n/gm, '').replace(/\n/g, '')).toBe(`${body.replace(/\n/g, '')}短い話`)
    // 本文が変わった
    const changed = updateVersion(n.data, n.data.pieces[n.ids[0]].versionIds[0], { body: `前置き\n${body}` })
    const again = ok(readTextView(changed, n.titleId, { cursor: first.nextCursor! }))
    expect(again.text.split('\n')[0]).toContain('本文が変わっていた')
  })
  it('話・幕・稿の指定', () => {
    const n = sample()
    const acts = ok(readTextView(n.data, n.titleId, { pieces: ['#3.2', '第1話'] }))
    expect(acts.text.split('\n')[0]).toMatch(/^=== #3\.2 第3話　雨　第2幕（第1稿・8字）/)
    expect(acts.text).toContain('=== #1 第1話　出発')
    const vid = n.data.pieces[n.ids[1]].versionIds[0]
    const one = ok(readTextView(n.data, n.titleId, { versionId: shortId('version', vid) }))
    expect(one.text.split('\n')[0]).toMatch(/^=== 第2話 の 第1稿（採用中・10字・更新 \d{4}-\d{2}-\d{2}）/)
    expect(readTextView(n.data, n.titleId, { pieces: ['#9'] }).ok).toBe(false)
  })
  it('ページに分ける（手動連携）。どのページも予算以内', () => {
    const bodies = Array.from({ length: 12 }, (_, i) => `${'本文'.repeat(400)}${i}\n${'続き'.repeat(300)}`)
    const n = novel(bodies)
    addPrologue(n, 'プロローグ', '序章')
    const r = readTextPages(n.data, n.titleId, {}, 5_000, 3_000)
    if (!r.ok) throw new Error(r.error)
    expect(r.pages.length).toBeGreaterThan(3)
    expect(r.pages[0].length).toBeLessThanOrEqual(3_000)
    for (const p of r.pages) expect(p.length).toBeLessThanOrEqual(5_000)
    expect(r.pages[0]).toContain('=== #1 プロローグ')
  })
  it('段落の無い長い本文は、ルビの記法・サロゲートペアの途中で切らない', () => {
    const body = '｜東京《とうきょう》𠮷'
    for (let pos = 1; pos < body.length; pos++) expect([pos, cutPoint(body, 0, pos)]).toEqual([pos, 10])
    expect(cutPoint('前置き｜東京《とうきょう》', 3, 6)).toBe(13)
    expect(cutPoint('前置き｜東京《とうきょう》', 0, 6)).toBe(3)
    expect(cutPoint('一行目\n二行目', 0, 6)).toBe(4)
  })
})

describe('検索（searchTextView）', () => {
  it('ルビを除いた本文で探し、位置は元の本文で返す', () => {
    const n = sample()
    const r = ok(searchTextView(n.data, n.titleId, { query: '東京駅', contextChars: 4 }))
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('「東京駅」 の検索（採用原稿・#1〜#3・ルビを除いた本文）: 1〜1件目')
    expect(lines[1]).toMatch(/^#3\.2 第3話 第2幕 ¶1 o:4 \[p:[0-9a-z]{8} v:[0-9a-z]{8}\] 第二幕の【東京駅】。$/)
  })
  it('件数だけ・正規表現・多ければ cursor', () => {
    const n = sample()
    const count = ok(searchTextView(n.data, n.titleId, { query: '来た', countOnly: true }))
    expect(count.text).toBe('「来た」 2件（採用原稿・#1〜#3・ルビを除いた本文）: #2 ×2')
    const re = ok(searchTextView(n.data, n.titleId, { query: '[見来]', mode: 'regex', maxHits: 2 }))
    expect(re.text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(2)
    expect(re.nextCursor).not.toBeNull()
    const rest = ok(searchTextView(n.data, n.titleId, { query: '[見来]', mode: 'regex', maxHits: 2, cursor: re.nextCursor! }))
    expect(rest.text.split('\n')[0]).toContain('3〜3件目')
    expect(searchTextView(n.data, n.titleId, { query: '来た', cursor: re.nextCursor! }).ok).toBe(false)
    expect(searchTextView(n.data, n.titleId, { query: '(', mode: 'regex' }).ok).toBe(false)
  })
  it('すべての稿', () => {
    const n = sample()
    const r = ok(searchTextView(n.data, n.titleId, { query: '見れる', scope: 'all_versions' }))
    expect(r.text).toContain('#1 第1話 第1稿（採用中）')
  })
  it('正規表現の ^ と $ は段落ごと（字下げ漏れ・台詞で始まる段落・。で終わる段落）', () => {
    const n = novel(['　地の文。\n「台詞」\n字下げ漏れ。', '「また台詞」\n　もう一つ。'])
    const count = (query: string) => ok(searchTextView(n.data, n.titleId, { query, mode: 'regex', countOnly: true })).text
    expect(count('^「')).toMatch(/^「\^「」（正規表現） 2件（.*）: #1 ×1、#2 ×1$/)
    expect(count('。$')).toMatch(/ 3件（.*）: #1 ×2、#2 ×1$/)
    expect(count('^[^　「]')).toMatch(/ 1件（.*）: #1 ×1$/)
    // そのままの言葉の ^ $ は文字のまま
    expect(ok(searchTextView(n.data, n.titleId, { query: '^「', countOnly: true })).text).toMatch(/ 0件/)
  })
  it('調べる量の上限で途中まで: 見出しは調べた範囲と「途中」を言い、続きで最後の話の一致まで届く', () => {
    const bodies = Array.from({ length: 6 }, (_, i) => `第${i + 1}話の本文です。雨の音がする。`)
    bodies[5] += '珍しい言葉。'
    const n = novel(bodies)
    const first = ok(searchTextView(n.data, n.titleId, { query: '珍しい言葉', workBudget: 20 }))
    const head = first.text.split('\n')[0]
    expect(head).toContain('まで調べました')
    expect(head).toContain('ここまで見つかりません')
    expect(head).not.toMatch(/: 見つかりません$/)
    expect(head).toContain('#1 まで調べました')
    expect(first.nextCursor).not.toBeNull()
    // 件数だけでも、途中なら「ここまで」
    const count = ok(searchTextView(n.data, n.titleId, { query: '雨の音', countOnly: true, workBudget: 20 }))
    expect(count.text.split('\n')[0]).toMatch(
      /^「雨の音」 ここまで 1件（採用原稿・#1〜#6・ルビを除いた本文）: #1 ×1。#1 まで調べました。/,
    )
    // cursor をたどると最後の話で見つかり、最後のページは途中と言わない
    let cursor: string | null = first.nextCursor
    let found = ''
    let last = ''
    for (let i = 0; i < 10 && cursor; i++) {
      const page = ok(searchTextView(n.data, n.titleId, { query: '珍しい言葉', workBudget: 20, cursor }))
      last = page.text.split('\n')[0]
      found += page.text
      cursor = page.nextCursor
    }
    expect(cursor).toBeNull()
    expect(found).toContain('#6 第6話 ¶1')
    expect(last).not.toContain('まで調べました')
    let n2 = 0
    let c2: string | null = null
    let countLast = ''
    do {
      const page: { text: string; nextCursor: string | null } = ok(
        searchTextView(n.data, n.titleId, { query: '雨の音', countOnly: true, workBudget: 20, ...(c2 ? { cursor: c2 } : {}) }),
      )
      countLast = page.text.split('\n')[0]
      c2 = page.nextCursor
      n2++
    } while (c2 && n2 < 10)
    expect(countLast).toMatch(/^「雨の音」 6件（採用原稿・#1〜#6・ルビを除いた本文）/)
  })
})
