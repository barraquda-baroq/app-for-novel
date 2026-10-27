// 「ホーム画面に追加（アプリとして使う）」の案内。ブラウザがインストールを提案してきたら「インストール」ボタンを出す。
import { useEffect, useId, useMemo, useState } from 'react'
import { useMediaQuery } from '../../ui/hooks'
import { notify } from '../../store/uiStore'
import { CheckIcon, DownloadIcon } from '../../ui/icons'
import { detectPlatform, type Platform } from './settingsLogic'

/** Chrome / Edge 等が発行する beforeinstallprompt（標準の型定義にはない） */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const GUIDES: { platform: Platform; title: string; steps: string[] }[] = [
  {
    platform: 'ios',
    title: 'iPhone・iPad（Safari）',
    steps: ['画面下（iPad は右上）の共有ボタン（□に↑）をタップ', '「ホーム画面に追加」を選び、「追加」をタップ'],
  },
  {
    platform: 'android',
    title: 'Android（Chrome）',
    steps: ['右上のメニュー（⋮）をタップ', '「アプリをインストール」または「ホーム画面に追加」を選ぶ'],
  },
  {
    platform: 'desktop',
    title: 'パソコン（Chrome・Edge）',
    steps: [
      'アドレスバーの右端に出るインストールのアイコンをクリック',
      'または、メニューから「アプリをインストール」（Edge は「アプリ」→「このサイトをアプリとしてインストール」）',
    ],
  },
]

function useStandalone(): boolean {
  const displayStandalone = useMediaQuery('(display-mode: standalone)')
  const iosStandalone = typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true
  return displayStandalone || iosStandalone
}

export function InstallHelp() {
  const id = useId()
  const standalone = useStandalone()
  const platform = useMemo(
    () => (typeof navigator === 'undefined' ? 'desktop' : detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)),
    [],
  )
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setPrompt(null)
      setInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = async () => {
    if (!prompt) return
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') notify('インストールしました')
    } catch {
      /* ブラウザが表示を拒否した */
    }
    // 同じイベントは一度しか使えない
    setPrompt(null)
  }

  // 現在の端末の案内を先頭に
  const guides = [...GUIDES].sort((a, b) => Number(b.platform === platform) - Number(a.platform === platform))

  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="install-help">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>ホーム画面に追加（アプリとして使う）</h2>
        <p className="aset-card-lead">
          ホーム画面やデスクトップに追加すると、アプリのように全画面で起動でき、一度開いたあとはオフラインでも使えます。
        </p>
      </div>

      {standalone || installed ? (
        <p className="aset-status is-ok" data-testid="install-status">
          <CheckIcon />
          {standalone ? 'いまアプリとして起動しています。' : 'インストールしました。ホーム画面やアプリ一覧から起動できます。'}
        </p>
      ) : null}

      {prompt ? (
        <div className="aset-install-cta">
          <button type="button" className="btn btn-primary" onClick={() => void install()} data-testid="install-button">
            <DownloadIcon />
            インストール
          </button>
          <span className="small muted">このブラウザでは、ボタンからそのままインストールできます。</span>
        </div>
      ) : null}

      <ul className="aset-guides">
        {guides.map((g) => (
          <li key={g.platform} className={`aset-guide${g.platform === platform ? ' is-current' : ''}`} data-testid={`install-guide-${g.platform}`}>
            <div className="aset-guide-head">
              <strong>{g.title}</strong>
              {g.platform === platform ? <span className="badge badge-accent">お使いの端末</span> : null}
            </div>
            <ol className="aset-guide-steps">
              {g.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </li>
        ))}
      </ul>

      <p className="aset-note">
        ホーム画面に追加しても、データはその端末のブラウザの中に保存されます。iPhone・iPad では Safari とホーム画面のアプリでデータが別々になることがあるので、移すときはバックアップの書き出し・復元を使ってください。
      </p>
    </section>
  )
}
