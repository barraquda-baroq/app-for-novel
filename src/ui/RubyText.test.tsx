import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RubyText } from './RubyText'

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
    // ルビを表示できない環境・コピーのための括弧
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
