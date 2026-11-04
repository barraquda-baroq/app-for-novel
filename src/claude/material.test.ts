import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../domain/benchOps'
import { addClaudeRecords, setTitleClaudeAccess } from '../domain/claudeOps'
import {
  addMaterial,
  addMaterialNote,
  deleteMaterial,
  deleteMaterialNote,
  MATERIAL_SECTIONS,
  updateMaterial,
} from '../domain/materialOps'
import { emptyTrash, listTrash, restoreTrashEntry } from '../domain/trash'
import type { AppData, MaterialNote } from '../domain/types'
import { decodeRecord, encodeRecord } from '../sync/codec'
import { novel } from '../test/claudeFixture'
import { derivedKindOf, materialId, materialNoteId } from './derivedId'
import {
  filterBySections,
  materialBiblio,
  materialLine,
  materialNotesText,
  materialRef,
  MATERIAL_SECTION_GUIDE,
  materialSectionLines,
  materialTagList,
  materialTagsLine,
  noteText,
  resolveMaterial,
  sectionNames,
} from './material'
import { materialNotesOf, materialSectionGroups } from './materialOrder'
import { previewPaste } from './paste'
import { DEFAULT_MATERIAL_SECTIONS, materialNotesPrompt } from './prompts'
import {
  buildBenchAnalysis,
  buildMaterialNotes,
  buildToolCall,
  RECORD_LIMITS,
  trashedIdsOf,
  trashedMaterialNamesOf,
  WRITE_TOOL_LABELS,
  WRITE_TOOLS,
  type BuildContext,
} from './records'
import { matchesId, shortId } from './refs'
import { claudeView } from './visibility'

const NOW = Date.UTC(2026, 10, 2, 3, 0)
const claude: BuildContext = { source: 'claude', now: NOW }
const paste: BuildContext = { source: 'paste', now: NOW }

function sample() {
  const n = novel(['冒頭の本文。', '二話の本文。'], { name: '星の庭' })
  const m = addMaterial(n.data, {
    name: '江戸の暮らし',
    author: '山田',
    publisher: '海出版',
    year: '2019',
    tags: ['歴史', '江戸'],
    pdfPlace: 'プロジェクト「資料」',
  })
  return { ...n, data: m.data, materialId: m.result }
}

const add = (data: AppData, records: Parameters<typeof addClaudeRecords>[1]) => addClaudeRecords(data, records).data

