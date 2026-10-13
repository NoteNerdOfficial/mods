import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, TurnUsage } from 'claude-code'

const OPUS = 'claude-opus-5-5'
const MINUTE = 60_000
// 90% of a 5-minute lifetime.
const DUE_5M = 270_000

const turnUsage = (cacheRead: number, cacheWrite: number): TurnUsage => ({
  model: OPUS,
  input_tokens: 0,
  output_tokens: 5,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

// A refresh of the 200k-token prompt that found it cached: (10*4 + 199,990*0.2 + 182*20) / 1e6 = $0.04.
const WARMED: ModelForkResult = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 10, output_tokens: 182, cache_read_input_tokens: 199_990, cache_creation_input_tokens: 0 },
}

// A refresh that found the cache gone and wrote it again.
const EXPIRED: ModelForkResult = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 10, output_tokens: 182, cache_read_input_tokens: 0, cache_creation_input_tokens: 199_990 },
}

// The engine beneath the mod: a clock, a store, the environment, forks and one-step turns.
const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, env)
  const forks: string[] = []
  const replies: ModelForkResult[] = []
  const statuses: (string | undefined)[] = []
  const usage = { next: turnUsage(199_000, 1000) }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: replies.shift() ?? WARMED }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage.next }
  })

  return { clock, forks, replies, statuses, usage }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

// One prompt of the main loop (or a subagent's turn, with agentId): one request, then the turn ends.
const prompt = async ($: Engine, turnId: string, agentId?: string) => {
  if (!agentId) await $.turn.start({ turnId, text: 'hi' })
  const ids = agentId ? { agentId } : {}
  for await (const _ of $.turn.step({ turnId, index: 0, model: OPUS, messageCount: 1, ...ids }));
  await $.turn.complete({ turnId, isAborted: false, reason: 'answer', answer: '', durationMs: 1000, ...ids })
}

const command = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'keep-warm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }))
    .text ?? ''

test('an idle 5m cache is refreshed at 90% of its lifetime, up to the idle limit', async ($, on) => {
  const { clock, forks, statuses } = world(on)
  await start($)
  await prompt($, 't1')
  expect(statuses.at(-1)).toContain('next refresh')

  await clock.advance(DUE_5M - 1)
  expect(forks).toHaveLength(0)
  await clock.advance(1)
  expect(forks).toHaveLength(1)
  expect(forks[0]).toContain('[keep-warm]')

  await clock.advance(2 * DUE_5M)
  expect(forks).toHaveLength(3)
  await clock.advance(60 * MINUTE)
  expect(forks).toHaveLength(3)
  expect(statuses.at(-1)).toContain('all 3 refreshes used')
})

test('auto takes the lifetime from CLAUDE_CODE_PROMPT_CACHE_TTL', async ($, on) => {
  const { clock, forks } = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await start($)
  await prompt($, 't1')
  await clock.advance(54 * MINUTE - 1)
  expect(forks).toHaveLength(0)
  await clock.advance(1)
  expect(forks).toHaveLength(1)
})

test('FORCE_PROMPT_CACHING_5M wins over a 1h lifetime', async ($, on) => {
  const { clock, forks } = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', FORCE_PROMPT_CACHING_5M: '1' })
  await start($)
  await prompt($, 't1')
  await clock.advance(DUE_5M)
  expect(forks).toHaveLength(1)
})

test('the ttl option overrides the environment', { options: { ttl: '1h' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await prompt($, 't1')
  await clock.advance(DUE_5M)
  expect(forks).toHaveLength(0)
  await clock.advance(54 * MINUTE)
  expect(forks).toHaveLength(1)
})

test('a context too small to pay for a refresh is left to expire', async ($, on) => {
  const { clock, forks, statuses, usage } = world(on)
  usage.next = turnUsage(19_000, 1000)
  await start($)
  await prompt($, 't1')
  await clock.advance(10 * MINUTE)
  expect(forks).toHaveLength(0)
  expect(statuses.at(-1)).toContain('too small')
})

test('a model with no price is never refreshed', async ($, on) => {
  const { clock, forks, statuses, usage } = world(on)
  usage.next = { ...turnUsage(199_000, 1000), model: 'claude-gateway/some-other-model' }
  await start($)
  await prompt($, 't1')
  await clock.advance(10 * MINUTE)
  expect(forks).toHaveLength(0)
  expect(statuses.at(-1)).toContain('no price')
})

test('a refresh that finds the cache expired stops warming and says why', async ($, on) => {
  const { clock, forks, replies, statuses } = world(on)
  replies.push(EXPIRED)
  await start($)
  await prompt($, 't1')
  await clock.advance(30 * MINUTE)
  expect(forks).toHaveLength(1)
  expect(statuses.at(-1)).toContain('already expired')
  expect(await command($, '')).toContain('1 refreshes, $1.00 spent, $0.00 saved, $1.00 wasted')
})

test('a prompt that reads a cache only the refreshes kept counts as saved', async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await prompt($, 't1')
  await clock.advance(6 * MINUTE)
  expect(forks).toHaveLength(1)
  await prompt($, 't2')
  // Saved: a 199k rewrite instead of a read, 199,000 * (4 * 1.25 - 0.2) / 1e6 = $0.96.
  const text = await command($, '')
  expect(text).toContain('This session: 1 refreshes, $0.04 spent, $0.96 saved, $0.00 wasted, net $0.91')
  expect(text).toContain('All time: 1 refreshes')
})

test('refreshes no prompt came back for are counted as wasted', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 't1')
  await clock.advance(DUE_5M)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  expect(await command($, '')).toContain('$0.04 spent, $0.00 saved, $0.04 wasted')
})

test('nothing is refreshed while a turn runs, for subagents, or while off', async ($, on) => {
  const { clock, forks } = world(on)
  await start($)

  await $.turn.start({ turnId: 't1', text: 'hi' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 1 }));
  await clock.advance(10 * MINUTE)
  expect(forks).toHaveLength(0)
  await $.turn.complete({ turnId: 't1', isAborted: false, reason: 'answer', answer: '', durationMs: 1000 })

  expect(await command($, 'off')).toBe('keep-warm is off for this session.')
  await prompt($, 't2')
  await clock.advance(10 * MINUTE)
  expect(forks).toHaveLength(0)

  await command($, 'on')
  await prompt($, 't3')
  await prompt($, 'sub', 'agent-1')
  await clock.advance(DUE_5M)
  expect(forks).toHaveLength(1)
})

test('an idle limit of 0 turns warming off', { options: { idleLimit: 0 } }, async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await prompt($, 't1')
  await clock.advance(10 * MINUTE)
  expect(forks).toHaveLength(0)
})
