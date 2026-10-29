// Windows・Mac（ファイル名の大文字・小文字を区別しない）でもビルドできること。
// 同じフォルダに Markdown.tsx と markdown.ts のような「大文字・小文字だけ違う名前」があると、
// import './Markdown' がどちらを指すかがパソコンで変わり、Mac の npm run build:native・Windows の npm run deploy が失敗する
import { describe, expect, it } from 'vitest'

// 読み込まずに名前だけ使う
const files = Object.keys(
  import.meta.glob([
    '/src/**/*.{ts,tsx,css}',
    '/e2e/**/*.ts',
    '/scripts/**/*.mjs',
    '/connector/src/**/*.ts',
    '/connector/scripts/**/*.mjs',
  ]),
)

const stem = (file: string) => file.replace(/\.(ts|tsx|mjs)$/, '')

describe('ファイル名', () => {
  it('大文字・小文字だけが違うモジュールが同じフォルダに無い', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('/src/features/claude/Markdown.tsx')
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const f of files) {
      const key = stem(f).toLowerCase()
      const other = seen.get(key)
      if (other && stem(other) !== stem(f)) clashes.push(`${other} と ${f}`)
      seen.set(key, f)
    }
    expect(clashes).toEqual([])
  })
})
