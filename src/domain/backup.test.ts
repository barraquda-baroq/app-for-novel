// バックアップ（2.8）: アイデアへの追記の依頼は書き出さず・読み込まない。Claude が作ったアイデアの項目はそのまま往復する。
// ほかの表の書き出し・読み込みは entityOps.test.ts・claudeOps.test.ts、ゴミ箱へ移す依頼は claude/trashTargets.test.ts で確かめている。
import { describe, expect, it } from 'vitest'
import { hashJson } from './hash'
import { BACKUP_SCHEMA_VERSION, parseBackup, toBackup } from './backup'
import { addIdea, createTitle } from './entityOps'
import { emptyData, type AppData, type Idea, type IdeaAppend } from './types'

const BODY = '2026/11/12 14:32　第3章の動機\n・兄を探す'

function claudeIdea(titleId: string | null): Idea {
  return {
    id: 'cy-abc123.def',
    titleId,
    heading: '',
    body: BODY,
    checked: false,
    checkedAt: null,
    order: -1,
    source: 'claude',
    v: 1,
    model: 'claude-test',
    claudeHash: hashJson(BODY),
    appendIds: ['cu-old'],
    createdAt: 100,
    updatedAt: 200,
  }
}

const request: IdeaAppend = {
  id: 'cu-req1',
  ideaId: 'cy-abc123.def',
  text: '足す内容',
  readMark: 'abcd1234',
  source: 'claude',
  v: 1,
  createdAt: 300,
  updatedAt: 300,
}

function sample(): AppData {
  const t = createTitle(emptyData(), '灰の庭')
  const withAuthor = addIdea(t.data, t.result, '', '作者の案').data
  const idea = claudeIdea(t.result)
  return { ...withAuthor, ideas: { ...withAuthor.ideas, [idea.id]: idea }, ideaAppends: { [request.id]: request } }
}

describe('バックアップとアイデアへの追記の依頼（2.8）', () => {
  it('依頼は書き出さない（ゴミ箱へ移す依頼と同じ）。版は 4 のまま', () => {
    const data = sample()
    const file = toBackup(data)
    expect(BACKUP_SCHEMA_VERSION).toBe(4)
    expect(file.schemaVersion).toBe(4)
    expect('ideaAppends' in file.data).toBe(false)
    expect('trashRequests' in file.data).toBe(false)
    // 渡したデータは書き換えない
    expect(data.ideaAppends[request.id]).toEqual(request)
  })

  it('読み込むと依頼は空（手で書き足した依頼も読まない）。Claude が作ったアイデアの項目はそのまま戻る', () => {
    const data = sample()
    const file = toBackup(data)
    const back = parseBackup(JSON.stringify(file))
    expect(back.ideaAppends).toEqual({})
    expect(back.ideas['cy-abc123.def']).toEqual(data.ideas['cy-abc123.def'])
    expect(back.ideas).toEqual(data.ideas)
    const forged = parseBackup(JSON.stringify({ ...file, data: { ...file.data, ideaAppends: data.ideaAppends } }))
    expect(forged.ideaAppends).toEqual({})
    // 壊れた形の依頼の表があっても、読み飛ばすので読み込める
    const broken = parseBackup(JSON.stringify({ ...file, data: { ...file.data, ideaAppends: [1, 2] } }))
    expect(broken.ideaAppends).toEqual({})
  })

  it('依頼の表が無い古いバックアップ（2.7 まで）も読める', () => {
    const data = sample()
    const { ideaAppends: _drop, ...old } = toBackup(data).data as AppData & Record<string, unknown>
    void _drop
    const back = parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 4, exportedAt: '', data: old }))
    expect(back.ideaAppends).toEqual({})
    expect(Object.keys(back.ideas).sort()).toEqual(Object.keys(data.ideas).sort())
  })
})
