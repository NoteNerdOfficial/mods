import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement, TurnStepInput } from 'claude-code'

import { hintWraps, parsePick } from './router'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HARD = 'Untangle the race between the cache writer and the websocket reconnect logic'
const EASY = 'rename getUser to fetchUser in api.ts'
const REPLIES: Record<string, string> = {
  [HARD]: '{"model":"opus","effort":"high","reason":"concurrency debugging"}',
  [EASY]: '{"model":"haiku","effort":"low","reason":"mechanical rename"}',
}

// A fake prompt box, classifier and model API beneath the plugin.
const world = (on: On) => {
  const clock = mock.clock(on)
  mock.store(on)
  const box = { text: '' }
  const asked: string[] = []
  const steps: TurnStepInput[] = []

  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    return { isFilled: true, text: box.text, cursor: box.text.length }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('model.complete', ($, e) => {
    const text = /<prompt>\n([\s\S]*)\n<\/prompt>/.exec(e.prompt)?.[1] ?? ''
    asked.push(text)
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: REPLIES[text] ?? 'no idea', usage } }
  })
  on('turn.step', async function* ($, e) {
    steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  return { clock, box, asked, steps }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const type = ($: Engine, text: string) => $.prompt.fill({ text, mode: 'replace', origin: { kind: 'engine' } })

// One turn of the main loop: its start, then one request. Starts it and returns the
// stream's end, so a test can look at the band while a held request waits.
const startTurn = async ($: Engine, turnId: string, text: string, agentId?: string) => {
  await $.turn.start({ turnId, text })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const done = (async () => {
    for await (const _ of stream);
  })()
  return { done }
}

// A whole turn, the clock run past any hold.
const runTurn = async ($: Engine, clock: MockClock, turnId: string, text: string, agentId?: string) => {
  let isDone = false
  const done = (await startTurn($, turnId, text, agentId)).done.then(() => {
    isDone = true
  })
  for (let i = 0; i < 40 && !isDone; i++) await clock.advance(250)
  await done
}

test('the band recommends a model once typing pauses, and Use routes only the next prompt', async ($, on) => {
  const { clock, asked, steps } = world(on)
  await start($)
  await type($, HARD)
  const first = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...BAND })
  expect(await first.find({ key: 'use' })).toBeUndefined()
  await clock.advance(1_300)
  await first.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    // Retyping the same draft recalls the cached pick at once.
    await type($, '')
    await type($, HARD)
    const ui = await $.ui.mount({ plugin: 'model-router', surface, ...BAND })
    expect(await ui.find({ key: 'use' })).toBeDefined()
    await ui.press({ key: 'use' })
    expect(await ui.find({ key: 'undo' })).toBeDefined()
    await ui.unmount()
  }
  expect(asked).toEqual([HARD]) // cached: retyping asked nothing

  await runTurn($, clock, 't1', HARD)
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')
  expect(steps.at(-1)?.effort).toBe('high')

  // Recommend mode applies nothing unasked.
  await runTurn($, clock, 't2', HARD)
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
})

test('a pick that matches the current model says it fits instead of offering Use', async ($, on) => {
  const { clock } = world(on)
  REPLIES['write tests for the parser module'] = '{"model":"sonnet","effort":"medium","reason":"routine tests"}'
  await start($)
  await type($, 'write tests for the parser module')
  await clock.advance(1_300)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'use' })).toBeUndefined()
  expect(await ui.find({ key: 'auto' })).toBeUndefined()
})

test('auto mode routes every main-loop turn and leaves subagents alone', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await $.command.run({ command: 'model-router', args: 'auto', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  await runTurn($, clock, 'a1', EASY)
  expect(steps.at(-1)?.model).toBe('claude-haiku-5-5')
  expect(steps.at(-1)?.effort).toBe('low')

  await runTurn($, clock, 'a2', HARD)
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')

  // A continuation keeps the last turn's routing.
  await runTurn($, clock, 'a3', '')
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')

  await runTurn($, clock, 'a4', HARD, 'agent-1')
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
})

test('off mode neither classifies nor routes', async ($, on) => {
  const { clock, asked, steps } = world(on)
  await start($)
  await $.command.run({ command: 'model-router', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await type($, HARD)
  await clock.advance(1_300)
  await runTurn($, clock, 'o1', HARD)
  expect(asked).toEqual([])
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
})

test('an unreadable classifier reply falls back to Sonnet at medium effort', () => {
  expect(parsePick('x', 'I think opus maybe')).toEqual({ text: 'x', model: 'sonnet', effort: 'medium', reason: 'general task' })
  expect(parsePick('x', '```json\n{"model":"fable","effort":"xhigh","reason":"novel algorithm"}\n```').model).toBe('fable')
})

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'model-router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('Keep current dismisses the pick for this draft, and ↶ brings it back', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await type($, HARD)
  await clock.advance(1_300)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, ...BAND })
    await ui.press({ key: 'keep' })
    expect(await ui.find({ key: 'use' })).toBeUndefined()
    await ui.press({ key: 'unkeep' })
    expect(await ui.find({ key: 'use' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...BAND })
  await ui.press({ key: 'use' })
  await ui.press({ key: 'keep' }) // changing your mind after Use
  await runTurn($, clock, 'k1', HARD)
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
})

