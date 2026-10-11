import { expect, test } from 'claude-code/testing'

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
