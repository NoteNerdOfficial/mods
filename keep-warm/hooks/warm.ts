import type { ModelUsage } from 'claude-code'

import type { Chain, Totals, Ttl, Usage } from '../types'

export const PRICES_AS_OF = '2026-10-04'

type Price = { input: number; cacheRead: number; output: number }

// USD per million tokens at standard API rates, as of PRICES_AS_OF. A model not
// listed is never refreshed: without a price there is no saving to weigh.
const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, cacheRead: 0.25, output: 50 },
  'claude-fable-5': { input: 10, cacheRead: 1, output: 50 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, output: 10 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, output: 5 },
}

// A cache write costs this many times uncached input.
const WRITE = { '5m': 1.25, '1h': 2 } satisfies Record<Ttl, number>

export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 } satisfies Record<Ttl, number>

// The chance a prompt comes before an idle cache expires: cache-warmer's figure, from Pi.
export const RETURN_CHANCE = 0.15
// A refresh's reply when none has been measured yet; Opus 5.5 answered in 182.
export const DEFAULT_OUTPUT = 200
// A refresh later than this before expiry would likely find the cache gone and pay a full write.
const MARGIN_MS = 15_000

export const ZERO: Totals = { refreshes: 0, spentUsd: 0, savedUsd: 0, wastedUsd: 0 }

export const isTtl = (value: unknown): value is Ttl => value === '5m' || value === '1h'

// Strips a gateway prefix, a context-size suffix and a date stamp.
const priceOf = (model: string): Price | undefined => {
  const id = model.replace(/^(?:claude-gateway|anthropic)\//, '').replace(/\[\d+[km]\]$/, '')
  return PRICES[id] ?? PRICES[id.replace(/-\d{8}$/, '')]
}

export const usageOf = (usage: ModelUsage): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})

export const promptTokensOf = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite

// Refresh at 90% of the lifetime.
export const dueAt = (chain: Chain) => chain.lastAt + TTL_MS[chain.ttl] * 0.9

export const latestAt = (chain: Chain) => chain.lastAt + TTL_MS[chain.ttl] - MARGIN_MS

export const costOf = (model: string, usage: Usage, ttl: Ttl): number | null => {
  const p = priceOf(model)
  if (!p) return null
  return (
    (usage.input * p.input + usage.cacheWrite * p.input * WRITE[ttl] + usage.cacheRead * p.cacheRead + usage.output * p.output) /
    1_000_000
  )
}

// What losing the cache adds to the next prompt: writing the prefix again instead of reading it.
export const missCostOf = (model: string, tokens: number, ttl: Ttl): number | null => {
  const p = priceOf(model)
  if (!p) return null
  return (tokens * (p.input * WRITE[ttl] - p.cacheRead)) / 1_000_000
}

// A refresh reads the prefix and writes a short reply.
export const refreshCostOf = (model: string, tokens: number, outputTokens: number): number | null => {
  const p = priceOf(model)
  if (!p) return null
  return (tokens * p.cacheRead + outputTokens * p.output) / 1_000_000
}

// The saving one more refresh is expected to make; null when the model has no price.
export const expectedSavingOf = (chain: Chain, outputTokens: number): number | null => {
  const miss = missCostOf(chain.model, chain.promptTokens, chain.ttl)
  const fee = refreshCostOf(chain.model, chain.promptTokens, outputTokens)
  if (miss === null || fee === null) return null
  return RETURN_CHANCE * miss - fee
}

export const addTotals = <T extends Totals>(base: T, delta: Partial<Totals>): T => ({
  ...base,
  refreshes: base.refreshes + (delta.refreshes ?? 0),
  spentUsd: base.spentUsd + (delta.spentUsd ?? 0),
  savedUsd: base.savedUsd + (delta.savedUsd ?? 0),
  wastedUsd: base.wastedUsd + (delta.wastedUsd ?? 0),
})

export const formatUsd = (usd: number) => `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(2)}`

export const formatTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
