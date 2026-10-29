// アプリの更新のしかた（新しい版のアプリで保存されたデータがある時の「更新のしかた」）。
// Web 版はサービスワーカーで新しい版を読み込むが、アプリはアプリそのものを入れ直す（docs/MOBILE.md）。
import type { NativePlatform } from './platform'

export interface UpdateHelp {
  title: string
  /** 説明の段落 */
  lines: string[]
  /** 開くリンク（iPhone は TestFlight） */
  link?: { href: string; label: string }
}

/** アプリを削除すると、同期していない端末内のデータも消える */
const KEEP_APP = 'アプリは削除しないでください（削除すると、まだ同期していないこの端末のデータが消えます）。'

export function nativeUpdateHelp(platform: NativePlatform): UpdateHelp {
  if (platform === 'ios') {
    return {
      title: 'iPhone アプリの更新のしかた',
      lines: [
        '新しい版は TestFlight から入れます。TestFlight アプリを開いて、Novel Studio の「アップデート」を押してください（自動アップデートをオンにしていれば、しばらくすると入ります）。',
        'TestFlight に新しい版がまだ無い時は、Mac で新しい版を TestFlight に上げてください（docs/MOBILE.md「iPhone」の「更新」）。',
        KEEP_APP,
      ],
      link: { href: 'itms-beta://', label: 'TestFlight を開く' },
    }
  }
  return {
    title: 'Android アプリの更新のしかた',
    lines: [
      'スマホを USB でパソコンにつなぎ、パソコンのリポジトリで git pull と npm ci をしてから、npm run android:install を実行してください（docs/MOBILE.md「Android」の「更新」）。',
      '今のアプリの上に入れ直すので、データはそのまま残ります。',
      KEEP_APP,
    ],
  }
}
