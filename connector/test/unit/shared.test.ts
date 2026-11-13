// 2.9 の複数の接続（claude.ai のアカウント）で1つの Vault を使う時の答え: 1日の枠はすべての接続で1つ（断る文に残りとこの呼び出しの数・
// すべての接続で数えること）、novel_status の「連携: 済み（…）」はその接続の許可の時刻、接続が2つ以上の時は合わせた数の行。
// 2つのアカウントが同時に同じ本を足す（著者の空白の違い）・同じ【原稿】の回の札を選ぶ・まだ決まらない作品を比べた作品にする時。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../../../src/domain/benchOps'
import type { AppData } from '../../../src/domain/types'
import { benchWorkId } from '../../../src/claude/derivedId'
import { shortId } from '../../../src/claude/refs'
import { novel } from '../../../src/test/claudeFixture'
import type { QuotaCounts } from '../../src/vault/quota'
import { CONNECTOR_MODEL, CONNECTOR_VERSION } from '../../src/version'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, addConnection, pairedCore } from '../support/harness'

async function accounts(data: AppData | null, opts: Parameters<typeof pairedCore>[2] = {}) {
  const fake = new FakeFirebase()
  const made = await pairedCore(fake, data, { cid: 'caaa', ...opts })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', name: '接続2', pairedAt: made.clock.now })
  return { fake, ...made, a: made.grant, b }
}

const quota = (core: { store: { getMeta: <T>(k: string) => T | null } }) => core.store.getMeta<QuotaCounts>('quota')!
const docsOf = (fake: FakeFirebase, table: string) => fake.recordDocs(OWNER).filter((d) => d.name.includes(`/${table}:`))
const ideas = (titleId: string, from: number, count: number) => ({
  title_id: titleId,
  items: Array.from({ length: count }, (_, i) => ({ heading: `案${from + i}`, body: `本文${from + i}` })),
})

describe('書き込みの枠（すべての接続で1つ）', () => {
  it('この呼び出しの分が入らない時は、すべての接続を合わせた残りとこの呼び出しの数を出して呼び出し全体を断る。分ければ書ける。使い切った時もすべての接続で数えると言う', async () => {
    const n = novel(['本文。'])
    const { core, fake, a, b } = await accounts(n.data, { config: { dailyWriteBudget: 30 } })
    // 2つのアカウントが同時に書く（20件と5件）
    const both = await Promise.all([
      core.callTool('novel_add_revision_ideas', ideas(n.titleId, 0, 20), { grant: a }),
      core.callTool('novel_add_revision_ideas', ideas(n.titleId, 100, 5), { grant: b }),
    ])
    expect(both.map((r) => r.isError)).toEqual([undefined, undefined])
    expect(quota(core).writes).toBe(25)
    // B はほとんど書いていなくても、A の分と合わせた残り（5件）に10件は入らない: 何も書かず、残りとこの呼び出しの数を出す
    const big = await core.callTool('novel_add_revision_ideas', ideas(n.titleId, 200, 10), { grant: b })
    expect(big.isError).toBe(true)
    expect(big.text).toBe(
      '今日のコネクタ用の書き込み枠は、すべての接続を合わせて残り 5 件です（この呼び出しは 10 件）。何も書いていません。items を分けて少なくすると書けます。日本時間16時に回復します。',
    )
    expect(docsOf(fake, 'revisionIdeas')).toHaveLength(25)
    expect(quota(core).writes).toBe(25)
    // 分けて少なくすれば書ける
    const small = await core.callTool('novel_add_revision_ideas', ideas(n.titleId, 200, 5), { grant: b })
    expect(small.isError).toBeUndefined()
    expect(quota(core).writes).toBe(30)
    // 使い切った後は「使い切りました」（すべての接続を合わせて数える）
    const none = await core.callTool('novel_add_revision_ideas', ideas(n.titleId, 300, 1), { grant: a })
    expect(none.isError).toBe(true)
    expect(none.text).toBe(
      '今日のコネクタ用の書き込み枠を使い切りました（アプリの同期を守るため。すべての接続を合わせて数えます）。日本時間16時に回復します。',
    )
    expect(docsOf(fake, 'revisionIdeas')).toHaveLength(30)
  })

  it('ゴミ箱へ移す依頼は cards を分けるよう言う。1日100件の文も、すべての接続を合わせた数だと言う', async () => {
    const n = novel(['本文。'])
    const { core, fake, a, b } = await accounts(n.data, { config: { dailyWriteBudget: 6 } })
    const added = await core.callTool(
      'novel_add_bench_analysis',
      {
        work: '作品A',
        new_work: { name: '作品A', author: '山田' },
        items: ['構成', '文体', '人物'].map((viewpoint) => ({ viewpoint, body_markdown: `## ${viewpoint}`, run_date: '2026-10-29' })),
      },
      { grant: a },
    )
    const cards = [...added.text.matchAll(/- 追加 (n:\S+)/g)].map((m) => m[1])
    expect(cards).toHaveLength(3)
    expect(quota(core).writes).toBe(4)
    const over = await core.callTool('novel_move_cards_to_trash', { cards }, { grant: b })
    expect(over.isError).toBe(true)
    expect(over.text).toBe(
      '今日のコネクタ用の書き込み枠は、すべての接続を合わせて残り 2 件です（この呼び出しは 3 件）。何も書いていません。cards を分けて少なくすると書けます。日本時間16時に回復します。',
    )
    expect(docsOf(fake, 'trashRequests')).toHaveLength(0)
    core.store.setMeta('trashDaily', { day: '2026-10-29', count: 99 })
    const daily = await core.callTool('novel_move_cards_to_trash', { cards: cards.slice(0, 2) }, { grant: b })
    expect(daily.isError).toBe(true)
    expect(daily.text).toContain(
      '今日（日本時間）ゴミ箱へ移せるのは、あと1件です（すべての接続を合わせて1日100件まで。いま新しく2件）。数を減らすか、明日にしてください',
    )
  })
})

