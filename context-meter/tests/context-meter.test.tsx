import { describe, expect, test } from 'claude-code/testing'

import { cells, groups, ledger, marked, share, toReading, tokens } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 84 } }

// /context's breakdown as the engine hands it over, for a 1M window.
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_400, color: 'promptBorder', kind: 'used', isDeferred: false },
    { name: 'System tools', tokens: 12_000, color: 'inactive', kind: 'used', isDeferred: false },
    { name: 'MCP tools', tokens: 2_600, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', kind: 'deferred', isDeferred: true },
    { name: 'Skills', tokens: 0, color: 'warning', kind: 'used', isDeferred: false },
    { name: 'Messages', tokens: 186_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer', isDeferred: false },
    { name: 'Free space', tokens: 746_000, color: 'promptBorder', kind: 'free', isDeferred: false },
  ],
  totalTokens: 204_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 20,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
  gridRows: [],
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  model: 'opus',
  apiUsage: null,
  autocompactSource: 'model-default',
}

const width = (runs: { text: string }[]) => runs.reduce((n, s) => n + s.text.length, 0)
const plain = (runs: { text: string }[]) => runs.map(s => s.text).join('')

// Stands for the engine beneath the mod.
function engine(on: any, store: Record<string, unknown> = {}, breakdown: any = BREAKDOWN) {
  const asked: unknown[] = []
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', (_$: any, e: any) => {
    asked.push(e)
    return { value: { startedAt: 0, context: { tokens: breakdown.totalTokens, window: 1_000_000, percent: breakdown.percentage, breakdown }, rateLimits: {}, cost: { usd: 0 } } }
  })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { asked, store }
}

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 20)) // the first refresh runs in the background

describe('context-meter', () => {
  test('helpers', () => {
    expect(tokens(3_400)).toBe('3.4k')
    expect(tokens(186_000)).toBe('186k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(950)).toBe('950')
    expect(share(3_400, 1_000_000)).toBe('0.3%')
    expect(share(186_000, 1_000_000)).toBe('19%')
    expect(share(494, 1_000_000)).toBe('<0.1%')

    const r = toReading(BREAKDOWN)
    // Deferred and empty rows are left out; used first, then free, then the buffer.
    expect(r.slices.map(s => s.name)).toEqual(['system prompt', 'system tools', 'mcp tools', 'messages', 'free space', 'autocompact buffer'])
    expect(r.compactsAt).toBe(950_000)
    expect(toReading({ ...BREAKDOWN, isAutoCompactEnabled: false }).compactsAt).toBeUndefined()

    for (const width of [20, 47, 80, 200]) {
      const bar = cells(r, width)
      expect(bar.reduce((n, c) => n + c.text.length, 0)).toBe(width) // always exactly the width
      expect(bar.filter(c => c.kind === 'used').every(c => c.text.length >= 1)).toBe(true) // a small used slice still shows
    }
  })

  test('groups the used rows by who put them there, each owner in its own color', () => {
    const r = toReading(BREAKDOWN)
    expect(groups(r).map(g => [g.label, g.tokens, g.color])).toEqual([
      ['built in', 15_400, '#64748b'],
      ['your setup', 2_600, '#20a39a'],
      ['conversation', 186_000, '#f0643f'],
    ])
    // every row takes its owner's color; free space and the buffer stay quiet
    expect(r.slices.map(s => s.color)).toEqual(['#64748b', '#64748b', '#20a39a', '#f0643f', 'inactive', 'inactive'])
  })

  test('carves memory files and custom agents out of the built-in rows into your setup', () => {
    const r = toReading({
      ...BREAKDOWN,
      memoryFiles: [{ tokens: 1_000 }, { tokens: 400 }],
      agents: [{ tokens: 20_000 }], // more than system tools holds: clamped, so the host drops out
    })
    expect(r.slices.filter(s => s.kind === 'used').map(s => [s.name, s.tokens])).toEqual([
      ['system prompt', 2_000],
      ['memory files', 1_400],
      ['custom agents', 12_000],
      ['mcp tools', 2_600],
      ['messages', 186_000],
    ])
    expect(groups(r).map(g => [g.label, g.tokens])).toEqual([
      ['built in', 2_000],
      ['your setup', 16_000],
      ['conversation', 186_000],
    ])
  })

  test('the gauge is segmented cells with the compaction point marked', () => {
    const r = toReading(BREAKDOWN)
    for (const w of [20, 47, 84]) {
      const bar = marked(r, cells(r, w))
      expect(width(bar)).toBe(w)
      expect(plain(bar)).toMatch(/^▰+▱+┃▱*$/) // at 20 cells the 50k buffer is one cell, which the mark takes
    }
    const off = toReading({ ...BREAKDOWN, isAutoCompactEnabled: false })
    expect(plain(marked(off, cells(off, 80)))).not.toMatch(/┃/)
  })

  test('the ledger runs dotted leaders to each total, with the detail on the right', () => {
    const r = toReading(BREAKDOWN)
    expect(ledger(r).map(plain)).toEqual([
      '● built in ········ 15k   system prompt 3.4k · system tools 12k',
      '● your setup ····· 2.6k   0.3%', // a lone row shows its share instead
      '● conversation ··· 186k   19%',
      '● left ··········· 746k   until ┃ compaction at 950k · buffer 50k',
    ])
    expect(plain(ledger(toReading({ ...BREAKDOWN, isAutoCompactEnabled: false })).at(-1)!)).toBe('● left ··········· 796k   until the window is full')
    expect(ledger(r).map(l => l[3]!.color)).toEqual(['#64748b', '#20a39a', '#f0643f', undefined]) // totals in their owner's color, left plain
  })

  test('draws the meter above the prompt from a summary breakdown', async ($, on) => {
    const { asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect(asked).toEqual([{ breakdown: 'summary' }]) // estimated locally, never the token-count API

    const band = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: ' CONTEXT ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '  204k' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /compacts at 950k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '20%' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '┃' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'built in ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'conversation ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /mcp tools \(deferred\)/ })).toBeUndefined()
    const root: any = await band.drawn()
    expect(root.children[0].children).toEqual(['band below']) // the band beneath stays, above this one
    expect(root.children[1].props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle' }) // a light box around the meter
    await band.unmount()
  })

  test('refreshes after a main turn, not after a subagent turn', async ($, on) => {
    const { asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
    expect(asked.length).toBe(1)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(asked.length).toBe(2)
  })

  test('refreshes after a compaction', async ($, on) => {
    const { asked } = engine(on)
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await settle()
    expect(asked.length).toBe(2)
  })

  test('/context-meter hides and shows it, and remembers the choice', async ($, on) => {
    const { store } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect((await $.command.run({ command: 'context-meter', args: '' } as any)).text).toMatch(/hidden/)
    expect(store.isHidden).toBe(true)
    let band = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeUndefined()
    await band.unmount()

    expect((await $.command.run({ command: 'context-meter', args: '' } as any)).text).toBe('Context meter on')
    expect(store.isHidden).toBe(false)
    band = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeDefined()
    await band.unmount()
  })

  test('a session that hid it starts hidden', async ($, on) => {
    engine(on, { isHidden: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeUndefined()
    await band.unmount()
  })
})