test('in auto mode the band shows the pick before sending, and Override keeps the current model', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, 'auto')
  await type($, HARD)
  await clock.advance(1_300)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, ...BAND })
    expect(JSON.stringify(await ui.drawn())).toContain('Opus 5.5 · high')
    await ui.press({ key: 'keep' })
    expect(JSON.stringify(await ui.drawn())).toContain('Keeping')
    await ui.press({ key: 'unkeep' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...BAND })
  await ui.press({ key: 'keep' })
  await runTurn($, clock, 'v1', HARD)
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')

  // The override was for that prompt only.
  await runTurn($, clock, 'v2', HARD)
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')
})

test('Exit auto is always in the band in auto mode, and /model-router alone toggles auto', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, '')
  for (const surface of ['terminal', 'desktop'] as const) {
    await command($, 'auto')
    const ui = await $.ui.mount({ plugin: 'model-router', surface, ...BAND })
    await ui.press({ key: 'exit-auto' })
    expect(await ui.find({ key: 'exit-auto' })).toBeUndefined()
    await ui.unmount()
  }
  await runTurn($, clock, 'x1', HARD)
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')

  await command($, '')
  await runTurn($, clock, 'x2', HARD)
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')
  await command($, '')
  await runTurn($, clock, 'x3', HARD)
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
})

const WORKING = { ...BAND, props: { ...BAND.props, isWorking: true } }

test('a prompt sent before its pick showed is held, and Override sends it on the current model', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, 'auto')
  for (const surface of ['terminal', 'desktop'] as const) {
    const turnId = `h-${surface}`
    const { done } = await startTurn($, turnId, HARD)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'model-router', surface, ...WORKING })
    expect(JSON.stringify(await ui.drawn())).toContain('Sending on')
    expect(steps.some(s => s.turnId === turnId)).toBe(false) // nothing sent while held
    await ui.press({ key: 'hold-override' })
    await clock.advance(250)
    await done
    expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(await ui.find({ key: 'hold-override' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a hold sends on the pick when it runs out, or at once on Send now', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, 'auto')

  const { done: timed } = await startTurn($, 'h1', HARD)
  await clock.advance(2_000)
  expect(steps.length).toBe(0)
  await clock.advance(1_250)
  await timed
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')

  const { done: pressed } = await startTurn($, 'h2', EASY)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...WORKING })
  await ui.press({ key: 'hold-now' })
  await clock.advance(250)
  await pressed
  expect(steps.at(-1)?.model).toBe('claude-haiku-5-5')
  expect(clock.now()).toBeLessThan(4_000)
})

test('no hold when the pick was on screen before sending', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, 'auto')
  await type($, HARD)
  await clock.advance(1_300)
  const { done } = await startTurn($, 'n1', HARD)
  await clock.settle()
  await done
  expect(steps.at(-1)?.model).toBe('claude-opus-5-5')
})

test('Exit auto during a hold sends that prompt on the current model and leaves auto', async ($, on) => {
  const { clock, steps } = world(on)
  await start($)
  await command($, 'auto')
  const { done } = await startTurn($, 'e1', HARD)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', ...WORKING })
  await ui.press({ key: 'exit-auto' })
  await clock.advance(250)
  await done
  expect(steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  expect(await ui.find({ key: 'exit-auto' })).toBeUndefined()
})

test('the hint is estimated to wrap only when it outgrows the room the keys leave', async () => {
  // 'Auto' takes 4 + 4 frame + 1 gap = 9 cells; 'Keeping x' lead takes 9 + 1.
  expect(hintWraps('a'.repeat(31), 40, ['Auto'])).toBe(false)
  expect(hintWraps('a'.repeat(32), 40, ['Auto'])).toBe(true)
  expect(hintWraps('a'.repeat(21), 40, ['Auto'], 'Keeping x')).toBe(false)
  expect(hintWraps('a'.repeat(22), 40, ['Auto'], 'Keeping x')).toBe(true)
})
