import { Link } from 'react-router-dom'
import { AppHeader } from './Layout'

/** 存在しないページ・削除済みのデータを開いた時の表示。action があれば、その画面へ移るボタンも出す */
export function NotFound({
  message = 'ページが見つかりません。削除された可能性があります。',
  action,
}: {
  message?: string
  action?: { to: string; label: string }
}) {
  return (
    <>
      <AppHeader />
      <main className="page page-narrow">
        <div className="empty stack" style={{ alignItems: 'center' }}>
          <p style={{ margin: 0 }}>{message}</p>
          {action ? (
            <Link to={action.to} className="btn btn-primary" data-testid="not-found-action">
              {action.label}
            </Link>
          ) : null}
          <Link to="/" className="btn">
            ホームへ戻る
          </Link>
        </div>
      </main>
    </>
  )
}