describe('読み取りの枠（すべての接続で1つ）', () => {
  it('書く前に最新の変更を確かめる読み取りが残っていなければ、残りと書かない理由を言う。使い切った時はすべての接続で数えると言う', async () => {
    const n = novel(['本文。'])
    const { core, clock, a, b } = await accounts(n.data)
    const day = quota(core).day
    clock.now += 20_000
    core.store.setMeta('quota', { day, reads: 15_000 - 40, writes: 0 } satisfies QuotaCounts)
    const few = await core.callTool('novel_add_revision_ideas', ideas(n.titleId, 0, 1), { grant: a })
    expect(few.isError).toBe(true)
    const left = 15_000 - quota(core).reads
    expect(left).toBeGreaterThan(0)
    expect(few.text).toBe(
      `今日のコネクタ用の読み取り枠は、すべての接続を合わせて残り ${left} 件です。書く前に端末からの最新の変更を確かめるには足りないため、何も書いていません（読むツールは前に取り込んだ内容で使えます）。日本時間16時に回復します。`,
    )
    // 読むツールは前に取り込んだ内容で答える
    const read = await core.callTool('novel_list_titles', {}, { grant: b })
    expect(read.isError).toBeUndefined()
    expect(read.text).toContain('（今日の読み取り枠を使い切ったため、最新の変更を取り込めていません。')
    core.store.setMeta('quota', { day, reads: 15_000, writes: 0 } satisfies QuotaCounts)
    const none = await core.callTool('novel_add_revision_ideas', ideas(n.titleId, 0, 1), { grant: b })
    expect(none.text).toBe(
      '今日のコネクタ用の読み取り枠を使い切りました（アプリの同期を守るため。すべての接続を合わせて数えます）。日本時間16時に回復します。',
    )
  })
})

describe('novel_status（接続ごと）', () => {
  it('「連携: 済み（…）」はその接続を許可した時刻。接続が2つ以上の時だけ、「この接続」の前にすべての接続を合わせた数の行', async () => {
    const fake = new FakeFirebase()
    // A は 12:00、B は 15:00（日本時間）に許可した
    const { core, uid, clock, grant: a } = await pairedCore(fake, novel(['本文。']).data, { cid: 'caaa' })
    const one = (await core.callTool('novel_status', {}, { grant: a })).text.split('\n')
    expect(one[1]).toBe('連携: 済み（2026-10-29 12:00 日本時間）')
    expect(one.at(-2)).toMatch(/^アイデアへの追記の依頼: /)
    clock.now += 3 * 3_600_000
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', name: '接続2', pairedAt: clock.now })
    const lines = (g: typeof a) => core.callTool('novel_status', {}, { grant: g }).then((r) => r.text.split('\n'))
    const [la, lb] = [await lines(a), await lines(b)]
    expect(la[1]).toBe('連携: 済み（2026-10-29 12:00 日本時間）')
    expect(lb[1]).toBe('連携: 済み（2026-10-29 15:00 日本時間）')
    // 1行目・書き込み・データの形・取り込み・今日の数の行は変えない（V30）
    expect(la[0]).toBe(`Novel Studio コネクタ ${CONNECTOR_VERSION}（データの形 ${CONNECTOR_MODEL}）`)
    expect(la[2]).toBe('書き込み: 許可')
    expect(la[3]).toBe(`アプリのデータの形: ${CONNECTOR_MODEL}（一致）`)
    expect(la[4]).toMatch(/^取り込み: 完了（/)
    expect(la[6]).toMatch(/^今日（太平洋時間 2026-10-28）の読み取り [\d,]+ \/ 15,000・書き込み 0 \/ 5,000（日本時間16時に戻ります）$/)
    // 読み取りの数は呼ぶたびに増える（状態のツールも記録を読む）ので、その行のほかを比べる
    const others = (l: string[]) => l.slice(2, -1).filter((x) => !x.startsWith('今日（'))
    expect(others(la)).toEqual(others(lb))
    for (const l of [la, lb]) {
      expect(l.at(-3)).toMatch(/^アイデアへの追記の依頼: /)
      expect(l.at(-2)).toBe('（読み取り・書き込みの枠と、ゴミ箱へ移す1日100件は、すべての接続を合わせた数です）')
    }
    expect(la.at(-1)).toBe('この接続: 接続1（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）')
    expect(lb.at(-1)).toBe('この接続: 接続2（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）')
    // 許可の無い呼び出しは、最後に確かめた連携の時刻（今までどおり）
    expect((await core.callTool('novel_status', {})).text.split('\n')[1]).toBe('連携: 済み（2026-10-29 15:00 日本時間）')
    // B を外すと、A の行はもとの1つの形に戻る
    fake.removeConnection('cbbb')
    const alone = await lines(a)
    expect(alone[1]).toBe('連携: 済み（2026-10-29 12:00 日本時間）')
    expect(alone.at(-2)).toMatch(/^アイデアへの追記の依頼: /)
    expect(alone.some((l) => l.includes('すべての接続を合わせた数です'))).toBe(false)
  })
})

