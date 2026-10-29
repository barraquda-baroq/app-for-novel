// コネクタの結合テスト（Firebase エミュレーターの Auth・Firestore、本番のアクセスルール）。
// 実行: npm run test:connector:emu（リポジトリの直下で）
// アプリの端末（同期のエンジン・端末内の保存）と、コネクタの Vault の中身（node:sqlite）を一緒に動かす。
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { appModelRef } from '../../../src/sync/appModel'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as C from '../../../src/domain/claudeOps'
import * as E from '../../../src/domain/entityOps'
import * as S from '../../../src/domain/storyOps'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { stableStringify } from '../../../src/sync/merge'
import {
  account,
  cleanup,
  clearFirestore,
  emuRules,
  makeConnector,
  makeDevice,
  pair,
  prodRules,
  settle,
  tool,
  useRules,
  waitFor,
  type Device,
} from './harness'

beforeAll(async () => {
  await useRules(prodRules)
})

afterAll(async () => {
  await useRules(emuRules)
})

beforeEach(async () => {
  // config/owner はデータベースに1つ（本番のルールでは作り直せない）ので、テストごとに空にする
  await clearFirestore()
})

afterEach(async () => {
  await cleanup()
})

/** 持ち主の端末で、本文の入った話を並べたタイトルを作る */
async function writeNovel(d: Device, bodies: string[], name = '星の庭') {
  let titleId = ''
  const pieces: string[] = []
  await d.edit((data) => {
    const t = E.createTitle(data, name)
    titleId = t.result
    let next = t.data
    for (const body of bodies) {
      const ep = S.addEpisode(next, titleId)
      pieces.push(ep.result)
      next = S.updateVersion(ep.data, ep.data.pieces[ep.result].versionIds[0], { body })
    }
    return next
  })
  return { titleId, pieces }
}

async function ownerWithNovel(bodies: string[], name?: string) {
  const who = account()
  const owner = await makeDevice('owner', who)
  await owner.online()
  const novel = await writeNovel(owner, bodies, name)
  await settle(owner)
  return { owner, who, ...novel }
}

