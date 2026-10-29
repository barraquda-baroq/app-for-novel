// アプリ（iPhone / Android）の「更新のしかた」。Web 版の「更新する」（サービスワーカー）の代わりに、アプリを入れ直す手順を出す。
import type { NativePlatform } from '../platform/platform'
import { nativeUpdateHelp } from '../platform/update'
import { Modal } from './Modal'

export function NativeUpdateDialog({ platform, onClose }: { platform: NativePlatform; onClose: () => void }) {
  const help = nativeUpdateHelp(platform)
  return (
    <Modal
      title={help.title}
      onClose={onClose}
      footer={
        <>
          {help.link ? (
            // iPhone のアプリの外の画面（TestFlight）はリンクで開く（アプリの外の URL は端末に渡される）
            <a className="btn btn-primary" href={help.link.href} data-testid="native-update-link">
              {help.link.label}
            </a>
          ) : null}
          <button type="button" className="btn" onClick={onClose} data-testid="native-update-close">
            閉じる
          </button>
        </>
      }
    >
      <div className="stack" data-testid="native-update-help">
        {help.lines.map((line) => (
          <p key={line} style={{ margin: 0 }}>
            {line}
          </p>
        ))}
      </div>
    </Modal>
  )
}