describe('2つのアカウントが同時に相対比較に足す', () => {
  const items = (body: string) => [{ viewpoint: '00 読書ノート', body_markdown: `## 読書ノート\n${body}`, run_date: '2026-10-29' }]

  it('同じ本の著者の書き方が空白だけ違っても、1つの作品に足す（作品の id は今までどおり）', async () => {
    for (const author of ['村上 春樹', '村上　春樹']) {
      const { core, fake, a, b } = await accounts(novel(['本文。']).data)
      // どちらも一覧で作品が無いのを見てから、同時に new_work で送る
      const [ra, rb] = await Promise.all([
        core.callTool('novel_add_bench_analysis', { work: 'ノルウェイの森', new_work: { name: 'ノルウェイの森', author: '村上春樹' }, items: items('A') }, { grant: a }),
        core.callTool('novel_add_bench_analysis', { work: 'ノルウェイの森', new_work: { name: 'ノルウェイの森', author }, items: items('B') }, { grant: b }),
      ])
      expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
      expect(docsOf(fake, 'benchAnalyses')).toHaveLength(2)
      const texts = [ra.text, rb.text].join('\n')
      expect(texts).toMatch(/補足: 作品 w:\S+『ノルウェイの森』（村上[ 　]?春樹） を相対比較に追加しました/)
      expect(texts).toMatch(/補足: 相対比較の作品 w:\S+『ノルウェイの森』（村上[ 　]?春樹） に追加しました/)
      expect(texts).not.toContain('別の作品として足しました')
      const id = docsOf(fake, 'benchWorks')[0].fields.id.stringValue
      expect([benchWorkId('ノルウェイの森', '村上春樹'), benchWorkId('ノルウェイの森', author)]).toContain(id)
      // 作品名だけで指しても1つに決まる
      const byName = await core.callTool('novel_get_bench_analysis', { work: 'ノルウェイの森' }, { grant: a })
      expect(byName.isError).toBeUndefined()
    }
  })

  it('同じ【原稿】の回の札を同時に選ぶと、後の答えに補足が出る（同じチャットの2回目からの呼び出しでも害の無い文）', async () => {
    const n = novel(['本文。'])
    const round1 = addBenchWork(n.data, { name: '【原稿】星の庭（第1稿・1回目）', author: '私' })
    const { core, fake, a, b } = await accounts(round1.data)
    const name = '【原稿】星の庭（第1稿・2回目）'
    const send = (grant: typeof a, body: string, viewpoint = '00 読書ノート') =>
      core.callTool(
        'novel_add_bench_analysis',
        { work: name, new_work: { name, author: '私' }, items: [{ viewpoint, body_markdown: body, run_date: '2026-10-29' }] },
        { grant },
      )
    const [ra, rb] = await Promise.all([send(a, 'Aのノート'), send(b, 'Bのノート')])
    expect(docsOf(fake, 'benchWorks')).toHaveLength(2)
    const note =
      '補足: 同じ札の回がもうあったため、その回に足しました。このチャットで作った回なら、このままで構いません。別のチャット・アカウントで同時に始めた回なら、札（最後の括弧）を変えて送り直してください（この回に足した分析はそのまま残るので、作者に伝えてください）'
    const made = [ra, rb].find((r) => r.text.includes('を相対比較に追加しました'))!
    const joined = [ra, rb].find((r) => r !== made)!
    expect(made.text).not.toContain(note)
    const lines = joined.text.split('\n')
    expect(lines.at(-3)).toMatch(/^補足: 相対比較の作品 w:\S+『【原稿】星の庭（第1稿・2回目）』（私） に追加しました$/)
    expect(lines.at(-2)).toBe(note)
    expect(joined.isError).toBeUndefined()
    // w:… で指した時・【原稿】でない作品・何も足さなかった時は出さない
    const ref = shortId('benchWork', benchWorkId(name, '私'))
    const byId = await core.callTool(
      'novel_add_bench_analysis',
      { work: ref, items: [{ viewpoint: '01 基本データ', body_markdown: 'x', run_date: '2026-10-29' }] },
      { grant: a },
    )
    expect(byId.text).not.toContain('同じ札の回')
    const again = await send(a, 'Aのノート')
    expect(again.text).toContain('相対比較の作品')
    expect(again.text).not.toContain('同じ札の回')
    await core.callTool('novel_add_bench_analysis', { work: '作品A', new_work: { name: '作品A', author: '山田' }, items: items('1') }, { grant: a })
    const plain = await core.callTool('novel_add_bench_analysis', { work: '作品A', new_work: { name: '作品A', author: '山田' }, items: items('2') }, { grant: b })
    expect(plain.text).toContain('相対比較の作品')
    expect(plain.text).not.toContain('同じ札の回')
  })
})

