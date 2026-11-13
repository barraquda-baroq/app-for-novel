// コネクタの結合テスト（Firebase エミュレーターの Auth・Firestore、本番のアクセスルール）。
// 実行: npm run test:connector:emu（リポジトリの直下で）
// アプリの端末（同期のエンジン・端末内の保存）と、コネクタの Vault の中身（node:sqlite）を一緒に動かす。
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { appModelRef } from '../../../src/sync/appModel'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as B from '../../../src/domain/benchOps'
import { applyAutoGenreTags } from '../../../src/domain/benchTags'
import { applyClaudeRequests } from '../../../src/domain/claudeRequests'
import { applyTrashRequests } from '../../../src/domain/claudeTrash'
import * as C from '../../../src/domain/claudeOps'
import * as E from '../../../src/domain/entityOps'
import * as M from '../../../src/domain/materialOps'
import * as S from '../../../src/domain/storyOps'
import { isClaudeIdea } from '../../../src/claude/ideaAppend'
import { pairingHash, randomPairingKey } from '../../../src/claude/pairing'
import { deleteConnector, removeConnection, renameConnection } from '../../../src/features/claude/connectorDoc'
import { CONNECTOR_MODEL } from '../../src/version'
import { FirestoreError } from '../../src/vault/firestore'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { stableStringify } from '../../../src/sync/merge'
import {
  account,
  adminConnectorDoc,
  adminPutConnectorV1,
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
    // アプリの版がコネクタより新しい（データの形がコネクタの次の版）: 書き込まない（読むのは続く）
    owner.offline()
    await setDoc(appModelRef(owner.fs, owner.uid), { model: CONNECTOR_MODEL + 1, appVersion: '9.9', updatedAt: serverTimestamp() })
    expect((await tool(core, 'novel_status')).text).toContain(`コネクタは ${CONNECTOR_MODEL}。書き込みは止まります`)
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

  it('相対比較: 端末で作った作品を読み、コネクタが作った分析（と新しい作品）が両方の端末に届く。比べた作品も批評に残る', async () => {
    const { owner, who, titleId } = await ownerWithNovel(['本文の一話目。'])
    const other = await makeDevice('other', who)
    await other.online()
    let workId = ''
    await owner.edit((d) => {
      const r = B.addBenchWork(d, { name: '銀河の果て', author: '山田', pdfPlace: 'プロジェクト「相対比較」' })
      workId = r.result
      return B.addTitleBenchWork(r.data, titleId, workId)
    })
    await settle(owner, other)
    // タイトルが「読むだけ」でも、相対比較の分析は書ける（相対比較はタイトルの設定と関係ない）
    await owner.edit((d) => C.setTitleClaudeAccess(d, titleId, 'read'))
    await settle(owner)
    const { core } = makeConnector()
    await pair(core, owner)
    expect((await tool(core, 'novel_list_bench_works')).text).toContain('『銀河の果て』（山田）')
    const r = await tool(core, 'novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [
        { viewpoint: '構成', body_markdown: '## 構成\n三幕', run_date: '2026-10-30' },
        { viewpoint: '文体', body_markdown: '## 文体\n短文', run_date: '2026-10-30' },
      ],
    })
    expect(r.text).toContain('追加 2件')
    const made = await tool(core, 'novel_add_bench_analysis', {
      work: '星を継ぐ',
      new_work: { name: '星を継ぐ', author: '高橋' },
      items: [{ viewpoint: '人物', body_markdown: '主人公の弧', run_date: '2026-10-30' }],
    })
    expect(made.text).toContain('『星を継ぐ』（高橋） を相対比較に追加しました')
    // 一覧を作品名で絞る（書いた作品も、すぐに一覧に出る）
    const only = (await tool(core, 'novel_list_bench_works', { names: ['星を継ぐ'] })).text
    expect(only).toContain('=== 相対比較（作品名に「星を継ぐ」を含む作品 1作品／全2作品。')
    expect(only).toContain('『星を継ぐ』（高橋）')
    expect(only).not.toContain('『銀河の果て』')
    for (const d of [owner, other]) {
      await waitFor(
        async () => {
          const x = await d.load()
          return Object.keys(x.benchAnalyses).length === 3 && Object.keys(x.benchWorks).length === 2
        },
        `${d.name} に相対比較の分析が届く`,
        30_000,
      )
      const local = await d.load()
      expect(Object.values(local.benchAnalyses).filter((a) => a.workId === workId).map((a) => a.viewpoint).sort()).toEqual(
        ['文体', '構成'].sort(),
      )
      expect(Object.values(local.benchAnalyses).every((a) => a.source === 'claude')).toBe(true)
      expect(d.notes).toEqual([])
    }
    // 「読むだけ」のタイトルには批評を書けない。「読む＋書き込む」にすると、比べた作品と一緒に記録できる
    await owner.edit((d) => C.setTitleClaudeAccess(d, titleId, 'write'))
    await settle(owner)
    await waitFor(async () => {
      const t = await tool(core, 'novel_get_critique', { title_id: titleId })
      return t.text.includes('相対比較する作品（1作品')
    }, 'コネクタに相対比較する作品が見える', 30_000)
    const result = await tool(core, 'novel_add_critique_result', {
      title_id: titleId,
      result_markdown: '## 比べると\n…',
      bench_works: ['銀河の果て'],
    })
    expect(result.text).toContain('追加 1件')
    await waitFor(
      async () => Object.values((await other.load()).critiqueResults).find((x) => x.benchWorkIds?.[0] === workId),
      '比べた作品つきの批評の結果が届く',
      30_000,
    )
  })

  it('資料: 端末で作った資料を読み、コネクタが作った資料と記録が両方の端末に届く（タイトルを見せなくても）。タグは作者が付ける', async () => {
    const { owner, who, titleId } = await ownerWithNovel(['本文の一話目。'])
    const other = await makeDevice('other', who)
    await other.online()
    let handMade = ''
    await owner.edit((d) => {
      const r = M.addMaterial(d, { name: '江戸の暮らし', author: '山田', tags: ['歴史', '江戸'], pdfPlace: 'プロジェクト「資料」' })
      handMade = r.result
      return r.data
    })
    // 資料はタイトルの設定と関係ない（タイトルを見せなくても読み書きできる）
    await owner.edit((d) => C.setTitleClaudeAccess(d, titleId, 'none'))
    await settle(owner, other)
    const { core } = makeConnector()
    await pair(core, owner)
    expect((await tool(core, 'novel_list_materials')).text).toContain('『江戸の暮らし』（山田） 山田\n  タグ: 歴史・江戸')
    const r = await tool(core, 'novel_add_material_notes', {
      material: '江戸の暮らし',
      items: [
        { section: '要約', body_markdown: '## 要約\n第1章 町の成り立ち。', run_date: '2026-11-02' },
        { section: '描写に使える部分', body_markdown: '- 物売りの声（第2章）', run_date: '2026-11-02' },
      ],
    })
    expect(r.text).toContain('追加 2件')
    const made = await tool(core, 'novel_add_material_notes', {
      material: '外科の歴史',
      new_material: { name: '外科の歴史', author: '高橋' },
      items: [
        { section: '創作に役立つ知識', body_markdown: '- 麻酔の普及は19世紀（第4章）', run_date: '2026-11-02' },
        { section: 'サンプルシーン', body_markdown: '場面: 野戦病院。\n灯りが揺れた。', run_date: '2026-11-02' },
      ],
    })
    expect(made.text).toContain('『外科の歴史』（高橋） を資料に追加しました')
    // 書いた資料も、すぐに一覧に出る（タグは付けない。タグで絞れば、作者がタグを付けた資料だけ）
    const only = (await tool(core, 'novel_list_materials', { names: ['外科'] })).text
    expect(only).toContain('=== 資料（資料名に「外科」を含む資料 1件／全2件。')
    expect(only).toContain('『外科の歴史』（高橋） 高橋\n  記録 2件')
    const tagged = (await tool(core, 'novel_list_materials', { tags: ['歴史'] })).text
    expect(tagged).toContain('=== 資料（タグ「歴史」を持つ資料 1件／全2件。')
    expect(tagged).toContain('『江戸の暮らし』')
    expect(tagged).not.toContain('『外科の歴史』')
    for (const d of [owner, other]) {
      await waitFor(
        async () => {
          const x = await d.load()
          return Object.keys(x.materialNotes).length === 4 && Object.keys(x.materials).length === 2
        },
        `${d.name} に資料の記録が届く`,
        30_000,
      )
      const local = await d.load()
      expect(Object.values(local.materialNotes).filter((n) => n.materialId === handMade).map((n) => n.section).sort()).toEqual(
        ['描写に使える部分', '要約'].sort(),
      )
      const surgery = Object.values(local.materials).find((m) => m.id !== handMade)!
      expect(surgery).toMatchObject({ name: '外科の歴史', author: '高橋', source: 'claude' })
      expect(surgery.tags).toBeUndefined()
      expect(local.materials[handMade].tags).toEqual(['歴史', '江戸'])
      expect(Object.values(local.materialNotes).filter((n) => n.materialId === surgery.id)).toHaveLength(2)
      expect(Object.values(local.materialNotes).every((n) => n.source === 'claude')).toBe(true)
      expect(d.notes).toEqual([])
    }
    // Claude が書いた資料に、作者がタグを付ける（もう一方の端末とコネクタにも届く）
    const surgeryId = Object.keys((await owner.load()).materials).find((id) => id !== handMade)!
    await owner.edit((d) => M.setMaterialTags(d, surgeryId, ['医療', '歴史']))
    await settle(owner, other)
    await waitFor(
      async () => (await other.load()).materials[surgeryId]?.tags?.join('・') === '医療・歴史',
      'もう一方の端末に作者のタグが届く',
      30_000,
    )
    await waitFor(
      async () => (await tool(core, 'novel_list_materials', { tags: ['歴史'] })).text.includes('タグ「歴史」を持つ資料 2件／全2件'),
      'コネクタの一覧に作者のタグが出る',
      30_000,
    )
    expect((await tool(core, 'novel_list_materials', { tags: ['医療', '歴史'] })).text).toContain(
      '『外科の歴史』（高橋） 高橋\n  タグ: 医療・歴史',
    )
  })

  it('相対比較のタグ（2.7）: コネクタが作品と「14 検索用タグ」を登録した直後から tags で絞れ、端末が付けた後も同じ。端末で外すと一覧から消える', async () => {
    const { owner, who } = await ownerWithNovel(['本文の一話目。'])
    const other = await makeDevice('other', who)
    await other.online()
    await settle(owner, other)
    const { core } = makeConnector()
    await pair(core, owner)
    const body14 = [
      '**結論**：港町の喫茶店を舞台に、喪失から立ち直る二人を描く恋愛小説',
      '担当：編集長（マーケター案を確定）',
      '',
      '- 判定したジャンル：恋愛',
      '- 適性のある賞（選んだ理由）：架空の恋愛小説新人賞（理由）',
      '※この2行には、役割の前の判定をそのまま写す。「ジャンル／サブジャンル」のジャンルは、判定したジャンルと同じ名前にする。',
      '- ジャンル／サブジャンル：恋愛／青春・喪失',
    ].join('\n')
    const made = await tool(core, 'novel_add_bench_analysis', {
      work: '港の喫茶店',
      new_work: { name: '港の喫茶店', author: '山田' },
      items: [{ viewpoint: '14 検索用タグ', body_markdown: body14, run_date: '2026-11-01' }],
    })
    expect(made.text).toContain('追加 1件')
    // どの端末もまだ付けていないが、コネクタは 14 から付くタグを見せる
    const love = (await tool(core, 'novel_list_bench_works', { tags: ['恋愛'] })).text
    expect(love).toContain('=== 相対比較（タグ「恋愛」を持つ作品 1作品／全1作品。')
    expect(love).toContain('『港の喫茶店』（山田） 山田\n  タグ: 恋愛・青春・喪失')
    // 端末に届き、端末が自動のタグを付けて同期しても同じ
    await waitFor(async () => Object.keys((await owner.load()).benchAnalyses).length === 1, '端末に 14 が届く', 30_000)
    await owner.edit(applyAutoGenreTags)
    await settle(owner, other)
    const workId = Object.keys((await owner.load()).benchWorks)[0]
    expect((await owner.load()).benchWorks[workId].tags).toEqual(['恋愛', '青春', '喪失'])
    await waitFor(async () => (await other.load()).benchWorks[workId]?.tags?.length === 3, 'もう一方の端末にタグが届く', 30_000)
    expect((await tool(core, 'novel_list_bench_works', { tags: ['恋愛'] })).text).toContain('タグ: 恋愛・青春・喪失')
    // 端末で外すと、写しが届いた後の一覧から消える（autoTagsFrom が進んでいるので 14 から付き直さない）
    await other.edit((d) => B.setBenchWorkTags(d, workId, ['恋愛']))
    await settle(other, owner)
    await waitFor(
      async () => (await tool(core, 'novel_list_bench_works', { tags: ['青春'] })).text.includes('（タグ「青春」を持つ作品はありません）'),
      'コネクタの一覧から外したタグが消える',
      30_000,
    )
    expect((await tool(core, 'novel_get_bench_analysis', { work: '港の喫茶店' })).text.split('\n').slice(1, 3)).toEqual(['山田', 'タグ: 恋愛'])
    expect(owner.notes).toEqual([])
    expect(other.notes).toEqual([])
  })

  it('ゴミ箱へ移す（2.7）: 本番のルールで依頼が作れ、コネクタからのカードの削除・書き換えは拒まれる。端末が処理すると写しからも消え、ゴミ箱に入る', async () => {
    const { owner, who } = await ownerWithNovel(['本文の一話目。'])
    const other = await makeDevice('other', who)
    await other.online()
    let workId = ''
    await owner.edit((d) => {
      const w = B.addBenchWork(d, { name: '銀河の果て', author: '山田' })
      workId = w.result
      return w.data
    })
    await settle(owner, other)
    const { core } = makeConnector()
    await pair(core, owner)
    const added = await tool(core, 'novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [
        { viewpoint: '構成', body_markdown: '## 構成\n三幕。', run_date: '2026-10-30' },
        { viewpoint: '文体', body_markdown: '## 文体\n短い文。', run_date: '2026-10-30' },
      ],
    })
    const [n1, n2] = (added.structured as { created: { id: string }[] }).created.map((c) => c.id)
    for (const d of [owner, other])
      await waitFor(async () => Object.keys((await d.load()).benchAnalyses).length === 2, `${d.name} に分析が届く`, 30_000)
    const r = await tool(core, 'novel_move_cards_to_trash', { cards: [n1] })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain(`- 移す ${n1} 相対比較『銀河の果て』の「構成」（2026-10-30）`)
    expect((await tool(core, 'novel_list_bench_works')).text).toContain('分析 1件')
    // コネクタは依頼を作るだけ: カードの削除・削除の印への書き換えは、本番のルールが拒む
    const cardId = Object.values((await owner.load()).benchAnalyses).find((a) => a.viewpoint === '構成')!.id
    const name = core.fs.name(`users/${owner.uid}/records/benchAnalyses:${cardId}`)
    await expect(core.fs.commit([{ delete: name }])).rejects.toSatisfy((e) => e instanceof FirestoreError && e.status === 403)
    await expect(
      core.fs.commit([
        {
          update: { name, fields: { table: { stringValue: 'benchAnalyses' }, id: { stringValue: cardId }, deleted: { booleanValue: true } } },
          updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }],
        },
      ]),
    ).rejects.toSatisfy((e) => e instanceof FirestoreError && e.status === 403)
    // 端末に依頼が届き、受け持ちの端末が処理する（ClaudeRequests と同じ applyTrashRequests）
    await waitFor(async () => Object.keys((await owner.load()).trashRequests).length === 1, '依頼が端末に届く', 30_000)
    await owner.edit((d) => applyTrashRequests(d, Date.now()).data)
    await settle(owner, other)
    await waitFor(async () => !(await other.load()).benchAnalyses[cardId], 'もう一方の端末からも消える', 30_000)
    const local = await other.load()
    expect(Object.values(local.trashEntries).map((e) => [e.kind, e.by, e.parentLabel])).toEqual([['benchAnalysis', 'claude', '銀河の果て']])
    expect(local.trashRequests).toEqual({})
    expect(Object.keys(local.benchAnalyses)).toHaveLength(1)
    expect(local.benchWorks[workId]).toBeDefined()
    expect([...owner.notes, ...other.notes]).toEqual([])
    // 写しからもカードと依頼が消える（依頼中の行は出ない）。もう一度頼むと「もうゴミ箱にある」
    await waitFor(
      async () => {
        const text = (await tool(core, 'novel_list_bench_works')).text
        return text.includes('分析 1件') && !text.includes('依頼中')
      },
      'コネクタの写しから依頼が消える',
      30_000,
    )
    expect(Object.keys(core.views().raw.trashRequests)).toEqual([])
    const again = await tool(core, 'novel_move_cards_to_trash', { cards: [n1, n2] })
    expect(again.text).toContain(`- 移さない ${n1}（もうゴミ箱にある）`)
    expect(again.text).toContain(`- 移す ${n2}`)
  })

  it('アイデア（2.8）: 本番のルールでホーム・タイトルのアイデアと追記・ゴミ箱へ移す依頼が作れ、コネクタからのアイデアの書き換え・削除は拒まれる。端末が処理すると写しから依頼が消え、追記した後のカードが見える', async () => {
    const { owner, who, titleId } = await ownerWithNovel(['本文の一話目。'])
    const other = await makeDevice('other', who)
    await other.online()
    // 作者が書いたホームのアイデア（Claude からは見えない）
    let authorId = ''
    await owner.edit((d) => {
      const r = E.addIdea(d, null, '', 'ホームの作者の案')
      authorId = r.result
      return r.data
    })
    await settle(owner, other)
    const { core } = makeConnector()
    await pair(core, owner)
    const home = await tool(core, 'novel_add_ideas', { placement: 'outside', items: [{ name: '第3章の動機', content: '【動機】\n・兄を探す' }] })
    expect(home.isError).toBeUndefined()
    expect(home.text).toContain('入れた場所: ホームのアイデア（')
    const inTitle = await tool(core, 'novel_add_ideas', { placement: 'outside', title_id: titleId, items: [{ content: '【場面】\n・灰の降る庭' }] })
    expect(inTitle.text).toContain('入れた場所: タイトル『星の庭』のアイデア（')
    const [homeRef] = (home.structured as { created: { id: string }[] }).created.map((c) => c.id)
    const [titleRef] = (inTitle.structured as { created: { id: string }[] }).created.map((c) => c.id)
    for (const d of [owner, other])
      await waitFor(
        async () => Object.values((await d.load()).ideas).filter((i) => isClaudeIdea(i)).length === 2,
        `${d.name} に Claude のアイデアが届く`,
        30_000,
      )
    const local = await owner.load()
    const homeIdea = Object.values(local.ideas).find((i) => isClaudeIdea(i) && i.titleId === null)!
    // 端末に届いた内容 = コネクタが書いた JSON（済みでないアイデアの先頭）
    expect(stableStringify(homeIdea)).toBe(stableStringify(core.views().raw.ideas[homeIdea.id]))
    expect(homeIdea.order).toBeLessThan(local.ideas[authorId].order)
    // 読む（title_id なし。作者が書いたホームのアイデアは見えない）→ 印 → 追記
    const list = (await tool(core, 'novel_get_notes', { kind: 'ideas' })).text
    expect(list).toContain(`${homeRef} 【Claude】`)
    expect(list).not.toContain('ホームの作者の案')
    const full = (await tool(core, 'novel_get_notes', { kind: 'ideas', ids: [homeRef] })).text
    const mark = /印: (\S+) ===/.exec(full)![1]
    const appended = await tool(core, 'novel_append_to_idea', { idea_id: homeRef, read_mark: mark, content: '【変更】\n・姉を探す' })
    expect(appended.isError).toBeUndefined()
    expect(appended.text).toContain('アイデアに追記: 追記 1件')
    // Claude からは、もう追記した後の中身（アプリが足すまで「同期待ち」）
    const seen = (await tool(core, 'novel_get_notes', { kind: 'ideas', ids: [homeRef] })).text
    expect(seen).toContain('アプリの同期待ちの追記 1件を含む')
    const seenBody = seen.slice(seen.indexOf('===\n') + 4)
    expect(seenBody).toMatch(/\n\n\d{4}\/\d{2}\/\d{2}のセッションで以下の内容へ変更\n【変更】\n・姉を探す$/)
    // コネクタは作るだけ: 作者のアイデアも Claude のアイデアも、削除・書き換えは本番のルールが拒む
    for (const id of [authorId, homeIdea.id]) {
      const name = core.fs.name(`users/${owner.uid}/records/ideas:${id}`)
      await expect(core.fs.commit([{ delete: name }])).rejects.toSatisfy((e) => e instanceof FirestoreError && e.status === 403)
      await expect(
        core.fs.commit([
          {
            update: { name, fields: { table: { stringValue: 'ideas' }, id: { stringValue: id }, deleted: { booleanValue: true } } },
            updateTransforms: [{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }],
          },
        ]),
      ).rejects.toSatisfy((e) => e instanceof FirestoreError && e.status === 403)
    }
    // 端末に依頼が届き、受け持ちの端末が処理する（ClaudeRequests と同じ applyClaudeRequests）
    await waitFor(async () => Object.keys((await owner.load()).ideaAppends).length === 1, '追記の依頼が端末に届く', 30_000)
    await owner.edit((d) => applyClaudeRequests(d, Date.now()).data)
    await settle(owner, other)
    await waitFor(async () => (await other.load()).ideas[homeIdea.id]?.body === seenBody, 'もう一方の端末に追記した後の本文が届く', 30_000)
    // 写しから依頼が消え、追記した後のカード（印は Claude が先に見たものと同じ）
    await waitFor(
      async () => {
        const t = (await tool(core, 'novel_get_notes', { kind: 'ideas', ids: [homeRef] })).text
        return !t.includes('同期待ち') && t.endsWith(seenBody)
      },
      'コネクタの写しから追記の依頼が消える',
      30_000,
    )
    expect(Object.keys(core.views().raw.ideaAppends)).toEqual([])
    expect((await tool(core, 'novel_get_notes', { kind: 'ideas', ids: [homeRef] })).text.split('\n')[0]).toBe(
      seen.split('\n')[0].replace('・アプリの同期待ちの追記 1件を含む', ''),
    )
    // ゴミ箱へ移す（i:…）。端末が処理するとゴミ箱へ（追記した後の形で）
    const trash = await tool(core, 'novel_move_cards_to_trash', { cards: [homeRef, titleRef] })
    expect(trash.text).toContain(`- 移す ${homeRef} ホームのアイデア「`)
    expect(trash.text).toContain(`- 移す ${titleRef} タイトル『星の庭』のアイデア「`)
    await waitFor(async () => Object.keys((await owner.load()).trashRequests).length === 2, 'ゴミ箱へ移す依頼が端末に届く', 30_000)
    await owner.edit((d) => applyClaudeRequests(d, Date.now()).data)
    await settle(owner, other)
    await waitFor(async () => !Object.values((await other.load()).ideas).some((i) => isClaudeIdea(i)), 'もう一方の端末からも消える', 30_000)
    const after = await other.load()
    expect(Object.values(after.trashEntries).map((e) => [e.kind, e.by])).toEqual([
      ['idea', 'claude'],
      ['idea', 'claude'],
    ])
    expect(Object.values(after.trashRecords).map((r) => (r.record as { body: string }).body)).toContain(seenBody)
    expect(after.ideas[authorId]).toBeDefined()
    expect(after.trashRequests).toEqual({})
    expect([...owner.notes, ...other.notes]).toEqual([])
    await waitFor(
      async () => (await tool(core, 'novel_get_notes', { kind: 'ideas' })).text.includes('（ありません）'),
      'コネクタの写しからも消える',
      30_000,
    )
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

  it('複数の接続（2.9）: 2回許可すると一覧に2つ。どちらの許可も使え、1つ解除するとその許可だけ使えない（Vault は連携したまま）。すべて解除で両方とも使えない', async () => {
    const { owner, titleId } = await ownerWithNovel(['本文の一話目。'])
    const { core } = makeConnector()
    const first = await pair(core, owner)
    const second = await pair(core, owner)
    expect(first.cid).not.toBe(second.cid)
    expect(second.grant.gen).toBe(first.grant.gen)
    const d = (await getDoc(doc(owner.fs, 'config', 'connector'))).data()!
    expect(d.v).toBe(2)
    expect(d.pairingCid).toBe(second.cid)
    expect(Object.keys(d.connections).sort()).toEqual([first.cid, second.cid].sort())
    expect([d.connections[first.cid].name, d.connections[second.cid].name]).toEqual(['接続1', '接続2'])
    const last = (text: string) => text.split('\n').at(-1)
    for (const [p, name] of [
      [first, '接続1'],
      [second, '接続2'],
    ] as const) {
      const status = await tool(core, 'novel_status', {}, p.grant)
      expect(status.isError).toBeUndefined()
      expect(last(status.text)).toBe(`この接続: ${name}（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）`)
      expect((await tool(core, 'novel_list_titles', {}, p.grant)).text).toContain('『星の庭』')
    }
    const input = { title_id: titleId, items: [{ heading: '二つ目の接続から', body: '書ける' }] }
    expect((await tool(core, 'novel_add_revision_ideas', input, second.grant)).text).toContain('追加 1件')
    // 名前を変える（novel_status の「この接続」もすぐ変わる）
    await renameConnection(first.cid, '仕事用', owner.fs)
    expect(last((await tool(core, 'novel_status', {}, first.grant)).text)).toBe(
      'この接続: 仕事用（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    // 1つ解除: その許可だけが「連携が解除されています」（401）。ほかの接続・Vault の連携はそのまま
    expect(await removeConnection(first.cid, owner.fs)).toBe('removed')
    const gone = await tool(core, 'novel_status', {}, first.grant)
    expect(gone.auth).toBe(true)
    expect(gone.text).toContain('Novel Studio 側で連携が解除されています')
    expect((await tool(core, 'novel_list_titles', {}, first.grant)).auth).toBe(true)
    expect(await core.checkGrant(first.grant)).toBe(false)
    expect(core.pairingState()).toBe('paired')
    expect((await tool(core, 'novel_list_titles', {}, second.grant)).isError).toBeUndefined()
    expect(last((await tool(core, 'novel_status', {}, second.grant)).text)).toBe(
      'この接続: 接続2（接続 1 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    expect(await core.checkGrant(second.grant)).toBe(true)
    // 連携をすべて解除（記録を消す）: どの許可も使えず、Vault の連携も外れる
    await deleteConnector(owner.fs)
    for (const p of [second, first]) expect((await tool(core, 'novel_status', {}, p.grant)).auth).toBe(true)
    expect(core.pairingState()).toBe('unpaired')
    expect(await core.checkGrant(second.grant)).toBe(false)
    // もう一度許可すると新しい代（前の許可は戻らない）
    const again = await pair(core, owner)
    expect(again.grant.gen).not.toBe(second.grant.gen)
    expect((await tool(core, 'novel_status', {}, second.grant)).auth).toBe(true)
    expect((await tool(core, 'novel_status', {}, again.grant)).isError).toBeUndefined()
  })

  it('入れ替え（2.9）: 入れ替えた接続はすぐ使えず、新しい接続は前の名前を引き継がない（名前は画面で決める）', async () => {
    const { owner } = await ownerWithNovel(['本文'])
    const { core } = makeConnector()
    const first = await pair(core, owner)
    const second = await pair(core, owner, { replaceCid: first.cid, name: '接続1' })
    const d = (await getDoc(doc(owner.fs, 'config', 'connector'))).data()!
    expect(Object.keys(d.connections)).toEqual([second.cid])
    expect(d.connections[second.cid].name).toBe('接続1')
    expect((await tool(core, 'novel_list_titles', {}, first.grant)).auth).toBe(true)
    expect((await tool(core, 'novel_list_titles', {}, second.grant)).isError).toBeUndefined()
  })

  it('2.8 からの移し替え（2.9）: 2.8 のアプリの記録（v1）で連携した許可（接続の id が無い）は、接続を足した後もそのまま使え（作られた時刻 = 代は同じ）、接続1 を解除すると使えない', async () => {
    const { owner } = await ownerWithNovel(['本文'])
    const { core } = makeConnector()
    // 2.8 のアプリが書いた記録と、2.8 のコネクタの許可（props に cid が無い）
    const id = await core.connectIdentity()
    const hash = await pairingHash('state-2.8', randomPairingKey())
    await adminPutConnectorV1(id.uid, hash)
    const v1 = await core.verifyPairing(hash)
    if (!v1.ok) throw new Error(v1.message)
    expect(v1.cid).toBe('c0')
    for (let i = 0; i < 500; i++) if ((await core.alarm()) === null) break
    const legacy = { ownerUid: v1.ownerUid, gen: v1.gen }
    const before = (await adminConnectorDoc())!
    const last = (text: string) => text.split('\n').at(-1)
    expect(last((await tool(core, 'novel_status', {}, legacy)).text)).toBe(
      'この接続: 接続1（接続 1 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    // 2.9 のアプリで接続を足す: 記録は一覧の形に移り（作られた時刻は同じ）、2.8 の接続は c0「接続1」のまま
    const added = await pair(core, owner)
    const after = (await adminConnectorDoc())!
    expect(after.createTime).toBe(before.createTime)
    expect(added.grant.gen).toBe(legacy.gen)
    const d = (await getDoc(doc(owner.fs, 'config', 'connector'))).data()!
    expect(d.v).toBe(2)
    expect(d.connections.c0).toMatchObject({ name: '接続1', pairing: hash, approvedOn: '2.8 の Mac' })
    expect(d.connections.c0.pairedAt.toMillis()).toBe(
      Date.parse(String((before.fields.pairedAt as { timestampValue: string }).timestampValue)),
    )
    expect(d.connections[added.cid].name).toBe('接続2')
    const status = await tool(core, 'novel_status', {}, legacy)
    expect(status.isError).toBeUndefined()
    expect(last(status.text)).toBe('この接続: 接続1（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）')
    expect((await tool(core, 'novel_list_titles', {}, legacy)).isError).toBeUndefined()
    expect(await core.checkGrant(legacy)).toBe(true)
    // 接続1 を解除すると、2.8 の許可は使えない（2.9 で足した接続はそのまま）
    expect(await removeConnection('c0', owner.fs)).toBe('removed')
    expect((await tool(core, 'novel_status', {}, legacy)).auth).toBe(true)
    expect(await core.checkGrant(legacy)).toBe(false)
    expect((await tool(core, 'novel_list_titles', {}, added.grant)).isError).toBeUndefined()
    expect((await adminConnectorDoc())!.createTime).toBe(before.createTime)
  })
})
