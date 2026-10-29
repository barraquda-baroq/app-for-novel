// 連携の状態のキャッシュ（Worker の中。10分）。トークンの更新（tokenExchangeCallback）のたびに Vault を呼ばないように。
// Vault に届かない時は「連携している」とみなす（一時的な失敗で接続を切らない）。
import type { Env } from '../env'
import { logError } from '../log'
import { vault } from '../vault/Vault'

const TTL = 10 * 60_000
let cache: { state: 'paired' | 'unpaired'; at: number } | null = null

export async function cachedPairingState(env: Env, now = Date.now()): Promise<'paired' | 'unpaired'> {
  if (cache && now - cache.at < TTL) return cache.state
  try {
    const state = await vault(env).pairingState()
    cache = { state, at: now }
    return state
  } catch (e) {
    logError('pairing_state_failed', e)
    return 'paired'
  }
}

/** 連携が解除されたと分かった時・連携した時に、キャッシュを入れ替える */
export function setPairingState(state: 'paired' | 'unpaired', now = Date.now()): void {
  cache = { state, at: now }
}

export function clearPairingCache(): void {
  cache = null
}
