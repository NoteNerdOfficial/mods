import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AllTime, Chain, Totals, Ttl } from '../types'
import {
  DEFAULT_OUTPUT,
  TTL_MS,
  ZERO,
  addTotals,
  clockOf,
  costOf,
  dueAt,
  expectedSavingOf,
  formatTokens,
  formatUsd,
  isTtl,
  latestAt,
  missCostOf,
  promptTokensOf,
  usageOf,
} from './warm'

const ALL_TIME_KEY = 'allTime'
const FORK_PROMPT =
  '[keep-warm] Automated prompt cache refresh by the keep-warm mod, not a message from the person. Reply with the single word ok.'

type Options = { ttl: 'auto' | Ttl; idleLimit: number; minSavingUsd: number }

// The module's own state; a reload starts it over, which forgets the chain.
let chain: Chain | null = null
let timer: Timer | undefined
let isRunning = false
let isOn = true
let ttl: Ttl = '5m'
let outputTokens = DEFAULT_OUTPUT
let session: Totals = ZERO
// Each store update reads and rewrites the whole value, so they run one at a time.
let writes = Promise.resolve()

const show = ($: EngineInterface, text: string | undefined) => $.ui.status(text && `☕ keep-warm · ${text}`)

// With auto, the lifetime the session's own settings choose; 5m when nothing says,
// since a refresh that assumes 1h on a 5m cache pays a full rewrite.
const ttlOf = async ($: EngineInterface, option: Options['ttl']): Promise<Ttl> => {
  if (option !== 'auto') return option
  const forced = await $.env.get('FORCE_PROMPT_CACHING_5M')
  if (forced === '1' || forced === 'true') return '5m'
  const chosen = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  return isTtl(chosen) ? chosen : '5m'
}