describe('コネクタ（エミュレーター・本番のアクセスルール）', () => {
  it('作った100件の推敲案が、両方の端末に「読み取れませんでした」なしで同じ内容で届く', async () => {
    const bodies = Array.from({ length: 50 }, (_, i) => `第${i + 1}話の固有の文${i}番。\n二つ目の固有の段落${i}番。`)
    const { owner, who, titleId } = await ownerWithNovel(bodies)
    const other = await makeDevice('other', who)
    await other.online()
    await settle(owner, other)
    const { core } = makeConnector()
    await pair(core, owner)
    const items = bodies.flatMap((_, i) => [
      { piece: `#${i + 1}`, excerpt: `固有の文${i}番`, category: 'typo', reason: '誤字の候補' },
      { piece: `#${i + 1}`, excerpt: `固有の段落${i}番`, category: 'repetition', reason: '近接重複', important: i === 0 },
    ])
    const r = await tool(core, 'novel_add_proofreading', { title_id: titleId, run_label: '一括', items })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('追加 100件')
    const view = core.views().raw
    for (const d of [owner, other]) {
      await waitFor(
        async () => {
          const x = await d.load()
          return Object.keys(x.proofSuggestions).length === 100 && Object.keys(x.proofBatches).length === 1
        },
        `${d.name} に100件と実行の記録が届く`,
        30_000,
      )
      const local = await d.load()
      // 端末に届いた内容 = コネクタが書いた JSON
      for (const x of Object.values(local.proofSuggestions)) expect(stableStringify(x)).toBe(stableStringify(view.proofSuggestions[x.id]))
      expect(Object.keys(local.proofBatches)).toHaveLength(1)
      expect(d.notes).toEqual([])
    }
    expect(owner.warnings.filter((w) => w.includes('読み取れませんでした'))).toEqual([])
  })

  it('送信待ちのある端末（オフライン）にも、コネクタの記録が競合なしで届き、端末の編集はそのまま送られる', async () => {
    const { owner, titleId, pieces } = await ownerWithNovel(['本文の一話目。'])
    const { core } = makeConnector()
    await pair(core, owner)
    owner.offline()
    const versionId = (await owner.load()).pieces[pieces[0]].versionIds[0]
    await owner.edit((d) => E.updateTitle(d, titleId, { strategyNote: 'オフラインで書いた全体戦略' }))
    await owner.edit((d) => S.updateVersion(d, versionId, { body: 'オフラインで直した本文。' }))
    for (const [name, args] of [
      ['novel_add_strategy_note', { title_id: titleId, heading: '公募', body: '## 狙う賞\n- 新人賞', contests: [{ name: '新人賞', deadline: '2027-01-31' }] }],
      ['novel_add_critique_result', { title_id: titleId, result_markdown: '# 批評\n良い' }],
      ['novel_add_revision_ideas', { title_id: titleId, items: [{ heading: '冒頭', body: '景色から入る' }] }],
    ] as const) {
      const r = await tool(core, name, args)
      expect([name, r.isError]).toEqual([name, undefined])
    }
    await owner.online()
    await settle(owner)
    const d = await owner.load()
    expect(Object.keys(d.strategyNotes)).toHaveLength(1)
    expect(Object.keys(d.critiqueResults)).toHaveLength(1)
    expect(Object.keys(d.revisionIdeas)).toHaveLength(1)
    expect(d.titles[titleId].strategyNote).toBe('オフラインで書いた全体戦略')
    expect(d.versions[versionId].body).toBe('オフラインで直した本文。')
    expect(owner.notes).toEqual([])
    // 端末の編集はそのままクラウドへ（コネクタも読める）
    await waitFor(async () => {
      const t = await tool(core, 'novel_read_text', { title_id: titleId })
      return t.text.includes('オフラインで直した本文。')
    }, 'コネクタが端末の編集を読める')
  })

  it('端末で削除した推敲案は、同じ内容をもう一度送っても「以前に削除」で作らない', async () => {
    const { owner, titleId } = await ownerWithNovel(['窓から見れる景色。'])
    const { core } = makeConnector()
    await pair(core, owner)
    const input = { title_id: titleId, items: [{ piece: '#1', excerpt: '見れる景色', category: 'ra_nuki', suggestion: '見られる景色', reason: 'ら抜き' }] }
    expect((await tool(core, 'novel_add_proofreading', input)).text).toContain('追加 1件')
    const id = await waitFor(async () => Object.keys((await owner.load()).proofSuggestions)[0], '端末に届く')
    await owner.edit((d) => C.deleteProofSuggestion(d, id))
    await settle(owner)
    const again = await tool(core, 'novel_add_proofreading', input)
    expect(again.text).toContain('以前に削除 1件')
    expect(Object.keys((await owner.load()).proofSuggestions)).toHaveLength(0)
  })

  it('同時に同じ呼び出しをしても1つ。写しの古い別の Vault から送っても、クラウドの「無い時だけ作る」で重複にする', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const first = makeConnector()
    await pair(first.core, owner)
    const input = { title_id: titleId, items: [{ heading: '構成', body: '第2幕を前に' }] }
    const [a, b] = await Promise.all([tool(first.core, 'novel_add_revision_ideas', input), tool(first.core, 'novel_add_revision_ideas', input)])
    expect([a.text, b.text].join('\n')).toContain('重複 1件')
    // 同じ身元・連携・受け取った位置で、写しにその改稿案だけが無い Vault（作ったことを知らない）
    const second = makeConnector()
    for (const k of ['identity', 'pairing', 'warm', 'cursor']) {
      const v = first.sql.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)[0].v
      second.sql.run('INSERT INTO meta (k, v) VALUES (?, ?)', k, v)
    }
    const cols = 'name, tbl, id, deleted, chunks, hash, upd_us, updated, update_time, device, json, reset'
    for (const row of first.sql.all<Record<string, string | number | null>>(`SELECT ${cols} FROM rec WHERE tbl != ?`, 'revisionIdeas'))
      second.sql.run(`INSERT INTO rec (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols.split(', ').map((c) => row[c]))
    // 自分では重複と分からない → 作ろうとして「もうある」（409）→ 差分にも無い → 名前で読んで重複
    const c = await tool(second.core, 'novel_add_revision_ideas', input)
    expect(c.text).toContain('重複 1件')
    await settle(owner)
    expect(Object.keys((await owner.load()).revisionIdeas)).toHaveLength(1)
  })

  it('長い批評の結果（前の上限 60,000字の3倍）も、1件が 200,000字に入ればアクセスルールを通って端末に届く。超えれば作らずに分け方を返す', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const { core } = makeConnector()
    await pair(core, owner)
    const line = `批評の段落。${'あ'.repeat(93)}\n`
    // JSON にして 200,000字に近い（改行は \\n の2字）
    const markdown = line.repeat(1_900)
    const ok = await tool(core, 'novel_add_critique_result', { title_id: titleId, result_markdown: markdown })
    expect(ok.text).toContain('追加 1件')
    const got = await waitFor(async () => Object.values((await owner.load()).critiqueResults)[0], '端末に届く', 30_000)
    expect(got.resultMarkdown).toBe(markdown)
    const snap = await getDoc(doc(owner.fs, 'users', owner.uid, 'records', `critiqueResults:${got.id}`))
    const json = (snap.data() as RecordDoc).json!
    expect(json.length).toBeGreaterThan(190_000)
    expect(json.length).toBeLessThanOrEqual(200_000)
    // 超える: 作らず、分けて呼ぶように返す（端末には増えない）
    const big = await tool(core, 'novel_add_critique_result', { title_id: titleId, result_markdown: line.repeat(2_600) })
    expect(big.isError).toBe(true)
    expect(big.text).toMatch(/result_markdown を\d+つ以上に分け/)
    await settle(owner)
    expect(Object.keys((await owner.load()).critiqueResults)).toHaveLength(1)
  })

  it('端末が分割して書いた30万字の改稿案を、写しで組み立てて読める', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const big = '長い改稿案の段落。\n'.repeat(30_000)
    let ideaId = ''
    await owner.edit((d) => {
      const r = C.addRevisionIdea(d, titleId, { heading: '大きな案', body: big })
      ideaId = r.result
      return r.data
    })
    await settle(owner)
    const chunks = await getDoc(doc(owner.fs, 'users', owner.uid, 'records', `revisionIdeas:${ideaId}#0`))
    expect(chunks.exists()).toBe(true)
    const { core } = makeConnector()
    await pair(core, owner)
    expect(core.views().view.revisionIdeas[ideaId].body).toBe(big)
    expect(core.mirror.unreadableCount()).toBe(0)
    const r = await tool(core, 'novel_get_strategy', { title_id: titleId, revision_idea_id: ideaId })
    expect(r.text).toContain('大きな案')
    expect(r.text.length).toBeLessThanOrEqual(100_000)
  })

  it('端末のバックアップからの復元（必ず上書き・削除の印）が写しに届く', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const before = await owner.load()
    await owner.edit((d) => E.addMemo(d, titleId, '後で消えるメモ').data)
    await settle(owner)
    const { core } = makeConnector()
    await pair(core, owner)
    expect((await tool(core, 'novel_get_notes', { title_id: titleId, kind: 'memos' })).text).toContain('後で消えるメモ')
    await owner.restore(before)
    await settle(owner)
    await waitFor(async () => {
      const t = await tool(core, 'novel_get_notes', { title_id: titleId, kind: 'memos' })
      return !t.text.includes('後で消えるメモ')
    }, '復元が写しに届く')
  })

  it('「Claude に見せる: 見せない」のタイトルは、どのツールにも出ない', async () => {
    const owner = await makeDevice('owner', account())
    await owner.online()
    const shown = await writeNovel(owner, ['見せる本文'], '見せる')
    const hidden = await writeNovel(owner, ['秘密の本文'], '秘密')
    await owner.edit((d) => C.setTitleClaudeAccess(d, hidden.titleId, 'none'))
    await settle(owner)
    const { core } = makeConnector()
    await pair(core, owner)
    const list = await tool(core, 'novel_list_titles')
    expect(list.text).toContain('『見せる』')
    expect(list.text).not.toContain('秘密')
    for (const name of ['novel_get_outline', 'novel_read_text', 'novel_get_strategy', 'novel_get_critique', 'novel_list_proofreading'])
      expect((await tool(core, name, { title_id: hidden.titleId })).isError).toBe(true)
    const search = await tool(core, 'novel_search_text', { title_id: shown.titleId, query: '秘密' })
    expect(search.text).not.toContain('秘密の本文')
    const write = await tool(core, 'novel_add_revision_ideas', { title_id: hidden.titleId, items: [{ heading: 'a', body: 'b' }] })
    expect(write.isError).toBe(true)
  })

  it('「書き込みを許可」を外すと作れない（ルールでも拒む）。データの形の版が違えば書き込まない。連携を解除すると 401', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const { core } = makeConnector()
    await pair(core, owner, { writes: false })
    const input = { title_id: titleId, items: [{ heading: 'a', body: 'b' }] }
    const off = await tool(core, 'novel_add_revision_ideas', input)
    expect(off.text).toContain('書き込みは停止中')
    await updateDoc(doc(owner.fs, 'config', 'connector'), { writes: true })
    // 書き込みの可否は60秒ごとに読み直す（状態のツールはいつも読み直す）
    const status = await tool(core, 'novel_status')
    expect(status.text).toContain('書き込み: 許可')
    expect((await tool(core, 'novel_add_revision_ideas', input)).text).toContain('追加 1件')
    // アプリの版がコネクタより新しい（データの形 4）: 書き込まない（読むのは続く）
    owner.offline()
    await setDoc(appModelRef(owner.fs, owner.uid), { model: 4, appVersion: '2.4', updatedAt: serverTimestamp() })
    expect((await tool(core, 'novel_status')).text).toContain('コネクタは 3。書き込みは止まります')
    const newer = await tool(core, 'novel_add_revision_ideas', { title_id: titleId, items: [{ heading: 'c', body: 'd' }] })
    expect(newer.isError).toBe(true)
    expect(newer.text).toContain('コネクタを更新')
    expect((await tool(core, 'novel_list_titles')).isError).toBeUndefined()
    // 連携を解除
    await deleteDoc(doc(owner.fs, 'config', 'connector'))
    const gone = await tool(core, 'novel_list_titles')
    expect(gone.auth).toBe(true)
    expect(core.pairingState()).toBe('unpaired')
  })

  it('コネクタが作った文書は、端末の decodeRecord で読め、device は claude-connector', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文'])
    const { core } = makeConnector()
    await pair(core, owner)
    const r = await tool(core, 'novel_save_critique_prompt', { title_id: titleId, scope: 'shared', name: '全体の批評', body: '構成を見て' })
    expect(r.text).toContain('追加 1件')
    const id = Object.keys(core.views().raw.critiquePrompts)[0]
    expect(id).toBe('cp-2erelebkxp5.20vku24kkd5.1g')
    const snap = await getDoc(doc(owner.fs, 'users', owner.uid, 'records', `critiquePrompts:${id}`))
    const d = snap.data() as RecordDoc
    expect(d.device).toBe('claude-connector')
    expect(decodeRecord(d, () => undefined)).toMatchObject({ id, titleId: null, name: '全体の批評', source: 'claude' })
  })
})
