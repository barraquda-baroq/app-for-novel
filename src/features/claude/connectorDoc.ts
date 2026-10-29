// コネクタとの連携の記録（Firestore の config/connector）と、クラウドの持ち主（config/owner）を読み書きする。
// 持ち主だけが書ける（firestore.rules）。画面からは必要になった時に読み込む（ログインしていない端末で Firebase を読み込まない）。
import { deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { firebase } from '../../sync/firebase'
import { parseConnectorDoc, type ConnectorStatus, type ConnectorWrite } from './connectLogic'

const connectorRef = () => doc(firebase().firestore, 'config', 'connector')

/** クラウドの持ち主のアカウント（記録が無ければ null） */
export async function readOwnerUid(): Promise<string | null> {
  const snap = await getDoc(doc(firebase().firestore, 'config', 'owner'))
  const uid = snap.exists() ? (snap.data() as { uid?: unknown }).uid : null
  return typeof uid === 'string' && uid ? uid : null
}

export type ConnectorState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'paired'; status: ConnectorStatus }
  | { state: 'error'; message: string }

/**
 * 連携の記録を見張る（サーバーから届いた内容だけを出す。この端末で変えた内容も、サーバーが受け取るまでは出さない:
 * 「連携を解除」「書き込みを許可」が本当に効いたかを出すため）
 */
export function watchConnector(fn: (s: ConnectorState) => void): () => void {
  return onSnapshot(
    connectorRef(),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return
      if (!snap.exists()) return fn({ state: 'none' })
      const status = parseConnectorDoc(snap.data({ serverTimestamps: 'estimate' }))
      fn(status ? { state: 'paired', status } : { state: 'none' })
    },
    (err) => {
      const code = (err as { code?: string }).code
      fn({
        state: 'error',
        message:
          code === 'permission-denied'
            ? '連携の状態を読めませんでした（持ち主のアカウントでログインしているか、アクセスルールを公開したかを確かめてください）。'
            : '連携の状態を読めませんでした。',
      })
    },
  )
}

/** 連携を記録する（サーバーが受け取るまで待つ）。pairedAt はサーバー時刻 */
export async function writeConnector(d: ConnectorWrite): Promise<void> {
  await setDoc(connectorRef(), { ...d, pairedAt: serverTimestamp() })
}

/** 「書き込みを許可」を変える（連携の指紋・時刻はそのまま） */
export async function setConnectorWrites(writes: boolean): Promise<void> {
  await updateDoc(connectorRef(), { writes })
}

/** 連携を解除する（その場でコネクタは何も読み書きできなくなる） */
export async function deleteConnector(): Promise<void> {
  await deleteDoc(connectorRef())
}
