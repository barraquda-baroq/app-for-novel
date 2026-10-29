// src/claude の小さな部品（種類・内容から作る id・見せる範囲・話の指し方・日付）
import { describe, expect, it } from 'vitest'
import { addChapter, setChaptersEnabled, setNumbering, movePiece } from '../domain/storyOps'
import { emptyData, type AppData, type Title } from '../domain/types'
import { addPrologue, novel, splitEpisode } from '../test/claudeFixture'
import { isProofCategory, PROOF_CATEGORIES, PROOF_CATEGORY_LABELS, proofCategoryLabel } from './categories'
import { isIsoDate, jstDate, shortDate } from './dates'
import {
  critiquePromptId,
  critiqueResultId,
  derivedId,
  derivedKindOf,
  proofBatchId,
  proofRunId,
  proofSuggestionId,
  revisionIdeaId,
  strategyNoteId,
} from './derivedId'
import { matchesId, readingOrder, resolvePiece, resolveTitle, shortId } from './refs'
import { canClaudeRead, canClaudeWrite, claudeAccessOf, claudeView, isNewerRecord } from './visibility'

describe('推敲案の種類', () => {
  it('11種類と日本語名。保存された名前（Claude の category_label）があればそれ、無ければ決まった名前（知らない種類は「その他」）', () => {
    expect(PROOF_CATEGORIES).toHaveLength(11)
    for (const c of PROOF_CATEGORIES) expect(PROOF_CATEGORY_LABELS[c]).toBeTruthy()
    expect(isProofCategory('ra_nuki')).toBe(true)
    expect(isProofCategory('typos')).toBe(false)
    expect(proofCategoryLabel('typo')).toBe('誤字脱字・変換ミス')
    expect(proofCategoryLabel('future_kind', '新しい種類')).toBe('新しい種類')
    expect(proofCategoryLabel('future_kind')).toBe('その他')
    // Claude が付けた名前（category_label）は、知っている種類でも出す。空なら決まった名前
    expect(proofCategoryLabel('other', '敬語の誤り')).toBe('敬語の誤り')
    expect(proofCategoryLabel('tic', '「のだった」の多用')).toBe('「のだった」の多用')
    expect(proofCategoryLabel('typo', '')).toBe('誤字脱字・変換ミス')
    expect(proofCategoryLabel('typo', '  ')).toBe('誤字脱字・変換ミス')
  })
})

describe('内容から作る id', () => {
  it('形は c + 種類の1文字 + - + 指紋（40字以内・[a-z0-9.-] だけ）', () => {
    const ids = [
      proofSuggestionId({
        titleId: 't',
        pieceId: 'p',
        contextBefore: '',
        excerpt: '見れる',
        occurrence: 0,
        category: 'ra_nuki',
        suggestion: '見られる',
      }),
      proofRunId('t', 'ワードサーチ', '2026-10-28'),
      proofBatchId('r', ['b', 'a'], ['y', 'x']),
      revisionIdeaId('t', '見出し', '本文'.repeat(10_000)),
      strategyNoteId('t', '2026-10-28', '見出し', '本文'),
      critiquePromptId(null, '名前', '本文'),
      critiqueResultId({ titleId: 't', runDate: '2026-10-28', promptText: 'p', resultMarkdown: 'r', artifactUrl: '' }),
    ]
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(40)
      expect(id).toMatch(/^c[a-z]-[a-z0-9.]+$/)
      expect(derivedKindOf(id)).not.toBeNull()
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(derivedKindOf('3f2a9c1b-0000-4000-8000-000000000000')).toBeNull()
  })
  it('同じ内容なら同じ id（NFC にそろえる・並びの順は問わない）、違えば違う id', () => {
    expect(derivedId('proofRun', ['ガ'])).toBe(derivedId('proofRun', ['ガ']))
    expect(proofBatchId('r', ['a', 'b'], ['x'])).toBe(proofBatchId('r', ['b', 'a'], ['x']))
    expect(revisionIdeaId('t', '見出し', '本文')).toBe(revisionIdeaId('t', ' 見出し ', '本文'))
    expect(revisionIdeaId('t', '見出し', '本文')).not.toBe(revisionIdeaId('t', '見出し', '本文。'))
    expect(critiquePromptId(null, 'a', 'b')).not.toBe(critiquePromptId('t', 'a', 'b'))
    // 区切りの文字を含めて同じにならない
    expect(derivedId('proofRun', ['ab', 'c'])).not.toBe(derivedId('proofRun', ['a', 'bc']))
  })
  it('決まった値（アプリとコネクタで同じ値になることの目印。変えると貼り付け・コネクタの重複を見分けられなくなる）', () => {
    expect(critiquePromptId(null, '全体の批評', '構成を見て')).toBe('cp-2erelebkxp5.20vku24kkd5.1g')
  })
})

