// ビルドの時に埋め込む値（vite.config.ts の define）

/** Claude 用のコネクタの origin（https://novel-studio-connector.….workers.dev。未設定は空） */
declare const __CONNECTOR_ORIGIN__: string

/** ビルドした日時（ミリ秒。「このアプリについて」と、iPhone のテスト版（TestFlight）の期限の目安）。Web 版のビルドは null */
declare const __BUILD_TIME__: number | null
