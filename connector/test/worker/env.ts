// workerd のテストの env（cloudflare:test）の型 = コネクタの Env
import type { Env as ConnectorEnv } from '../../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends ConnectorEnv {}
  }
}

export {}
