// 「このアプリについて」（iPhone / Android のアプリだけ。Web 版の「ホーム画面に追加」の代わり）。
// 版・ビルドした日、iPhone はテスト版（TestFlight）の期限の目安と、更新のしかた。
import { useId, useState } from 'react'
import { appVersionLabel, buildTime, formatMonthDay, testFlightExpiry } from '../../platform/appInfo'
import type { NativePlatform } from '../../platform/platform'
import { formatDateTime } from '../../ui/browser'
import { NativeUpdateDialog } from '../../ui/NativeUpdateDialog'

export function AboutApp({ platform, now = Date.now() }: { platform: NativePlatform; now?: number }) {
  const id = useId()
  const [help, setHelp] = useState(false)
  const built = buildTime()
  const expiry = platform === 'ios' && built !== null ? testFlightExpiry(built, now) : null
  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="about-app">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>このアプリについて</h2>
      </div>
      <dl className="aset-storage-list">
        <div>
          <dt>版</dt>
          <dd data-testid="about-version">{appVersionLabel(platform)}</dd>
        </div>
        <div>
          <dt>ビルドした日</dt>
          <dd data-testid="about-built">{built === null ? '不明' : formatDateTime(built).slice(0, 10)}</dd>
        </div>
        {expiry ? (
          <div>
            <dt>テスト版の期限</dt>
            <dd data-testid="about-expiry">
              <span className={expiry.warn ? 'aset-warn' : undefined}>
                {formatMonthDay(expiry.expiresAt)}ごろ（あと{expiry.daysLeft}日）
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="aset-actions">
        <button type="button" className="btn btn-sm" onClick={() => setHelp(true)} data-testid="about-update-help">
          更新のしかた
        </button>
      </div>
      <p className="aset-note">
        {platform === 'ios'
          ? 'TestFlight のテスト版は、上げてから 90 日で使えなくなります。期限の前に Mac で新しい版を上げてください（docs/MOBILE.md）。'
          : 'Android のアプリは、パソコンから USB で入れ直して更新します（docs/MOBILE.md）。'}
        アプリを削除すると、この端末の中のデータは消えます。
      </p>
      {help ? <NativeUpdateDialog platform={platform} onClose={() => setHelp(false)} /> : null}
    </section>
  )
}