describe('見せる範囲（claudeAccess）', () => {
  const t = (claudeAccess?: unknown) => ({ claudeAccess }) as Pick<Title, 'claudeAccess'>
  it('無い = 読む＋書き込む、知らない値 = 見せない', () => {
    expect(claudeAccessOf(t())).toBe('write')
    expect(claudeAccessOf(t('read'))).toBe('read')
    expect(claudeAccessOf(t('none'))).toBe('none')
    expect(claudeAccessOf(t('all'))).toBe('none')
    expect(claudeAccessOf(undefined)).toBe('none')
    expect(canClaudeRead(t('read'))).toBe(true)
    expect(canClaudeWrite(t('read'))).toBe(false)
    expect(canClaudeWrite(t())).toBe(true)
  })
  it('見せないタイトルとその配下・ゴミ箱・応募時の控え・どのタイトルにも属さないアイデアは除く。共通の批評プロンプトは見せる', () => {
    const a = novel(['見せる本文'], { name: '見せる' })
    const b = novel(['隠す本文'], { name: '隠す', data: a.data })
    let data: AppData = b.data
    data = { ...data, titles: { ...data.titles, [b.titleId]: { ...data.titles[b.titleId], claudeAccess: 'none' } } }
    data = {
      ...data,
      ideas: {
        i1: { id: 'i1', titleId: null, heading: '', body: 'x', order: 0, createdAt: 0, updatedAt: 0 },
        i2: { id: 'i2', titleId: a.titleId, heading: '', body: 'y', order: 0, createdAt: 0, updatedAt: 0 },
      },
      critiquePrompts: {
        q1: { id: 'q1', v: 1, source: 'manual', titleId: null, name: '共通', body: '', order: 0, createdAt: 0, updatedAt: 0 },
        q2: {
          id: 'q2',
          v: 1,
          source: 'manual',
          titleId: b.titleId,
          name: '隠す',
          body: '',
          order: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      snapshotTexts: { s: { id: 's', body: '控え' } },
    }
    const v = claudeView(data)
    expect(Object.keys(v.titles)).toEqual([a.titleId])
    expect(Object.values(v.versions).map((x) => x.body)).toEqual(['見せる本文'])
    expect(Object.keys(v.ideas)).toEqual(['i2'])
    expect(Object.keys(v.critiquePrompts)).toEqual(['q1'])
    expect(v.snapshotTexts).toEqual({})
    expect(v.trashEntries).toEqual({})
    // 変わらない表は同じオブジェクト
    const all = claudeView(a.data)
    expect(all.versions).toBe(a.data.versions)
  })
  it('新しい版の記録', () => {
    expect(isNewerRecord({ v: 2 })).toBe(true)
    expect(isNewerRecord({ v: 1 })).toBe(false)
  })
})

describe('話の指し方', () => {
  function sample() {
    const n = novel(['一', '二', '三本文。続き', '四'], { subtitles: ['', '雨', '', ''] })
    addPrologue(n, 'プロローグ', '序')
    const { acts } = splitEpisode(n, n.ids[2], [3])
    return { ...n, acts }
  }
  it('読む順（特殊ブロックも数える）', () => {
    const n = sample()
    const order = readingOrder(n.data, n.titleId)
    expect(order.map((x) => `${x.index}:${x.fullLabel}`)).toEqual([
      '1:プロローグ',
      '2:第1話',
      '3:第2話　雨',
      '4:第3話',
      '5:第4話',
    ])
  })
  it('短い id・id・#n・#n.m・第n話・第n話 第m幕・見出し', () => {
    const n = sample()
    const p = (ref: string) => {
      const r = resolvePiece(n.data, n.titleId, ref)
      return r.ok ? r.value.id : r.reason
    }
    expect(p(n.ids[1])).toBe(n.ids[1])
    expect(p(shortId('piece', n.ids[1]))).toBe(n.ids[1])
    expect(p('#3')).toBe(n.ids[1])
    expect(p('#4.2')).toBe(n.acts[1])
    expect(p('第3話')).toBe(n.ids[2])
    expect(p('第３話　第２幕')).toBe(n.acts[1])
    expect(p('第3話 第2幕')).toBe(n.acts[1])
    expect(p('プロローグ')).toBe(n.data.titles[n.titleId].structure[0].id)
    expect(p('第2話　雨')).toBe(n.ids[1])
    expect(p('#9')).toBe('not_found')
    expect(p('第9話')).toBe('not_found')
    const miss = resolvePiece(n.data, n.titleId, '第3話 第5幕')
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.candidates[0]).toContain('#4 第3話')
  })
  it('章ごとに話数を振っている時、「第1話」は候補を返し、「章名 第1話」で決まる', () => {
    let n = novel(['a', 'b'])
    let data = setChaptersEnabled(n.data, n.titleId, true)
    const c1 = addChapter(data, n.titleId, '一章')
    const c2 = addChapter(c1.data, n.titleId, '二章')
    data = movePiece(c2.data, n.ids[0], { chapterId: c1.result, index: 0 })
    data = movePiece(data, n.ids[1], { chapterId: c2.result, index: 0 })
    data = setNumbering(data, n.titleId, 'perChapter')
    n = { ...n, data }
    const amb = resolvePiece(data, n.titleId, '第1話')
    expect(amb.ok).toBe(false)
    if (!amb.ok) {
      expect(amb.reason).toBe('ambiguous')
      expect(amb.candidates).toHaveLength(2)
    }
    const one = resolvePiece(data, n.titleId, '二章 第1話')
    expect(one.ok && one.value.id).toBe(n.ids[1])
  })
  it('タイトルは短い id・id・名前', () => {
    const n = novel(['a'], { name: '星の庭' })
    expect(resolveTitle(n.data, shortId('title', n.titleId)).ok).toBe(true)
    expect(resolveTitle(n.data, '星の庭').ok).toBe(true)
    const miss = resolveTitle(n.data, 't:zzzz')
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.candidates[0]).toContain('『星の庭』')
    expect(resolveTitle(emptyData(), 'x').ok).toBe(false)
  })
  it('短い id は4文字以上の頭で、内容から作った id の頭（cX-）を除いて見る', () => {
    expect(shortId('proofSuggestion', 'cs-abc123def.xyz')).toBe('x:abc123de')
    expect(matchesId('proofSuggestion', 'x:abc1', 'cs-abc123def.xyz')).toBe(true)
    expect(matchesId('proofSuggestion', 'x:abc', 'cs-abc123def.xyz')).toBe(false)
    expect(matchesId('piece', 'x:abc1', 'abc1')).toBe(false)
  })
})

