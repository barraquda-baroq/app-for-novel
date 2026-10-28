// 文字列の指紋（同期の文書の hash・2.3 の内容から作る id に使う）。同期で同じ関数を使うアプリとコネクタ（Cloudflare Worker）で
// 同じ値になるように、外の物に頼らない純粋な関数にしておく（src/sync/codec.ts から再び公開している）。

/** 53 ビットの文字列ハッシュ（cyrb53）。36進数の文字列で返す */
export function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * 文字列の指紋（2つの種の cyrb53 と長さ。[0-9a-z.] だけ、最長 30 字ほど）。null は ''。
 * 同期の文書の hash（json の指紋）と同じもの。
 */
export function hashJson(json: string | null): string {
  if (json === null) return ''
  return `${cyrb53(json, 1)}.${cyrb53(json, 2)}.${json.length.toString(36)}`
}
