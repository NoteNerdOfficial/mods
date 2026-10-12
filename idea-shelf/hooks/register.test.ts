import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'idea-shelf',
  props: {
    title: 'Idea shelf',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// A fake prompt box and store beneath the plugin.
const world = (on: On, opts: { inCmux?: boolean; launchFails?: boolean } = {}) => {
  const sent: { text: string; asUser?: true }[] = []
  const box = { text: '' }
  const store = new Map<string, unknown>()
  const launched: (readonly string[])[] = []
  let now = 1_000

  on('env.get', ($, e) => ({
    value: e.name === 'CMUX_WORKSPACE_ID' && opts.inCmux !== false ? 'workspace-1' : undefined,
  }))
  on('process.run', ($, e) => {
    launched.push(e.argv)
    const exitCode = opts.launchFails ? 1 : 0
    return {
      value: { exitCode, stdout: '', stderr: opts.launchFails ? 'socket not found' : '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  on('clock.now', () => ({ value: (now += 1) }))
  on('session.root', () => ({ value: '/projects/app' }))

  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    box.text = e.text
    return { isFilled: true, text: box.text, cursor: box.text.length }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })

  return { sent, box, store, launched }
}

const IDEA = {
  command: 'idea',
  args: 'try bun for tests',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'idea-shelf', surface: 'terminal', ...PANE })

test('shelving an idea keeps it on the shelf and sends nothing', async ($, on) => {
  const { sent } = world(on)
  const ui = await mount($)
  await ui.input({ key: 'new', text: 'add dark mode to settings' })

  const rows = await ui.findAll({ type: 'Text', text: /add dark mode to settings/ })
  expect(rows.length).toBeGreaterThan(0)
  expect(sent).toEqual([])
})

test('Send starts a new cmux session on the idea and leaves this one alone', async ($, on) => {
  const { sent, launched } = world(on)
  const ui = await mount($)
  await ui.input({ key: 'new', text: `refactor the "auth" module's $TOKEN` })
  const send = (await ui.findAll({})).find(el => el.key?.startsWith('send-'))
  await ui.press({ key: send!.key! })

  expect(sent).toEqual([])
  expect(launched).toHaveLength(1)
  const argv = launched[0]!
  expect(argv).toContain('new-workspace')
  expect(argv).toContain('/projects/app')
  expect(argv).toContain(`IDEA_SHELF_PROMPT=refactor the "auth" module's $TOKEN`)
  expect(argv.at(-1)).toBe('claude "$IDEA_SHELF_PROMPT"')
  expect((await ui.findAll({})).some(el => el.key?.startsWith('send-'))).toBe(false)
})

test('outside cmux, Send opens a Terminal window with the idea as an argument', async ($, on) => {
  const { launched } = world(on, { inCmux: false })
  const ui = await mount($)
  await ui.input({ key: 'new', text: 'try bun' })
  const send = (await ui.findAll({})).find(el => el.key?.startsWith('send-'))
  await ui.press({ key: send!.key! })

  expect(launched[0]![0]).toBe('osascript')
  expect(launched[0]!.slice(-2)).toEqual(['/projects/app', 'try bun'])
})

test('a failed launch keeps the idea on the shelf', async ($, on) => {
  world(on, { launchFails: true })
  const ui = await mount($)
  await ui.input({ key: 'new', text: 'keep me' })
  const send = (await ui.findAll({})).find(el => el.key?.startsWith('send-'))
  await ui.press({ key: send!.key! })

  expect(await ui.findAll({ type: 'Text', text: /keep me/ })).not.toHaveLength(0)
})

test('Edit puts the idea in the prompt box without sending', async ($, on) => {
  const { sent, box } = world(on)
  const ui = await mount($)
  await ui.input({ key: 'new', text: 'write a changelog' })
  const edit = (await ui.findAll({})).find(el => el.key?.startsWith('edit-'))
  await ui.press({ key: edit!.key! })

  expect(box.text).toBe('write a changelog')
  expect(sent).toEqual([])
})

test('the shelf is saved per project', async ($, on) => {
  const { store } = world(on)
  await $.command.run(IDEA)

  expect(store.get('ideas:/projects/app')).toMatchObject([{ text: 'try bun for tests' }])
})

test('/idea shelves from the prompt without a model turn', async ($, on) => {
  const { sent } = world(on)
  const out = await $.command.run(IDEA)

  expect(out.text).toBe('Shelved. 1 on the shelf.')
  expect(sent).toEqual([])
})
