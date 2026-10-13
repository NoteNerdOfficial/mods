export type Ttl = '5m' | '1h'

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

// The main conversation's last real request, and the refreshes sent since it.
export type Chain = {
  // When that request was sent.
  at: number
  // When the cache was last read: the request, or the latest refresh.
  lastAt: number
  model: string
  promptTokens: number
  ttl: Ttl
  refreshes: number
  feeUsd: number
}

// Estimated at API list prices; on a subscription they stand for plan usage.
export type Totals = {
  refreshes: number
  spentUsd: number
  // Rewrites avoided: prompts that read a cache only the refreshes kept alive.
  savedUsd: number
  // Fees of refreshes no prompt came back for.
  wastedUsd: number
}

export type AllTime = Totals & { since: number }
