// 画面の描画中に例外が起きても、アプリ全体が真っ白にならないようにする
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** これが変わったら（画面を移動したら）エラー表示を解除してもう一度描く */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('画面の表示中にエラーが起きました', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return <ErrorScreen message={this.state.error.message} />
  }
}

/** 画面を表示できなかった時の案内（ErrorBoundary と、ルーターの errorElement で使う） */
export function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="page page-narrow">
      <div className="card card-pad stack" role="alert">
        <h1 style={{ fontSize: 18 }}>この画面を表示できませんでした</h1>
        <p className="muted" style={{ margin: 0 }}>
          データの一部が読み取れない形になっている可能性があります。書いた内容は端末に保存されたままです。ホームに戻るか、再読み込みしてください。解決しない場合は、アプリの設定からバックアップを書き出してください。
        </p>
        <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {message}
        </pre>
        <div className="row">
          <a className="btn" href="#/">
            ホームへ
          </a>
          <a className="btn" href="#/settings">
            アプリの設定・バックアップ
          </a>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    </main>
  )
}
