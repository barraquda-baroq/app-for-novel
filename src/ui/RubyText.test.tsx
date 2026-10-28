import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRuby, type RubySegment } from '../domain/ruby'
import { NearViewportContext } from './nearViewport'
import { LazyRubySegments, LazyRubyText, RubyText } from './RubyText'

afterEach(cleanup)

describe('ルビ・傍点の表示', () => {
  it('ルビは ruby/rt、傍点は傍点のクラス。ほかの文字はそのまま', () => {
    const { container } = render(
      <div data-testid="box">
        <RubyText text={'彼は｜魔法使い《ウィザード》だった。\n東京《とうきょう》の《《大事》》な話'} />
      </div>,
    )
    const rubies = container.querySelectorAll('ruby')
    expect(rubies).toHaveLength(2)
    expect(rubies[0].firstChild?.textContent).toBe('魔法使い')
    expect(rubies[0].querySelector('rt')?.textContent).toBe('ウィザード')
    // ルビを表示できない環境のための括弧
    expect([...rubies[0].querySelectorAll('rp')].map((rp) => rp.textContent)).toEqual(['（', '）'])
    expect(rubies[1].querySelector('rt')?.textContent).toBe('とうきょう')
    const bouten = container.querySelectorAll('em.rb-bouten')
    expect(bouten).toHaveLength(1)
    expect(bouten[0].textContent).toBe('大事')
    // 記号（｜《》）は出さず、改行は残す
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/[｜《》]/)
    expect(text).toContain('だった。\n東京')
  })

  it('画面の近くに来るまでは親文字だけ（一覧の抜粋・通し読みの本文）。見張り役がなければすぐにルビ・傍点', async () => {
    let onNear: (() => void) | null = null
    const register = vi.fn((_el: Element, cb: () => void) => {
      onNear = cb
      return () => {}
    })
    function Excerpt({ segments }: { segments: RubySegment[] }) {
      const ref = useRef<HTMLSpanElement>(null)
      return (
        <span ref={ref} data-testid="excerpt">
          <LazyRubySegments segments={segments} watch={ref} />
        </span>
      )
    }
    function Body({ text, plain }: { text: string; plain?: string }) {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <div ref={ref} data-testid="body">
          <LazyRubyText text={text} plain={plain} watch={ref} />
        </div>
      )
    }
    const segments = parseRuby('彼は｜魔法使い《ウィザード》で《《夜》》だった')
    const body = '東京《とうきょう》の夜'
    const { getByTestId } = render(
      <NearViewportContext.Provider value={register}>
        <Excerpt segments={segments} />
        <Body text={body} plain="（覚えておいた本文）" />
      </NearViewportContext.Provider>,
    )
    expect(getByTestId('excerpt').innerHTML).toBe('彼は魔法使いで夜だった')
    // 遠くにある間は、渡した「記号と読みを除いた本文」をそのまま置く（その場で分け直さない）
    expect(getByTestId('body').textContent).toBe('（覚えておいた本文）')
    // 要素はコミットが終わってから（親の ref が付いてから）登録する
    await act(async () => {})
    expect(register.mock.calls.map(([el]) => el)).toEqual([getByTestId('excerpt'), getByTestId('body')])
    act(() => onNear!())
    expect(getByTestId('excerpt').querySelectorAll('ruby rt')).toHaveLength(0)
    expect(getByTestId('body').querySelector('rt')?.textContent).toBe('とうきょう')
    cleanup()

    // 見張り役がない所（記法のない抜粋も）はすぐに表示する
    const plain = render(<Excerpt segments={segments} />)
    expect(plain.getByTestId('excerpt').querySelector('rt')?.textContent).toBe('ウィザード')
    expect(plain.getByTestId('excerpt').querySelector('em.rb-bouten')?.textContent).toBe('夜')
  })

  it('記法のない本文は要素を作らずそのまま', () => {
    const { container } = render(
      <div>
        <RubyText text={'あいう《えお》\n｜《銀河》'} />
      </div>,
    )
    expect(container.querySelector('ruby, em')).toBeNull()
    expect(container.firstElementChild?.textContent).toBe('あいう《えお》\n《銀河》')
    const plain = render(
      <p>
        <RubyText text="ただの本文" />
      </p>,
    )
    expect(plain.container.querySelector('p')?.innerHTML).toBe('ただの本文')
  })
})
