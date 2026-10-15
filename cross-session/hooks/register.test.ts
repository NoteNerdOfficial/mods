import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'cross-session',
  props: {
    title: 'Cross-session messages',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The engine beneath the plugin: sends reach a fake wire, the clock ticks.
const world = (on: On) => {
  const wire: { to: string; text: string }[] = []
  let now = 1_700_000_000_000
  on('clock.now', () => ({ value: (now += 1000) }))
  on('session.send', (_$, e) => {
    wire.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { wire }
}

const mount = ($: Engine) => $.ui.mount({ plugin: 'cross-session', surface: 'terminal', ...PANE })

const peer = (text: string) => ({ origin: { kind: 'peer' }, text }) as const

test('an outgoing message is logged and its secrets are redacted on the wire', async ($, on) => {
  const { wire } = world(on)
  await $.session.send({ to: 'worker', text: 'use sk-abcdefghijklmnopqrstuv please' })

  expect(wire[0]!.text).toBe('use [redacted] please')
  const ui = await mount($)
  expect(await ui.findAll({ type: 'Text', text: /→ worker.*1 redacted/ })).not.toHaveLength(0)
})

test('a key=value secret keeps its label', async ($, on) => {
  const { wire } = world(on)
  await $.session.send({ to: 'worker', text: 'password: hunter2 ok' })

  expect(wire[0]!.text).toBe('password: [redacted] ok')
})

test('an incoming peer message is logged and still delivered', async ($, on) => {
  world(on)
  const out = await $.session.receive(peer('tests pass'))
  const ui = await mount($)

  expect(out.consumed).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /← peer.*tests pass/ })).not.toHaveLength(0)
})

test('muting a peer consumes its later messages but keeps them in the log', async ($, on) => {
  world(on)
  await $.session.receive(peer('first'))
  const ui = await mount($)
  const row = (await ui.findAll({})).find(el => el.key?.startsWith('row-'))
  await ui.press({ key: row!.key! })
  const mute = (await ui.findAll({})).find(el => el.key?.startsWith('mute-'))
  await ui.press({ key: mute!.key! })

  const out = await $.session.receive(peer('second'))
  expect(out.consumed).toMatch(/muted/)
  expect(await ui.findAll({ type: 'Text', text: /second/ })).not.toHaveLength(0)
})

test('unmuting lets the peer through again', async ($, on) => {
  world(on)
  await $.session.receive(peer('first'))
  const ui = await mount($)
  await ui.press({ key: (await ui.findAll({})).find(el => el.key?.startsWith('row-'))!.key! })
  await ui.press({ key: (await ui.findAll({})).find(el => el.key?.startsWith('mute-'))!.key! })
  await ui.press({ key: 'unmute-peer' })

  expect((await $.session.receive(peer('third'))).consumed).toBeUndefined()
})

test('/cross-session-send sends and reports', async ($, on) => {
  const { wire } = world(on)
  const out = await $.command.run({
    command: 'cross-session-send',
    args: 'worker run the tests',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(wire).toEqual([{ to: 'worker', text: 'run the tests' }])
  expect(out.text).toBe('Sent to worker.')
})

test('/cross-session-send with no text shows usage', async ($, on) => {
  const { wire } = world(on)
  const out = await $.command.run({
    command: 'cross-session-send',
    args: 'worker',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(wire).toEqual([])
  expect(out.text).toMatch(/Usage/)
})
