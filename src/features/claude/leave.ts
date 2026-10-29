// アプリの外（コネクタ）へページごと移る（テストで差し替えられるように分けておく）
export function leaveTo(url: string): void {
  window.location.assign(url)
}
