// データの形の版（users/{uid}/meta/app）。新しい版のアプリが新しい形のデータ（2.2 の幕など）を書いた後に、
// それを知らない古い版のアプリがクラウドへ書いて壊さないように、クラウドに「このデータを書いたアプリの形の版」を記録する。
// - この版（DATA_MODEL）より低い・記録が無い: この版に上げる（下げることはない。アクセスルールでも下げられない）
// - この版より高い: 受け取りは続け、送るのは止める（この端末の変更は送信待ちに残す）。画面で「アプリを更新してください」と出す
// - 読めない・書けない（アクセスルールを公開する前など）: 止めずにそのまま同期する（記録が無いのと同じ扱い）
// 持ち主ごとの文書にする（データ users/{uid}/records と一緒に、持ち主を変えた時は新しい持ち主の版から始まる）。
import { doc, onSnapshot, runTransaction, serverTimestamp, type Firestore, type Unsubscribe } from 'firebase/firestore'

/**
 * このアプリが書くデータの形の版。2 = 2.2（幕）、3 = 2.3（推敲案・改稿案・戦略メモ・作品批評）。データの形を変えたら上げる。
 * Claude 用のコネクタも同じ値（CONNECTOR_MODEL）を持ち、違えば書き込まない（読むのは続ける）
 */
export const DATA_MODEL = 3
// 記録に添えるアプリの版（古い版のアプリの画面で「どの版に更新すればよいか」を出すため）
export { APP_VERSION } from './appVersion'

export interface AppModel {
  model: number
  appVersion: string
}

export const appModelRef = (fs: Firestore, uid: string) => doc(fs, 'users', uid, 'meta', 'app')

/**
 * ok = 送ってよい、newer = 新しい版のアプリで書かれたデータがある（送らない）、
 * unknown = サーバーと確かめられなくなった（オフラインになった。つながってサーバーから届くまで送らない）
 */
export type AppModelState = { state: 'ok' } | { state: 'unknown' } | { state: 'newer'; cloud: AppModel }

/** 記録の内容（形の版が読めなければ null） */
export const asModel = (data: unknown): AppModel | null => {
  const d = data as { model?: unknown; appVersion?: unknown } | undefined
  if (!d || typeof d.model !== 'number' || !Number.isFinite(d.model)) return null
  return { model: d.model, appVersion: typeof d.appVersion === 'string' ? d.appVersion : '' }
}

/**
 * データの形の版を見張る。サーバーから届いた内容だけを見る（端末の中の控えは古いことがある）。
 * 記録が無い・低ければ、この版に上げる（トランザクションで読み直してから）。
 * 端末の中の控えからの通知（オフラインになった時に届く）は unknown として知らせる: オフラインの間に新しい版のアプリが
 * 記録を上げていることがあるので、つながった後はサーバーから届くまで送らない（状態だけの変化も受け取るので、つながると
 * 内容が変わっていなくてもサーバーからの通知が届く）
 */
export function watchAppModel(fs: Firestore, uid: string, app: AppModel, onState: (s: AppModelState) => void): Unsubscribe {
  const ref = appModelRef(fs, uid)
  let raising = false
  const raise = async () => {
    if (raising) return
    raising = true
    try {
      await runTransaction(fs, async (tx) => {
        const snap = await tx.get(ref)
        const cur = snap.exists() ? asModel(snap.data()) : null
        if (cur && cur.model >= app.model) return
        tx.set(ref, { model: app.model, appVersion: app.appVersion, updatedAt: serverTimestamp() })
      })
    } catch (e) {
      // 書けなくても（アクセスルールを公開する前など）、同期は止めない
      console.warn('データの形の版を記録できませんでした', e)
    } finally {
      raising = false
    }
  }
  return onSnapshot(
    ref,
    // 状態だけの変化も受け取る（端末の中の控えからの通知の後、内容が同じでも「サーバーと揃った」通知を受け取れるように）
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.fromCache) {
        onState({ state: 'unknown' })
        return
      }
      const cur = snap.exists() ? asModel(snap.data()) : null
      if (cur && cur.model > app.model) {
        onState({ state: 'newer', cloud: cur })
        return
      }
      onState({ state: 'ok' })
      if (!cur || cur.model < app.model) void raise()
    },
    (err) => {
      // 読めなくても（アクセスルールを公開する前など）、同期は止めない
      console.warn('データの形の版を読めませんでした', err)
      onState({ state: 'ok' })
    },
  )
}
