// アプリの版（package.json の version の x.y。src/platform/version.test.ts で揃っていることを確かめる）。
// 画面（「このアプリについて」など）からも読むので、Firebase を読み込まない小さなファイルに分けている（appModel.ts は Firestore を使う）。

/** 記録に添えるアプリの版（古い版のアプリの画面で「どの版に更新すればよいか」を出すため） */
export const APP_VERSION = '2.5'
