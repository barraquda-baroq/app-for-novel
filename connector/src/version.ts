// コネクタの版。CONNECTOR_MODEL はアプリのデータの形の版（src/sync/appModel.ts の DATA_MODEL）と同じ値にする。
// クラウドの users/{uid}/meta/app の model がこれと違えば、書き込まない（読むのは続ける）。
// 7 = 2.8（Claude のアイデア・アイデアへの追記の依頼・アイデアのゴミ箱へ移す依頼。2.8 のアプリが同期するまで書き込まない）
// 8 = 2.9（アイデアのフォルダ・アイデアの folderId・フォルダのゴミ箱。2.9 のアプリが同期するまで書き込まない）
export const CONNECTOR_VERSION = '2.9.0'
export const CONNECTOR_MODEL = 8
/** Firestore に書く記録の device（どの端末の ID とも重ならない。受け取った端末はほかの端末の変更として反映する） */
export const CONNECTOR_DEVICE = 'claude-connector'
