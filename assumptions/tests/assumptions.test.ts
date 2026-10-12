import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  title: 'Assumptions',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`logs, reviews and sends assumptions on ${surface}`, async ($, on) => {
    const sent: string[] = []
    on('prompt.submit', ($, e) => {
      sent.push(e.text)
      return { text: e.text }
    })

    await $.tool.call({ tool: 'mcp__assumptions__log_assumption', assumption: 'Use SQLite for storage' } as never)
    await $.tool.call({ tool: 'mcp__assumptions__log_assumption', assumption: 'Dark mode by default' } as never)

    const ui = await $.ui.mount({
      plugin: 'assumptions',
      surface,
      component: 'Pane',
      requestId: 'assumptions',
      props: PANE,
    })
    expect(await ui.findAll({ type: 'Button', text: 'Right' })).toHaveLength(2)

    const [first, second] = await ui.findAll({ type: 'Button', text: 'Right' })
    await ui.press({ key: first!.key! })
    await ui.press({ key: second!.key!.replace(/^r-/, 'w-') })
    await ui.input({ key: second!.key!.replace(/^r-/, 'c-'), text: 'Light mode by default' })
    await ui.press({ key: 'send' })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('CONFIRMED: Use SQLite for storage')
    expect(sent[0]).toContain('WRONG: Dark mode by default')
    expect(sent[0]).toContain('Correction: Light mode by default')
  })
}

test('archives all, restores one and all, and deletes only after confirming', async ($, on) => {
  on('session.root', () => ({ value: '/work/app' }))
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const stored = () => (store.get('archive:/work/app') ?? []) as { text: string; verdict: string }[]
  mock.clock(on, { now: Date.UTC(2026, 9, 12) })
  for (const assumption of ['Use SQLite for storage', 'Dark mode by default', 'Port 3000']) {
    await $.tool.call({ tool: 'mcp__assumptions__log_assumption', assumption } as never)
  }
  const ui = await $.ui.mount({
    plugin: 'assumptions',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'assumptions',
    props: PANE,
  })
  const [first] = await ui.findAll({ type: 'Button', text: 'Right' })
  await ui.press({ key: first!.key! })

  await ui.press({ key: 'archive-all' })
  expect(await ui.findAll({ type: 'Button', text: 'Right' })).toHaveLength(0)
  expect((await ui.find({ key: 'view-archived' }))?.text).toContain('Archived (3)')

  expect(toasts).toContain('Archived 3. Restore them from Archived.')
  // Persisted with verdicts intact.
  expect(stored()).toHaveLength(3)
  expect(stored()[0]).toMatchObject({ text: 'Use SQLite for storage', verdict: 'right' })

  await ui.press({ key: 'view-archived' })
  const restores = await ui.findAll({ type: 'Button', text: /^Restore$/ })
  expect(restores).toHaveLength(3)
  await ui.press({ key: restores[1]!.key! })
  expect((await ui.find({ key: 'view-active' }))?.text).toContain('Active (1)')
  expect(stored()).toHaveLength(2)

  // Delete asks first; Keep backs out with nothing lost.
  await ui.press({ key: 'delete-archive' })
  await ui.press({ key: 'cancel-delete' })
  expect(stored()).toHaveLength(2)

  await ui.press({ key: 'restore-all' })
  expect((await ui.find({ key: 'view-active' }))?.text).toContain('Active (3)')
  expect(await ui.findAll({ type: 'Button', text: 'Right' })).toHaveLength(3)
  expect(stored()).toHaveLength(0)

  await ui.press({ key: 'archive-all' })
  await ui.press({ key: 'view-archived' })
  await ui.press({ key: 'delete-archive' })
  await ui.press({ key: 'confirm-delete' })
  expect(stored()).toHaveLength(0)
  expect((await ui.find({ key: 'view-archived' }))?.text).toContain('Archived (0)')
})
