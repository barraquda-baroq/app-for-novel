import { Link } from 'react-router-dom'
import { AppHeader } from './Layout'

/** 存在しないページ・削除済みのデータを開いた時の表示 */
export function NotFound({ message = 'ページが見つかりません。削除された可能性があります。' }: { message?: string }) {
  return (
    <>
      <AppHeader />
      <main className="page page-narrow">
        <div className="empty stack" style={{ alignItems: 'center' }}>
          <p style={{ margin: 0 }}>{message}</p>
          <Link to="/" className="btn">
            ホームへ戻る
          </Link>
        </div>
      </main>
    </>
  )
}