const addToTotals = async ($: EngineInterface, delta: Partial<Totals>) => {
  session = addTotals(session, delta)
  writes = writes.then(async () => {
    try {
      const stored = (await $.store.get(ALL_TIME_KEY)) as AllTime | undefined
      const base = stored ?? { ...ZERO, since: await $.clock.now() }
      await $.store.set(ALL_TIME_KEY, addTotals(base, delta))
    } catch (error) {
      $.ui.log(`keep-warm could not save its totals: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  await writes
}

// No more refreshes until the next prompt; the chain stays so that prompt can judge it.
const halt = ($: EngineInterface, reason: string) => {
  timer?.cancel()
  timer = undefined
  show($, `stopped: ${reason}`)
}

// The chain is gone with no prompt to judge it, so its fees were wasted.
const forget = async ($: EngineInterface, reason: string) => {
  const gone = chain
  chain = null
  halt($, reason)
  if (gone && gone.feeUsd > 0) await addToTotals($, { wastedUsd: gone.feeUsd })
}

const schedule = async ($: EngineInterface, options: Options) => {
  timer?.cancel()
  timer = undefined
  const current = chain
  if (!current || isRunning || !isOn) return
  if (options.idleLimit === 0) return show($, undefined)
  if (current.refreshes >= options.idleLimit)
    return halt($, `all ${options.idleLimit} refreshes used, cache expires ${clockOf(current.lastAt + TTL_MS[current.ttl])}`)
  const saving = expectedSavingOf(current, outputTokens)
  if (saving === null) return halt($, `no price for ${current.model}`)
  if (saving < options.minSavingUsd) return halt($, `${formatTokens(current.promptTokens)} tokens is too small to be worth it`)
  const at = dueAt(current)
  timer = $.clock.after(Math.max(0, at - (await $.clock.now())), () => void refresh($, options))
  show($, `${current.ttl} · next refresh ${clockOf(at)} · ${current.refreshes}/${options.idleLimit} used`)
}

const refresh = async ($: EngineInterface, options: Options) => {
  timer = undefined
  const current = chain
  if (!current || isRunning || !isOn) return
  const at = await $.clock.now()
  // A timer this late (the computer slept, say) would pay a full write, not a read.
  if (at > latestAt(current)) return halt($, 'refresh came too late')
  show($, `refreshing ${formatTokens(current.promptTokens)} tokens…`)
  const reply = await $.model.fork({ prompt: FORK_PROMPT })
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') return halt($, 'nothing to refresh')
  const usage = usageOf(reply.usage)
  const fee = costOf(current.model, usage, current.ttl) ?? 0
  await addToTotals($, { refreshes: 1, spentUsd: fee })
  // A prompt, a stop or a reload replaced the chain while the fork ran.
  if (chain !== current) return addToTotals($, { wastedUsd: fee })
  if (usage.cacheRead < current.promptTokens / 2) {
    chain = { ...current, feeUsd: current.feeUsd + fee }
    return forget(
      $,
      reply.isAnswered ? `the cache had already expired; is the lifetime really ${current.ttl}?` : `refresh failed (${reply.reason})`,
    )
  }
  if (usage.output > 0) outputTokens = usage.output
  chain = { ...current, lastAt: at, refreshes: current.refreshes + 1, feeUsd: current.feeUsd + fee }
  await schedule($, options)
}

// A prompt that read a cache only the refreshes kept alive saved a rewrite;
// otherwise the refreshes since the last prompt were wasted.
const judge = async ($: EngineInterface, previous: Chain | null, at: number, cacheRead: number) => {
  if (!previous || previous.refreshes === 0) return
  const isKept = at - previous.at > TTL_MS[previous.ttl] && cacheRead >= previous.promptTokens / 2
  const saved = isKept ? missCostOf(previous.model, cacheRead, previous.ttl) : null
  if (saved !== null) await addToTotals($, { savedUsd: saved })
  else if (previous.feeUsd > 0) await addToTotals($, { wastedUsd: previous.feeUsd })
}

const line = (label: string, t: Totals) =>
  `${label}: ${t.refreshes} refreshes, ${formatUsd(t.spentUsd)} spent, ${formatUsd(t.savedUsd)} saved, ${formatUsd(t.wastedUsd)} wasted, net ${formatUsd(t.savedUsd - t.spentUsd)}`

const report = async ($: EngineInterface, options: Options) => {
  const allTime = (await $.store.get(ALL_TIME_KEY)) as AllTime | undefined
  return [
    `keep-warm is ${isOn ? 'on' : 'off'} · lifetime ${ttl} · up to ${options.idleLimit} idle refreshes · min saving ${formatUsd(options.minSavingUsd)}`,
    line('This session', session),
    line('All time', allTime ?? { ...ZERO, since: 0 }),
    'Estimated at API list prices; on a subscription they stand for plan usage, which Anthropic does not price.',
  ].join('\n')
}

export const register: Register = (on, raw) => {
  const options: Options = {
    ttl: raw.ttl === '5m' || raw.ttl === '1h' ? raw.ttl : 'auto',
    idleLimit: Math.min(10, Math.max(0, Math.round(Number(raw.idleLimit ?? 3)) || 0)),
    minSavingUsd: Math.max(0, Number(raw.minSavingUsd ?? 0.05) || 0),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keep-warm',
      description: 'Show what keep-warm has spent and saved, or turn it on or off for this session',
      argumentHint: '[on|off]',
    })
    ttl = await ttlOf($, options.ttl)
    return next(e)
  })

  on('command.run', { command: 'keep-warm' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      isOn = false
      halt($, 'off for this session')
      return { text: 'keep-warm is off for this session.' }
    }
    if (arg === 'on') {
      isOn = true
      await schedule($, options)
      return { text: 'keep-warm is on.' }
    }
    if (arg) return { text: 'Usage: /keep-warm [on|off]' }
    return { text: await report($, options) }
  })

  on('turn.start', async ($, e, next) => {
    isRunning = true
    timer?.cancel()
    timer = undefined
    show($, undefined)
    return next(e)
  })

  // Each main-loop request is a fresh read of the cache: it starts a new chain.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    if (!result.usage) return result
    const usage = usageOf(result.usage)
    await judge($, chain, at, usage.cacheRead)
    chain = { at, lastAt: at, model: result.usage.model, promptTokens: promptTokensOf(usage), ttl, refreshes: 0, feeUsd: 0 }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isRunning = false
      await schedule($, options)
    }
    return next(e)
  })

  // These lose the cache anyway, so warming it would buy nothing.
  on('session.compact', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId === undefined) await forget($, 'conversation compacted')
    return answer
  })
  on('session.end', async ($, e, next) => {
    await forget($, e.reason === 'clear' ? 'conversation cleared' : 'session ended')
    return next(e)
  })
  on('classic.PostModelSwitch', async ($, e, next) => {
    await forget($, 'model switched')
    return next(e)
  })
}