describe('資料の記録（novel_add_material_notes）', () => {
  it('資料を id・短い id・資料名で指し、項目ごとの記録を作る（同じ呼び出しの記録は送った順に1ずつずらした時刻）', () => {
    const n = sample()
    for (const material of [n.materialId, shortId('material', n.materialId), ' 江戸の暮らし ']) {
      const r = buildMaterialNotes(
        n.data,
        {
          material,
          items: [
            { section: '要約', body_markdown: '## 要約\n第1章 町の朝', run_date: '2026-11-01' },
            { section: '創作に役立つ知識', body_markdown: '- 木戸は夜四つに閉まる（第2章）' },
          ],
          model: 'claude-opus',
        },
        claude,
      )
      expect(r.ok).toBe(true)
      expect(r.items.map((i) => i.status)).toEqual(['created', 'created'])
      const recs = r.records.map((x) => x.record as MaterialNote)
      expect(r.records.map((x) => x.table)).toEqual(['materialNotes', 'materialNotes'])
      expect(recs.map((x) => [x.materialId, x.section, x.runDate, x.source, x.model, x.v, x.createdAt])).toEqual([
        [n.materialId, '要約', '2026-11-01', 'claude', 'claude-opus', 1, NOW],
        [n.materialId, '創作に役立つ知識', '2026-11-02', 'claude', 'claude-opus', 1, NOW + 1],
      ])
      expect(r.items[0].label).toBe('『江戸の暮らし』の「要約」')
      // id は内容から作る（資料・項目・日付・本文）
      expect(recs[0].id).toBe(
        materialNoteId({ materialId: n.materialId, section: '要約', runDate: '2026-11-01', body: '## 要約\n第1章 町の朝' }),
      )
      expect(derivedKindOf(recs[0].id)).toBe('materialNote')
      expect(matchesId('materialNote', shortId('materialNote', recs[0].id), recs[0].id)).toBe(true)
    }
    // 書き込みツールの1つとして呼べる
    expect(WRITE_TOOLS).toContain('novel_add_material_notes')
    expect(WRITE_TOOL_LABELS.novel_add_material_notes).toBe('資料に記録を追加')
    const viaTool = buildToolCall(
      n.data,
      { tool: 'novel_add_material_notes', input: { material: n.materialId, items: [{ section: '要約', body_markdown: 'x' }] } },
      claude,
    )
    expect(viaTool.records.map((x) => x.table)).toEqual(['materialNotes'])
  })

  it('コネクタの答え（notes）には、足す先の資料をいつも d:… で出す（既にある資料・何も足さなかった時も。貼り付けには出さない）', () => {
    const n = sample()
    const ref = `${shortId('material', n.materialId)}『江戸の暮らし』（山田）`
    const items = [{ section: '要約', body_markdown: '## 要約\n町の朝', run_date: '2026-11-01' }]
    for (const material of [n.materialId, shortId('material', n.materialId), '江戸の暮らし']) {
      const r = buildMaterialNotes(n.data, { material, items }, claude)
      expect(r.notes).toEqual([`資料 ${ref} に追加しました`])
    }
    // new_material を付けても、資料の棚にある資料に足した時は同じ
    const named = buildMaterialNotes(
      n.data,
      { material: '江戸の暮らし', new_material: { name: '江戸の暮らし', author: '山田' }, items },
      claude,
    )
    expect(named.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect(named.notes).toEqual([`資料 ${ref} に追加しました`])
    // 重複・形が違うだけで何も足さなかった
    const data = add(n.data, buildMaterialNotes(n.data, { material: n.materialId, items }, claude).records)
    const dup = buildMaterialNotes(
      data,
      { material: n.materialId, items: [...items, { section: '', body_markdown: 'x' }] },
      claude,
    )
    expect(dup.items.map((i) => i.status)).toEqual(['duplicate', 'invalid'])
    expect(dup.notes).toEqual([`資料 ${ref} には何も追加していません`])
    // 新しく作った資料は、作った1行だけ
    const made = buildMaterialNotes(
      n.data,
      { material: '刀剣図鑑', new_material: { name: '刀剣図鑑', author: '佐藤' }, items },
      claude,
    )
    expect(made.notes).toEqual([
      `資料 ${shortId('material', made.records[0].record.id)}『刀剣図鑑』（佐藤） を資料に追加しました`,
    ])
    // 資料の棚に無い資料で、記録を1つも作れなかった時は資料も作らない（d:… はまだ無いので出さない）
    const none = buildMaterialNotes(
      n.data,
      { material: '刀剣図鑑', new_material: { name: '刀剣図鑑', author: '佐藤' }, items: [{ section: '', body_markdown: 'x' }] },
      claude,
    )
    expect(none.records).toHaveLength(0)
    expect(none.notes).toEqual(['記録を1つも追加しなかったため、資料『刀剣図鑑』（佐藤）は資料の棚に追加していません'])
    // 貼り付けの確かめには出さない
    expect(buildMaterialNotes(n.data, { material: n.materialId, items }, paste).notes).toEqual([])
    expect(buildMaterialNotes(data, { material: n.materialId, items }, paste).notes).toEqual([])
  })

  it('同じ内容をもう一度送っても作らない（duplicate）。削除した記録は previously_deleted', () => {
    const n = sample()
    const input = {
      material: n.materialId,
      items: [{ section: '描写に使える部分', body_markdown: '長屋の朝の匂い', run_date: '2026-11-02' }],
    }
    const first = buildMaterialNotes(n.data, input, paste)
    const data = add(n.data, first.records)
    const again = buildMaterialNotes(data, input, paste)
    expect(again.items[0].status).toBe('duplicate')
    expect(again.records).toHaveLength(0)
    const id = first.records[0].record.id
    const gone = deleteMaterialNote(data, id)
    const after = buildMaterialNotes(gone, input, { ...paste, wasDeleted: trashedIdsOf(gone) })
    expect(after.items[0].status).toBe('previously_deleted')
    // 同じ呼び出しの中で同じ記録を2回送っても1つ
    const twice = buildMaterialNotes(n.data, { material: n.materialId, items: [input.items[0], input.items[0]] }, claude)
    expect(twice.items.map((i) => i.status)).toEqual(['created', 'duplicate'])
  })

  it('資料の棚に無い資料は new_material を付けた時だけ作る（記録を1つでも作る時だけ。資料が先）。同じ資料名・著者なら同じ資料', () => {
    const n = sample()
    const none = buildMaterialNotes(n.data, { material: '刀剣図鑑', items: [{ section: '要約', body_markdown: 'x' }] }, claude)
    expect(none.ok).toBe(false)
    expect(none.error).toContain('new_material')
    expect(none.error).toContain("資料 '刀剣図鑑' が見つかりません")
    expect(none.candidates?.[0]).toContain('『江戸の暮らし』')
    expect(
      buildMaterialNotes(n.data, { material: '', items: [{ section: '要約', body_markdown: 'x' }] }, claude).error,
    ).toContain('material がありません')
    const input = {
      material: '刀剣図鑑',
      new_material: {
        name: '刀剣図鑑',
        author: '佐藤',
        publisher: '山出版',
        year: '1980',
        pdf_place: 'プロジェクト「武器」',
      },
      items: [{ section: 'サンプルシーン', body_markdown: '場面: 刀鍛冶の朝\n\n炉の火が…' }],
    }
    const r = buildMaterialNotes(n.data, input, claude)
    expect(r.records.map((x) => x.table)).toEqual(['materials', 'materialNotes'])
    expect(r.records[0].record).toMatchObject({
      name: '刀剣図鑑',
      author: '佐藤',
      publisher: '山出版',
      year: '1980',
      pdfPlace: 'プロジェクト「武器」',
      note: '',
      order: 1,
      source: 'claude',
    })
    expect(r.records[0].record.id).toBe(materialId('刀剣図鑑', '佐藤'))
    expect(derivedKindOf(r.records[0].record.id)).toBe('material')
    expect(r.notes.join()).toContain(
      `資料 ${shortId('material', r.records[0].record.id)}『刀剣図鑑』（佐藤） を資料に追加しました`,
    )
    const data = add(n.data, r.records)
    expect(Object.keys(data.materials)).toHaveLength(2)
    expect((r.records[1].record as MaterialNote).materialId).toBe(r.records[0].record.id)
    // 任意の項目が空なら持たない。タグは作者が付けて管理する（new_material にタグ・分野が付いていても資料には入れない）
    const bare = buildMaterialNotes(
      n.data,
      {
        material: '',
        new_material: { name: '料理帖', author: '', year: ' ', tags: ['料理'], field: '料理' } as never,
        items: [{ section: '要約', body_markdown: 'x' }],
      },
      claude,
    )
    expect(bare.records[0].record).not.toHaveProperty('tags')
    expect(bare.records[0].record).not.toHaveProperty('field')
    expect(bare.records[0].record).not.toHaveProperty('year')
    expect(bare.records[0].record).not.toHaveProperty('publisher')
    expect(r.records[0].record).not.toHaveProperty('tags')
    // もう一度: 資料は作らず、記録は重複
    const again = buildMaterialNotes(data, input, claude)
    expect(again.records).toHaveLength(0)
    expect(again.items[0].status).toBe('duplicate')
    // 記録を作れない時は資料も作らない
    const bad = buildMaterialNotes(n.data, { ...input, items: [{ section: '', body_markdown: 'x' }] }, claude)
    expect(bad.records).toHaveLength(0)
    // 削除した資料は、ゴミ箱にある間は作り直さない
    const id = r.records[0].record.id
    const deleted = deleteMaterial(data, id)
    const back = buildMaterialNotes(deleted, input, {
      ...claude,
      wasDeleted: trashedIdsOf(deleted),
      trashedMaterialNamed: trashedMaterialNamesOf(deleted),
    })
    expect(back.ok).toBe(false)
    expect(back.error).toContain('資料『刀剣図鑑』は以前に削除されています（ゴミ箱にあります。')
    expect(back.records).toHaveLength(0)
    // ゴミ箱から完全に削除した後（削除の印だけが残る）は、別の id の新しい資料として作り直す
    const purged = emptyTrash(deleted)
    const marks = new Set([`materials:${id}`, `materialNotes:${r.records[1].record.id}`])
    const ctx: BuildContext = {
      ...claude,
      wasDeleted: (table, x) => marks.has(`${table}:${x}`),
      trashedMaterialNamed: trashedMaterialNamesOf(purged),
    }
    const remade = buildMaterialNotes(purged, input, ctx)
    expect(remade.records.map((x) => x.table)).toEqual(['materials', 'materialNotes'])
    const newId = remade.records[0].record.id
    expect(newId).toBe(materialId('刀剣図鑑', '佐藤', 2))
    expect(newId).not.toBe(id)
    expect((remade.records[1].record as MaterialNote).materialId).toBe(newId)
    expect(remade.notes.join()).toContain(`資料 ${shortId('material', newId)}『刀剣図鑑』（佐藤） を資料に追加しました`)
    // もう一度送っても、作り直した資料に足す
    const twice = buildMaterialNotes(addClaudeRecords(purged, remade.records).data, input, ctx)
    expect(twice.records).toHaveLength(0)
    expect(twice.items[0].status).toBe('duplicate')
    // 資料名を変えてからゴミ箱に入れた資料も、ゴミ箱にある間は元の資料名で作り直さない
    const renamed = deleteMaterial(updateMaterial(data, id, { name: '刀剣の図鑑' }), id)
    const refused = buildMaterialNotes(renamed, input, {
      ...claude,
      wasDeleted: trashedIdsOf(renamed),
      inTrash: trashedIdsOf(renamed),
      trashedMaterialNamed: trashedMaterialNamesOf(renamed),
    })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('資料『刀剣図鑑』は以前に削除されています（ゴミ箱にあります。')
  })

  it('手で足して削除した資料（ゴミ箱に同じ資料名）は new_material で作り直さない。ゴミ箱から戻せばその資料に足す', () => {
    const n = sample()
    const hand = addMaterial(n.data, { name: '薬草事典', author: '山田' })
    const withNote = addMaterialNote(hand.data, hand.result, { section: '要約', body: '薬草の章', runDate: '2026-10-01' }).data
    const deleted = deleteMaterial(withNote, hand.result)
    const input = {
      material: '薬草事典',
      new_material: { name: '薬草事典', author: '山田' },
      items: [{ section: '創作に役立つ知識', body_markdown: '- 毒草の見分け方', run_date: '2026-11-02' }],
    }
    const ctxOf = (data: AppData, base: BuildContext): BuildContext => ({
      ...base,
      wasDeleted: trashedIdsOf(data),
      trashedMaterialNamed: trashedMaterialNamesOf(data),
    })
    for (const base of [claude, paste]) {
      const r = buildMaterialNotes(deleted, input, ctxOf(deleted, base))
      expect(r.ok).toBe(false)
      expect(r.error).toBe(
        '資料『薬草事典』は以前に削除されています（ゴミ箱にあります。前の記録ごと使う時は、アプリのゴミ箱から戻してください。新しく作り直す時は、アプリのゴミ箱から完全に削除してから、もう一度送ってください）',
      )
      expect(r.records).toHaveLength(0)
    }
    // 前後の空白・全角と半角の違いがあっても同じ資料名。相対比較の作品のゴミ箱とは関わらない
    expect(trashedMaterialNamesOf(deleted)(' 薬草事典 ')).toBe(true)
    expect(trashedMaterialNamesOf(deleted)('江戸の暮らし')).toBe(false)
    // 貼り付け（タイトルの画面）でも同じ
    const text = `\`\`\`novel-studio-v1\n${JSON.stringify({ tool: 'novel_add_material_notes', input })}\n\`\`\``
    const p = previewPaste(deleted, text, { titleId: n.titleId, now: NOW })
    expect(p.ok && p.created).toBe(0)
    expect(p.ok && p.calls[0].result.error).toContain('以前に削除されています')
    // ゴミ箱から戻せば、その資料（手で足した id）に足す
    const entry = listTrash(deleted.trashEntries).find((e) => e.kind === 'material')!
    const restored = restoreTrashEntry(deleted, entry.id).data
    const back = buildMaterialNotes(restored, input, ctxOf(restored, claude))
    expect(back.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect((back.records[0].record as MaterialNote).materialId).toBe(hand.result)
    expect(Object.values(restored.materials).filter((m) => m.name === '薬草事典')).toHaveLength(1)
  })

  it('資料名は全角と半角・全角の空白・続く空白の違いを問わない（タイトル名で指す時と同じ）。同じ資料を2つ作らない', () => {
    const n = sample()
    const up = addMaterial(n.data, { name: '江戸の暮らし　上', author: '山田' })
    const sf = addMaterial(up.data, { name: 'ＮＨＫ歴史読本', author: '' })
    const data = sf.data
    for (const [ref, id] of [
      ['江戸の暮らし 上', up.result],
      ['江戸の暮らし  上', up.result],
      ['NHK歴史読本', sf.result],
      [' ＮＨＫ歴史読本 ', sf.result],
    ] as const) {
      const r = resolveMaterial(data, ref)
      expect(r.ok && r.value.id).toBe(id)
    }
    // new_material を付けても、棚の資料に足す（資料は作らない）。資料名はそのまま
    const r = buildMaterialNotes(
      data,
      {
        material: '江戸の暮らし 上',
        new_material: { name: '江戸の暮らし 上', author: '山田' },
        items: [{ section: '要約', body_markdown: '上巻', run_date: '2026-11-02' }],
      },
      claude,
    )
    expect(r.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect((r.records[0].record as MaterialNote).materialId).toBe(up.result)
    expect(data.materials[up.result].name).toBe('江戸の暮らし　上')
    const s2 = buildMaterialNotes(
      data,
      {
        material: 'NHK歴史読本',
        new_material: { name: 'NHK歴史読本', author: '' },
        items: [{ section: '要約', body_markdown: 'x' }],
      },
      paste,
    )
    expect(s2.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect((s2.records[0].record as MaterialNote).materialId).toBe(sf.result)
    // Claude が作る資料の id も同じ比べ方（全角と半角・続く空白の違いは同じ id）。著者が違えば別の id
    expect(materialId('ＮＨＫ歴史読本', '')).toBe(materialId('NHK歴史読本', ''))
    expect(materialId('江戸の暮らし　上', '山田')).toBe(materialId('江戸の暮らし  上 ', ' 山田'))
    expect(materialId('江戸の暮らし', '山田')).not.toBe(materialId('江戸の暮らし', '佐藤'))
    // ゴミ箱の資料名も同じ比べ方
    const gone = deleteMaterial(data, sf.result)
    expect(trashedMaterialNamesOf(gone)('NHK歴史読本')).toBe(true)
    const again = buildMaterialNotes(
      gone,
      {
        material: 'NHK歴史読本',
        new_material: { name: 'NHK歴史読本', author: '' },
        items: [{ section: '要約', body_markdown: 'x' }],
      },
      { ...claude, wasDeleted: trashedIdsOf(gone), trashedMaterialNamed: trashedMaterialNamesOf(gone) },
    )
    expect(again.ok).toBe(false)
    expect(again.error).toContain('以前に削除されています')
  })

  it('new_material の著者が資料名で見つけた資料の著者と違えば、同じ資料名の別の資料として作る（短い id で指した時はその資料に足す）', () => {
    const n = sample()
    const sato = addMaterial(n.data, { name: '海', author: '佐藤' })
    const items = [{ section: '要約', body_markdown: '田中の『海』の要約', run_date: '2026-11-02' }]
    const tanaka = { material: '海', new_material: { name: '海', author: '田中' }, items }
    const r = buildMaterialNotes(sato.data, tanaka, claude)
    expect(r.ok).toBe(true)
    expect(r.records.map((x) => x.table)).toEqual(['materials', 'materialNotes'])
    expect(r.records[0].record).toMatchObject({ name: '海', author: '田中' })
    const note = r.records[1].record as MaterialNote
    expect(note.materialId).toBe(r.records[0].record.id)
    expect(note.materialId).not.toBe(sato.result)
    expect(r.notes.join('\n')).toContain(
      `著者の違う同名の資料 ${shortId('material', sato.result)}『海』（佐藤） があるため、別の資料として足しました`,
    )

    // 作った後: 同じ資料名・著者で呼べばその資料に足す。著者を付けずに資料名だけなら、短い id で指してもらう
    const both = add(sato.data, r.records)
    const more = buildMaterialNotes(
      both,
      { ...tanaka, items: [{ section: '描写に使える部分', body_markdown: '潮の匂い' }] },
      claude,
    )
    expect(more.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect((more.records[0].record as MaterialNote).materialId).toBe(note.materialId)
    const bare = buildMaterialNotes(both, { material: '海', items }, claude)
    expect(bare.ok).toBe(false)
    expect(bare.error).toContain('資料の棚に資料名「海」の資料が2件あります')
    expect(bare.candidates).toHaveLength(2)

    // 著者が同じ・new_material の著者が空・棚の資料の著者が空なら、棚の資料に足す
    for (const author of ['佐藤', ' 佐藤 ', '']) {
      const same = buildMaterialNotes(sato.data, { material: '海', new_material: { name: '海', author }, items }, claude)
      expect(same.records.map((x) => x.table)).toEqual(['materialNotes'])
      expect((same.records[0].record as MaterialNote).materialId).toBe(sato.result)
      expect(same.notes.join()).not.toContain('別の資料')
    }
    const noAuthor = addMaterial(n.data, { name: '海', author: '' })
    const filled = buildMaterialNotes(noAuthor.data, tanaka, claude)
    expect(filled.records.map((x) => x.table)).toEqual(['materialNotes'])
    expect((filled.records[0].record as MaterialNote).materialId).toBe(noAuthor.result)

    // 短い id・id で指した時は、著者が違ってもその資料に足し、違うことを知らせる
    for (const material of [shortId('material', sato.result), sato.result]) {
      const byId = buildMaterialNotes(sato.data, { ...tanaka, material }, claude)
      expect(byId.records.map((x) => x.table)).toEqual(['materialNotes'])
      expect((byId.records[0].record as MaterialNote).materialId).toBe(sato.result)
      expect(byId.notes.join()).toContain(
        `new_material の著者（田中）は、指した資料 ${shortId('material', sato.result)}『海』（佐藤） と違います（指した資料を使います）`,
      )
    }
  })

  it('同じ資料名が2つあれば短い id で指してもらう。入力の形・件数・項目の長さ・日付', () => {
    const n = sample()
    const twin = addMaterial(n.data, { name: '江戸の暮らし', author: '別人' }).data
    const amb = buildMaterialNotes(twin, { material: '江戸の暮らし', items: [{ section: '要約', body_markdown: 'x' }] }, claude)
    expect(amb.ok).toBe(false)
    expect(amb.error).toBe('資料の棚に資料名「江戸の暮らし」の資料が2件あります。d:… の短い id で指してください')
    expect(amb.candidates).toHaveLength(2)
    expect(buildMaterialNotes(n.data, { material: n.materialId, items: [] }, claude).error).toContain('items がありません')
    const many = Array.from({ length: 21 }, (_, i) => ({ section: `項目${i}`, body_markdown: 'x' }))
    expect(buildMaterialNotes(n.data, { material: n.materialId, items: many }, claude).error).toBe(
      'items が多すぎます（1回 20 件まで。項目ごとに分けて呼んでください）',
    )
    expect(
      buildMaterialNotes(
        n.data,
        { material: '', new_material: { name: '', author: '' }, items: [{ section: '要約', body_markdown: 'x' }] },
        claude,
      ).error,
    ).toBe('new_material.name が空です')
    expect(
      buildMaterialNotes(
        n.data,
        { material: '', new_material: 'x' as never, items: [{ section: '要約', body_markdown: 'x' }] },
        claude,
      ).error,
    ).toContain('new_material の形が違います')
    expect(
      buildMaterialNotes(
        n.data,
        {
          material: '',
          new_material: { name: '料理帖', author: '', year: '1'.repeat(21) },
          items: [{ section: '要約', body_markdown: 'x' }],
        },
        claude,
      ).error,
    ).toContain('new_material.year が長すぎます（20字まで')
    const r = buildMaterialNotes(
      n.data,
      {
        material: n.materialId,
        items: [
          { section: 'あ'.repeat(41), body_markdown: 'x' },
          { section: '要約', body_markdown: '' },
          'x' as never,
          { section: '要約', body_markdown: 'x', run_date: '11/02' },
        ],
      },
      claude,
    )
    expect(r.items.map((i) => i.status)).toEqual(['invalid', 'invalid', 'invalid', 'created'])
    expect(r.items[0].hint).toContain('40字まで')
    expect(r.items[2].hint).toBe('記録の形が違います')
    expect(r.notes.join()).toContain("日付 '11/02' は YYYY-MM-DD でないため")
    expect(RECORD_LIMITS.section).toBe(40)
    expect(RECORD_LIMITS.materialItems).toBe(20)
  })

  it('コネクタ: 1件が 200,000字を超える時は作らず、番号を付けて分けるよう返す（貼り付けはそのまま）', () => {
    const n = sample()
    const body = 'あ'.repeat(250_000)
    const input = { material: n.materialId, items: [{ section: '創作に役立つ知識', body_markdown: body }] }
    const r = buildMaterialNotes(n.data, input, claude)
    expect(r.items[0].status).toBe('invalid')
    expect(r.items[0].hint).toContain('資料の記録が大きすぎて1件の記録に入りません')
    expect(r.items[0].hint).toContain('body_markdown を2つ以上に分け')
    expect(r.items[0].hint).toContain('同じ section・run_date の別々の items')
    expect(r.items[0].hint).toContain('1行目の先頭に「（1/2）」')
    expect(r.items[0].hint).toContain('novel_add_material_notes を分けて呼ぶ')
    expect(buildMaterialNotes(n.data, input, paste).items[0].status).toBe('created')
    // 作った記録は同期の形にしてもそのまま読める
    const ok = buildMaterialNotes(n.data, { material: n.materialId, items: [{ section: '要約', body_markdown: '短い' }] }, claude)
    const rec = ok.records[0].record
    const enc = encodeRecord(rec as never)
    expect(enc.parts).toHaveLength(0)
    const doc = { table: 'materialNotes' as const, id: rec.id, json: enc.json, hash: enc.hash, chunks: 0, deleted: false }
    expect(decodeRecord({ ...doc, updated: null, device: 'claude-connector' }, () => undefined)).toEqual(rec)
  })

  it('相対比較の分析とは混ざらない（作品の指し方では資料を見つけない。資料の指し方では作品を見つけない）', () => {
    const n = sample()
    const w = addBenchWork(n.data, { name: '銀河の果て', author: '山田' })
    const bench = buildBenchAnalysis(w.data, { work: '江戸の暮らし', items: [{ viewpoint: '構成', body_markdown: 'x' }] }, claude)
    expect(bench.ok).toBe(false)
    const mat = buildMaterialNotes(w.data, { material: '銀河の果て', items: [{ section: '要約', body_markdown: 'x' }] }, claude)
    expect(mat.ok).toBe(false)
    expect(mat.candidates).toEqual([`${shortId('material', n.materialId)}『江戸の暮らし』（山田）`])
    // 短い id の文字も違う（作品は w:、資料は d:）
    expect(resolveMaterial(w.data, shortId('benchWork', w.result)).ok).toBe(false)
  })
})

describe('貼り付け（資料の画面）', () => {
  const answer = (material = 'd:dummy') =>
    [
      '記録しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_material_notes',
        input: {
          material,
          new_material: { name: '別の資料', author: 'x' },
          items: [
            { section: '要約', body_markdown: '## 要約\n…', run_date: '2026-11-02' },
            { section: 'サンプルシーン', body_markdown: '## サンプルシーン\n…', run_date: '2026-11-02' },
          ],
        },
      }),
      '```',
    ].join('\n')

  it('その資料の記録として受け付け（material・new_material は使わない）、2回貼り付けても増えない', () => {
    const n = sample()
    const p = previewPaste(n.data, answer(), { materialId: n.materialId, now: NOW, expect: ['novel_add_material_notes'] })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.created).toBe(2)
    expect(p.calls[0].label).toBe('資料に記録を追加')
    expect(p.records.every((r) => r.table === 'materialNotes' && (r.record as MaterialNote).materialId === n.materialId)).toBe(
      true,
    )
    expect(p.records.every((r) => (r.record as MaterialNote).source === 'paste')).toBe(true)
    const data = add(n.data, p.records)
    expect(Object.keys(data.materials)).toHaveLength(1)
    expect(Object.keys(data.materialNotes)).toHaveLength(2)
    const again = previewPaste(data, answer(), {
      materialId: n.materialId,
      now: NOW + 60_000,
      expect: ['novel_add_material_notes'],
    })
    expect(again.ok && again.created).toBe(0)
    expect(again.ok && again.calls[0].summary).toBe('重複 2件')
  })

  it('ほかのツールは受け付けない。タイトルの画面のツールは、タイトル無しでは貼り付けられない。資料が無ければ受け付けない', () => {
    const n = sample()
    const other = '```novel-studio-v1\n{"tool":"novel_add_revision_ideas","input":{"title_id":"x","items":[]}}\n```'
    const p = previewPaste(n.data, other, { materialId: n.materialId, now: NOW, expect: ['novel_add_material_notes'] })
    expect(p.ok).toBe(false)
    expect(!p.ok && p.error).toContain('ここでは「資料に記録を追加」だけを貼り付けられます')
    const q = previewPaste(n.data, other, { materialId: n.materialId, now: NOW })
    expect(q.ok && q.calls[0].result.error).toContain('タイトルの画面の「結果を貼り付け」で')
    expect(previewPaste(n.data, answer(), { materialId: 'gone', now: NOW })).toEqual({ ok: false, error: '資料が見つかりません' })
  })

  it('資料の画面でなければ JSON の material・new_material のとおり（一緒に作る資料は「追加」の数に入れない）', () => {
    const n = sample()
    const p = previewPaste(n.data, answer('別の資料'), { titleId: n.titleId, now: NOW })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.records.map((r) => r.table)).toEqual(['materials', 'materialNotes', 'materialNotes'])
    expect(p.records[0].record).toMatchObject({ name: '別の資料', author: 'x', source: 'paste' })
    expect(p.created).toBe(2)
    const data = add(n.data, p.records)
    expect(Object.values(data.materials).map((m) => m.name)).toEqual(['江戸の暮らし', '別の資料'])
  })
})

describe('並び・Claude に渡す形', () => {
  function noted() {
    const n = sample()
    let data = n.data
    const at = (section: string, body: string, runDate: string, createdAt: number) => {
      const r = addMaterialNote(data, n.materialId, { section, body, runDate })
      data = {
        ...r.data,
        materialNotes: { ...r.data.materialNotes, [r.result]: { ...r.data.materialNotes[r.result], createdAt } },
      }
      return r.result
    }
    at('年表', '年表・古い', '2026-10-01', 1)
    at('サンプルシーン', 'シーン・古い', '2026-10-01', 2)
    at('要約', '要約・古い', '2026-10-01', 3)
    at('人物', '人物', '2026-10-05', 4)
    at('サンプルシーン', 'シーン・新しい', '2026-10-20', 5)
    at(' 創作に役立つ知識', '（2/2）知識・後半', '2026-10-25', 7)
    at('創作に役立つ知識', '（1/2）知識・前半', '2026-10-25', 6)
    at('年表 ', '年表・新しい', '2026-10-25', 8)
    return { ...n, data }
  }

  it('項目ごとにまとめ、決まった4つの順の後にほかの項目を最初に記録した順、中は新しい日付から（分けたものは番号の順）', () => {
    const n = noted()
    const groups = materialSectionGroups(materialNotesOf(n.data, n.materialId))
    // 記録の無い「描写に使える部分」のまとまりは作らない
    expect(groups.map((g) => g.section)).toEqual(['要約', '創作に役立つ知識', 'サンプルシーン', '年表', '人物'])
    expect(groups[1].items.map((x) => x.body)).toEqual(['（1/2）知識・前半', '（2/2）知識・後半'])
    expect(groups[2].items.map((x) => x.body)).toEqual(['シーン・新しい', 'シーン・古い'])
    expect(groups[3].items.map((x) => x.body)).toEqual(['年表・新しい', '年表・古い'])
    expect(sectionNames(materialNotesOf(n.data, n.materialId))).toEqual(groups.map((g) => g.section))
    // 資料の記録は新しい日付から（分けたものは番号の順）
    expect(materialNotesOf(n.data, n.materialId).map((x) => x.body)).toEqual([
      '年表・新しい',
      '（1/2）知識・前半',
      '（2/2）知識・後半',
      'シーン・新しい',
      '人物',
      '要約・古い',
      'シーン・古い',
      '年表・古い',
    ])
    expect(MATERIAL_SECTIONS).toEqual(['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン'])
  })

  it('分けた番号は本文の1行目の先頭だけ（「**結論**：」の後ろも可）。行の途中の「（7/12）」では並べ替えない', () => {
    const n = sample()
    let data = n.data
    const at = (body: string, createdAt: number) => {
      const r = addMaterialNote(data, n.materialId, { section: '要約', body, runDate: '2026-10-25' })
      data = {
        ...r.data,
        materialNotes: { ...r.data.materialNotes, [r.result]: { ...r.data.materialNotes[r.result], createdAt } },
      }
    }
    at('**結論**：12章中（3/12）が町の話\n本文', 1)
    at('**結論**：12章中（7/12）が武家の話\n本文', 2)
    at('## （2/2）後半\n本文', 4)
    at('**要点**：（1/2）前半\n本文', 3)
    expect(materialNotesOf(data, n.materialId).map((x) => x.body.split('\n')[0])).toEqual([
      '**要点**：（1/2）前半',
      '## （2/2）後半',
      '**結論**：12章中（7/12）が武家の話',
      '**結論**：12章中（3/12）が町の話',
    ])
  })

  it('記録の文・1行の形・資料の指し方', () => {
    const n = noted()
    const material = n.data.materials[n.materialId]
    const ref = `${shortId('material', n.materialId)}『江戸の暮らし』（山田）`
    expect(materialRef(material)).toBe(ref)
    expect(materialRef({ id: n.materialId, name: ' ', author: '' })).toBe(`${shortId('material', n.materialId)}『無題の資料』`)
    // 書誌は著者・出版社・刊行年。作者が付けたタグは別の行（「タグ: 歴史・江戸」。無ければ出さない）
    expect(materialBiblio(material)).toBe('山田・海出版・2019')
    expect(materialTagsLine(material)).toBe('タグ: 歴史・江戸')
    expect(materialTagsLine({})).toBe('')
    expect(materialTagsLine({ tags: [' ', ' 現代 '] })).toBe('タグ: 現代')
    expect(materialTagList({ tags: ['ミリタリ', ' ', '戦闘'] })).toEqual(['ミリタリ', '戦闘'])
    const text = materialNotesText(n.data, material, ['創作に役立つ知識'])
    expect(text).toContain(`=== 資料 ${ref} ===\n山田・海出版・2019\nタグ: 歴史・江戸\n--- 項目「創作に役立つ知識」`)
    expect(text).toContain('--- 項目「創作に役立つ知識」（2件）---')
    expect(text).not.toContain('シーン・新しい')
    const all = materialNotesText(n.data, material)
    expect(all.indexOf('項目「要約」')).toBeLessThan(all.indexOf('項目「創作に役立つ知識」'))
    expect(all.indexOf('項目「サンプルシーン」')).toBeLessThan(all.indexOf('項目「年表」'))
    expect(all.indexOf('項目「年表」')).toBeLessThan(all.indexOf('項目「人物」'))
    expect(materialNotesText(n.data, material, ['描写に使える部分'])).toContain('（この項目の記録はまだありません）')
    const empty = sample()
    expect(materialNotesText(empty.data, empty.data.materials[empty.materialId])).toContain('（記録はまだありません）')
    const untagged = addMaterial(n.data, { name: '料理帖', author: '' })
    expect(materialNotesText(untagged.data, untagged.data.materials[untagged.result])).toBe(
      `=== 資料 ${shortId('material', untagged.result)}『料理帖』 ===\n（記録はまだありません）`,
    )
    // 1つの記録の見出し
    const note = materialNotesOf(n.data, n.materialId).find((x) => x.section === '要約')!
    expect(noteText(note)).toBe(`#### 要約（2026-10-01・手で記録）[${shortId('materialNote', note.id)}]\n要約・古い`)
    expect(noteText({ ...note, source: 'claude', model: 'claude-opus', body: ' ' })).toBe(
      `#### 要約（2026-10-01・Claude・claude-opus）[${shortId('materialNote', note.id)}]\n（本文なし）`,
    )
    expect(noteText({ ...note, source: 'paste' })).toContain('（2026-10-01・Claude（貼り付け））')
    // 一覧の1行（書誌・タグ・記録の数と字数・項目ごとの数と最新の日付・PDF の置き場所）
    expect(materialLine(n.data, material)).toBe(
      [
        `${ref} 山田・海出版・2019`,
        '  タグ: 歴史・江戸',
        '  記録 8件（51字）: 要約 1件（最新 2026-10-01）・創作に役立つ知識 2件（最新 2026-10-25）・サンプルシーン 2件（最新 2026-10-20）・年表 2件（最新 2026-10-25）・人物 1件（最新 2026-10-05）',
        '  PDF の置き場所: プロジェクト「資料」',
      ].join('\n'),
    )
    const plain = addMaterial(n.data, { name: '料理帖', author: '' })
    expect(materialLine(plain.data, plain.data.materials[plain.result])).toBe(
      `${shortId('material', plain.result)}『料理帖』\n  記録 0件`,
    )
    // 項目で絞る（前後の空白・正規化の違いは問わない。空なら絞らない）
    const notes = materialNotesOf(n.data, n.materialId)
    expect(filterBySections(notes, [' 年表']).map((x) => x.body)).toEqual(['年表・新しい', '年表・古い'])
    expect(filterBySections(notes, [])).toHaveLength(8)
    expect(resolveMaterial(n.data, 'なし')).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: "資料 'なし' が見つかりません",
    })
  })

  it('依頼文: 項目ごとの書き方・PDF の置き場所・コードブロック（本文・PDF は送らない）。既定は決まった4つ', () => {
    const n = sample()
    const material = n.data.materials[n.materialId]
    const p = materialNotesPrompt(material, ['要約', '年表'], '2026-11-02')
    expect(p).toContain('このプロジェクトのナレッジにある資料『江戸の暮らし』（山田）の PDF')
    expect(p).toContain('（PDF の置き場所: プロジェクト「資料」）')
    expect(p).toContain(`## 記録する項目\n- 要約: ${MATERIAL_SECTION_GUIDE['要約']}\n- 年表\n`)
    expect(p).toContain('```novel-studio-v1')
    expect(p).toContain(`"material":"${shortId('material', n.materialId)}"`)
    expect(p).toContain('"section":"要約"')
    expect(p).toContain('Novel Studio の資料の画面に貼り付けて')
    expect(p).toContain('run_date: 今日 2026-11-02')
    expect(p).not.toContain('相対比較')
    // タグは作者が付けて管理するので、依頼文には出さない（Claude に付けてもらわない）
    expect(p).not.toContain('タグ')
    expect(p).not.toContain('tags')
    expect(p).not.toContain('分野')
    // JSON の例は貼り付けでそのまま読める（資料の画面に貼り付けると、その資料の記録になる）
    const block = /```novel-studio-v1\n(.+)\n```/.exec(p)![1]
    expect(JSON.parse(block).tool).toBe('novel_add_material_notes')
    // JSON の例の改行は \\n が1つ（文字列の中の改行の書き方と同じ）
    expect(p).toContain('## 要約\\n…')
    expect(p).not.toContain('\\\\n')
    const pasted = previewPaste(n.data, p, { materialId: n.materialId, now: NOW, expect: ['novel_add_material_notes'] })
    expect(pasted.ok && pasted.records.map((r) => (r.record as MaterialNote).section)).toEqual(['要約', '年表'])
    // 既定は決まった4つ（それぞれの書き方を入れる）
    const d = materialNotesPrompt(material, [' '], '2026-11-02')
    expect(DEFAULT_MATERIAL_SECTIONS).toEqual(MATERIAL_SECTIONS)
    expect(d).toContain(materialSectionLines(MATERIAL_SECTIONS).join('\n'))
    for (const s of MATERIAL_SECTIONS) expect(d).toContain(`- ${s}: ${MATERIAL_SECTION_GUIDE[s]}`)
    expect(MATERIAL_SECTION_GUIDE['創作に役立つ知識']).toContain('すべて拾う')
    expect(MATERIAL_SECTION_GUIDE['描写に使える部分']).toContain('すべて拾う')
    expect(MATERIAL_SECTION_GUIDE['サンプルシーン']).toContain('仮想の場面を1つ立ち上げ')
    expect(d).toContain('「（1/2）」「（2/2）」')
    // 決まった項目の名前は、前後の空白・正規化の違いがあっても書き方を入れる
    expect(materialSectionLines([' 要約 '])).toEqual([`- 要約: ${MATERIAL_SECTION_GUIDE['要約']}`])
    // PDF の置き場所・著者が無ければ書かない
    const bare = materialNotesPrompt({ id: n.materialId, name: '料理帖', author: '', pdfPlace: '' }, [], '2026-11-02')
    expect(bare).toContain('資料『料理帖』の PDF')
    expect(bare).not.toContain('PDF の置き場所')
  })

  it('Claude に見せる内容: 資料とその記録はタイトルの設定と関係なく見せる', () => {
    const n = sample()
    let data = addMaterialNote(n.data, n.materialId, { section: '要約', body: 'x' }).data
    data = setTitleClaudeAccess(data, n.titleId, 'none')
    const view = claudeView(data)
    expect(Object.keys(view.titles)).toHaveLength(0)
    expect(view.materials).toBe(data.materials)
    expect(Object.keys(view.materials)).toEqual([n.materialId])
    expect(Object.keys(view.materialNotes)).toHaveLength(1)
    // タイトルが1つも無くても見せる
    const alone = addMaterial(
      {
        ...data,
        titles: {},
      },
      { name: '料理帖' },
    ).data
    expect(Object.keys(claudeView(alone).materials)).toHaveLength(2)
  })
})
