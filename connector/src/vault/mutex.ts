// 1つずつ実行する（書き込みの重なりを防ぐ。Durable Object は1つのスレッドだが、await の間に別の呼び出しが入る）
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    this.#tail = next.catch(() => undefined)
    return next
  }
}