describe('日付（日本時間）', () => {
  it('UTC の 15:00 で日付が変わる', () => {
    expect(jstDate(Date.UTC(2026, 9, 28, 14, 59))).toBe('2026-10-28')
    expect(jstDate(Date.UTC(2026, 9, 28, 15, 0))).toBe('2026-10-29')
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-10-28')).toBe(true)
    expect(shortDate('2026-10-28', '2026-11-01')).toBe('10/28')
    expect(shortDate('2025-10-28', '2026-11-01')).toBe('2025/10/28')
  })
})

describe('コネクタが一緒に使える（React・Dexie・Firebase・Zustand を読み込まない）', () => {
  it('src/claude の部品と、その読み込む src/domain・src/sync の部品', () => {
    const files = import.meta.glob(['./*.ts', '../domain/*.ts', '../sync/*.ts', '../store/*.ts', '../db/*.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    // glob の名前（'./x.ts'・'../domain/x.ts'）を src からの名前（'claude/x.ts'・'domain/x.ts'）にして、相対の読み込みをたどる
    const fromSrc = (k: string) => (k.startsWith('./') ? `claude/${k.slice(2)}` : k.slice(3))
    const sources = new Map(Object.entries(files).map(([k, v]) => [fromSrc(k), v]))
    const resolve = (file: string, rel: string) => {
      const parts = file.split('/').slice(0, -1)
      for (const seg of rel.split('/')) {
        if (seg === '..') parts.pop()
        else if (seg !== '.') parts.push(seg)
      }
      return `${parts.join('/')}.ts`
    }
    const banned = /from '(react|react-dom|dexie|firebase[^']*|zustand[^']*|react-router-dom)'/
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = sources.get(file)
      expect(src, `読み込めない: ${file}`).toBeTypeOf('string')
      expect(src, file).not.toMatch(banned)
      for (const m of src!.matchAll(/from '(\.[^']+)'/g)) visit(resolve(file, m[1]))
    }
    for (const f of [...sources.keys()].filter((f) => f.startsWith('claude/') && !f.endsWith('.test.ts'))) visit(f)
    expect(seen.has('sync/merge.ts')).toBe(true)
    expect(seen.has('domain/structure.ts')).toBe(true)
    expect([...seen].every((f) => !f.startsWith('store/') && !f.startsWith('db/') && !f.startsWith('features/'))).toBe(true)
  })
})
