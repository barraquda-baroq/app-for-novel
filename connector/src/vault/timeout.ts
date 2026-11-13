// Google の API（Firestore・Firebase Auth のトークン）への要求を待つ上限。
// 答えの来ない要求で、書き込みの順番（core.ts の #mutex。すべての接続で1つ）を持ったまま止まらないように、1回の要求ごとに
// AbortSignal.timeout で待つのをやめ、要求も取り消す。待ち切った要求は試し直さない（firestore.ts・identity.ts。すぐに「つながらない」
// にする。試し直すと上限の何倍も待たせる）。
// 上限は 15 秒: ふだんの答え（50件のページ・100件の書き込み・トークンの更新）は1秒もかからないので、遅い時も十分に待てる。
// 1回のツールの呼び出しで上限まで待つのは、ふつう多くて2回（1分ごとの連携の記録の読み直しは、読めなくても前に読んだ内容で続けるので、
// その後の最初の要求でもう1回。書き込みが先に始まった取り込みを待った時は、その失敗を受け取る）で、約30秒と試し直しの待ち（1秒）で答える。
// ほかの接続の書き込みの後ろで待つ分（同じく約30秒）を足しても、約1分で Claude に答えが返り、書き込みの順番も空く。

/** 1回の要求を待つ上限（ms） */
export const REQUEST_TIMEOUT_MS = 15_000

/** 上限まで待っても答えが来なかった */
export class RequestTimeout extends Error {
  constructor(ms: number) {
    super(`${ms}ms 待っても答えがありませんでした`)
    this.name = 'RequestTimeout'
  }
}

/**
 * fetch に待つ上限を付ける（1回の要求ごと）。上限を過ぎると AbortSignal で要求を取り消し、RequestTimeout で失敗にする
 * （signal を見ない fetch（テストの差し替え）でも、待つのはやめる）
 */
export function withTimeout(f: typeof fetch, ms: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = AbortSignal.timeout(ms)
    return new Promise<Response>((resolve, reject) => {
      const stop = () => reject(new RequestTimeout(ms))
      signal.addEventListener('abort', stop, { once: true })
      let sent: Promise<Response>
      try {
        sent = f(input, { ...init, signal })
      } catch (e) {
        sent = Promise.reject(e)
      }
      sent.then(
        (res) => {
          signal.removeEventListener('abort', stop)
          resolve(res)
        },
        (e: unknown) => {
          signal.removeEventListener('abort', stop)
          reject(signal.aborted ? new RequestTimeout(ms) : e)
        },
      )
    })
  }) as typeof fetch
}
