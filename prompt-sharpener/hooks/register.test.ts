import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptDecoration, RenderElement } from 'claude-code'

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

const VAGUE = 'make the dashboard better'
const SHARP =
  'Improve the dashboard in this Next.js app. Inspect the current dashboard components first, then propose and make focused improvements without changing its data sources.'

// The person typing a draft, as a fill through the plugin's hooks.
const type = ($: Engine, text: string) =>
  $.prompt.fill({ text, mode: 'replace', origin: { kind: 'engine' } })

// A fake prompt box, project, and model beneath the plugin.
const world = (on: On, reply: { isAnswered: boolean; text?: string }) => {
  const box = { text: VAGUE }
  const sent: string[] = []
  const asked: string[] = []
  const tints: (readonly PromptDecoration[] | undefined)[] = []

  // What the engine draws when the band yields: nothing.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    tints.push(e.decorations)
    return { isFilled: true, text: box.text, cursor: box.text.length }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('fs.read', ($, e) => {
    const path = e.path.replace(/^.*\/prompt-sharpener\//, '')
    if (path === 'CLAUDE.md') return { value: 'Stack: Next.js 15, Tailwind. Call it the "dashboard", not "admin".' }
    if (path === '.claude/skills/ui-review/SKILL.md')
      return { value: '---\nname: ui-review\ndescription: Review UI changes against the design system\n---\nBody' }
    return { deny: 'ENOENT' }
  })
  on('fs.list', () => ({ value: [{ name: 'ui-review', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return reply.isAnswered
      ? { value: { isAnswered: true as const, text: reply.text ?? '', usage } }
      : { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage } }
  })

  return { box, sent, asked, tints }
}

test('the band stays hidden until there is a draft', async ($, on) => {
  world(on, { isAnswered: true, text: SHARP })
  await type($, '')
  const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'enhance' })).toBeUndefined()

  await type($, VAGUE)
  expect(await ui.find({ key: 'enhance' })).toBeDefined()
  expect(await ui.find({ key: 'undo' })).toBeUndefined()
})

test('Enhance rewrites the draft in place and never sends', async ($, on) => {
  const { box, sent, asked, tints } = world(on, { isAnswered: true, text: SHARP })
  for (const surface of ['terminal', 'desktop'] as const) {
    await type($, '')
    await type($, VAGUE)
    const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface, ...BAND })
    await ui.press({ key: 'enhance' })

    expect(box.text).toBe(SHARP)
    expect(sent).toEqual([])
    expect(tints.at(-1)).toEqual([{ start: 0, end: SHARP.length, color: 'suggestion' }])
    expect(await ui.find({ key: 'undo' })).toBeDefined()
    expect(await ui.find({ key: 'enhance' })).toBeUndefined()
    await ui.unmount()
  }
  expect(asked[0]).toContain('Next.js 15')
  expect(asked[0]).toContain('ui-review: Review UI changes')
  expect(asked[0]).toContain(VAGUE)
})

test('Send submits exactly what is in the box, once', async ($, on) => {
  const { box, sent } = world(on, { isAnswered: true, text: SHARP })
  await type($, VAGUE)
  const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface: 'terminal', ...BAND })
  await ui.press({ key: 'enhance' })
  box.text = `${SHARP} Keep it accessible.`
  await ui.press({ key: 'send' })

  expect(sent).toEqual([`${SHARP} Keep it accessible.`])
  expect(box.text).toBe('')
})

test('Undo restores the original draft', async ($, on) => {
  const { box } = world(on, { isAnswered: true, text: SHARP })
  await type($, VAGUE)
  const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface: 'terminal', ...BAND })
  await ui.press({ key: 'enhance' })
  await ui.press({ key: 'undo' })

  expect(box.text).toBe(VAGUE)
})

test('a failed enhancement leaves the original prompt intact and sendable', async ($, on) => {
  const { box, sent } = world(on, { isAnswered: false })
  await type($, VAGUE)
  const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface: 'terminal', ...BAND })
  await ui.press({ key: 'enhance' })
  expect(box.text).toBe(VAGUE)
  expect(sent).toEqual([])

  await ui.press({ key: 'send' })
  expect(sent).toEqual([VAGUE])
})

test('the ctrl+x e chord runs /enhance, which rewrites the draft without sending', async ($, on) => {
  const { box, sent } = world(on, { isAnswered: true, text: SHARP })
  await type($, VAGUE)
  await $.command.run({ command: 'enhance', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // The command answers before the rewrite lands: wait for the band to show Undo.
  const ui = await $.ui.mount({ plugin: 'prompt-sharpener', surface: 'terminal', ...BAND })
  for (let i = 0; i < 100 && !(await ui.find({ key: 'undo' })); i++);

  expect(box.text).toBe(SHARP)
  expect(sent).toEqual([])
})
