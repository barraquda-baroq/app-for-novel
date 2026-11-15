// 設定の「書体のライセンス」: 同梱した数字の書体（Roboto Mono）の著作権の表示と、ダイアログで読むライセンスの全文
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FONT_CREDIT, FontLicense } from './FontLicense'

// 同梱した全文（?raw）は本物のまま。読み込めない時を試すために、読むと失敗するようにも切り替えられるようにする
const raw = vi.hoisted(() => ({ fail: false }))
vi.mock('../../fonts/roboto-mono/OFL.txt?raw', async (importOriginal) => {
  const original = await importOriginal<{ default: string }>()
  return {
    get default() {
      if (raw.fail) throw new Error('通信できない')
      return original.default
    },
  }
})

afterEach(() => {
  cleanup()
  raw.fail = false
})

describe('FontLicense', () => {
  it('カードに書体の名前・著作権・ライセンスの名前を出す', () => {
    render(<FontLicense />)
    expect(screen.getByRole('heading', { name: '書体のライセンス' })).toBeTruthy()
    expect(screen.getByTestId('font-credit').textContent).toBe(FONT_CREDIT)
    expect(FONT_CREDIT).toContain('Roboto Mono')
    expect(FONT_CREDIT).toContain('SIL Open Font License 1.1')
    // 全文は開くまで出さない
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「全文を見る」でライセンスの全文をダイアログに出し、「閉じる」で閉じる', async () => {
    render(<FontLicense />)
    await userEvent.click(screen.getByRole('button', { name: '全文を見る' }))
    const dialog = screen.getByRole('dialog', { name: 'Roboto Mono のライセンス' })
    expect(dialog).toBeTruthy()
    // 全文は開いた時に読み込む（読み込むまでは「読み込んでいます…」）
    await screen.findByText(/SIL OPEN FONT LICENSE Version 1\.1/)
    const text = screen.getByTestId('font-license-text').textContent ?? ''
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(text).toContain('Copyright 2015 The Roboto Mono Project Authors')
    // 下の「閉じる」（右上の × も同じ名前なので、下のボタンを押す）
    const close = screen.getByTestId('font-license-close')
    expect(close.textContent).toBe('閉じる')
    await userEvent.click(close)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('font-license-text')).toBeNull()
  })

  it('右上の × と Esc でも閉じる', async () => {
    render(<FontLicense />)
    await userEvent.click(screen.getByTestId('font-license-open'))
    await userEvent.click(screen.getByTestId('modal-close'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByTestId('font-license-open'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('全文は段落ごとに1行につなぎ、「-----」だけの行は出さない（段落の間の空行と見出しの行は残す）', async () => {
    render(<FontLicense />)
    await userEvent.click(screen.getByTestId('font-license-open'))
    await screen.findByText(/SIL OPEN FONT LICENSE Version 1\.1/)
    const lines = (screen.getByTestId('font-license-text').textContent ?? '').split('\n')
    expect(lines.some((l) => /^-+$/.test(l.trim()))).toBe(false)
    expect(lines).toContain(
      'The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.',
    )
    expect(lines).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    // 見出しは段落の始めでも次の行とつながない
    expect(lines).toContain('PREAMBLE')
    expect(lines).toContain('PERMISSION & CONDITIONS')
    // 段落の間は空行1つ
    expect(lines.indexOf('PREAMBLE')).toBeGreaterThan(0)
    expect(lines[lines.indexOf('PREAMBLE') - 1]).toBe('')
    expect(lines.some((l, i) => l === '' && lines[i + 1] === '')).toBe(false)
  })

  it('読み込めなかった時は知らせを出し（全文の所には出さない）、次に「全文を見る」を押すと読み込み直す', async () => {
    raw.fail = true
    render(<FontLicense />)
    await userEvent.click(screen.getByTestId('font-license-open'))
    const error = await screen.findByTestId('font-license-error')
    expect(error.textContent).toBe(
      'ライセンスの全文を読み込めませんでした。通信できる所で、ページを読み込み直してから開いてください。',
    )
    expect(screen.queryByTestId('font-license-text')).toBeNull()
    await userEvent.click(screen.getByTestId('font-license-close'))

    raw.fail = false
    await userEvent.click(screen.getByTestId('font-license-open'))
    await screen.findByText(/SIL OPEN FONT LICENSE Version 1\.1/)
    expect(screen.getByTestId('font-license-text').textContent).toContain('Copyright 2015 The Roboto Mono Project Authors')
    expect(screen.queryByTestId('font-license-error')).toBeNull()
  })

  it('開き直すと、読み込んだ全文をすぐに出す', async () => {
    render(<FontLicense />)
    await userEvent.click(screen.getByTestId('font-license-open'))
    await screen.findByText(/SIL OPEN FONT LICENSE Version 1\.1/)
    await userEvent.click(screen.getByTestId('font-license-close'))
    await userEvent.click(screen.getByTestId('font-license-open'))
    expect(screen.getByTestId('font-license-text').textContent).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })
})