describe('作品批評の比べた作品（bench_works）が決まらない時', () => {
  it('同名の作品が2つあれば記録せずに候補の w:… を出し、w:… で送り直すと比べた作品つきで記録する', async () => {
    const n = novel(['本文。'])
    const x = addBenchWork(n.data, { name: '銀河の果て', author: '宮沢賢治' })
    const y = addBenchWork(x.data, { name: '銀河の果て', author: '田中' })
    const { core, fake, a, b } = await accounts(y.data)
    const input = { title_id: n.titleId, result_markdown: '## 『銀河の果て』と比べて\n…', run_date: '2026-10-29' }
    const amb = await core.callTool('novel_add_critique_result', { ...input, bench_works: ['銀河の果て'] }, { grant: b })
    expect(amb.isError).toBe(true)
    expect(amb.text).toContain(
      "- 場所が決まらない 作品批評の結果: bench_works の '銀河の果て' は、相対比較に同名の作品が2件あるため、どれか決まりません。w:… の短い id で指してください。この結果はまだ記録していません（直して送り直すと記録します）",
    )
    expect(amb.text).toContain(`    候補: ${shortId('benchWork', x.result)}『銀河の果て』（宮沢賢治）`)
    expect(amb.text).toContain(`    候補: ${shortId('benchWork', y.result)}『銀河の果て』（田中）`)
    expect(docsOf(fake, 'critiqueResults')).toHaveLength(0)
    const ok = await core.callTool('novel_add_critique_result', { ...input, bench_works: [shortId('benchWork', x.result)] }, { grant: b })
    expect(ok.isError).toBeUndefined()
    expect(ok.text).toContain('追加 1件')
    const list = await core.callTool('novel_get_critique', { title_id: n.titleId }, { grant: a })
    expect(list.text).toContain(`比べた作品: ${shortId('benchWork', x.result)}『銀河の果て』（宮沢賢治）`)
  })

  it('ほかのアカウントがまだ足していない作品は、記録せずに断る。作品が足された後に送り直すと記録する', async () => {
    const n = novel(['本文。'])
    const { core, fake, a, b } = await accounts(n.data)
    const input = { title_id: n.titleId, result_markdown: '## 比べて\n…', run_date: '2026-10-29', bench_works: ['銀河の果て'] }
    const early = await core.callTool('novel_add_critique_result', input, { grant: b })
    expect(early.isError).toBe(true)
    expect(early.text).toContain(
      "- 見つからない 作品批評の結果: bench_works の '銀河の果て' は相対比較に見つかりません。novel_list_bench_works で確かめた w:… の短い id で指すか、bench_works から外してください。",
    )
    expect(docsOf(fake, 'critiqueResults')).toHaveLength(0)
    await core.callTool(
      'novel_add_bench_analysis',
      { work: '銀河の果て', new_work: { name: '銀河の果て', author: '宮沢賢治' }, items: [{ viewpoint: '構成', body_markdown: 'x' }] },
      { grant: a },
    )
    const later = await core.callTool('novel_add_critique_result', input, { grant: b })
    expect(later.text).toContain('追加 1件')
    const list = await core.callTool('novel_get_critique', { title_id: n.titleId }, { grant: b })
    expect(list.text).toContain(`比べた作品: ${shortId('benchWork', benchWorkId('銀河の果て', '宮沢賢治'))}『銀河の果て』（宮沢賢治）`)
  })
})
