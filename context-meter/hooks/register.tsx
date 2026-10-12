// Context Meter: what is filling my context window?
//   Above the prompt, a teal CONTEXT chip with the tokens in use, the window as a gauge of
//   segmented cells with the compaction point marked, and a ledger beneath it grouped by who
//   put each part there: built in (slate), the user's setup (teal), the conversation (coral),
//   and what is left before compaction. It refreshes after each turn. /context-meter shows
//   or hides it, and the choice is kept across sessions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Group, Reading, Run, Slice } from '../types'

const MIN_WIDTH = 20 // narrower than this, the meter is not drawn
// One set of colors that reads on dark and light terminals alike; neutrals come from the theme.
const SLATE = '#64748b' // built in
const TEAL = '#20a39a' // the user's setup, and the chip
const CORAL = '#f0643f' // the conversation, the part that grows
const CHIP_TEXT = '#06201e'
const QUIET = 'inactive'
const GLYPH = { used: '▰', free: '▱', buffer: '▱' } as const
const MARK = '┃' // where auto-compaction runs
const BUILT_IN = new Set(['system prompt', 'system tools']) // every other used row is the user's setup
const LEADER = 23 // a ledger row's bullet, label, dots and total take this many cells
const GAP = '   ' // between a ledger row's total and its detail
const DETAIL_MIN = 12 // narrower than this, the detail column is dropped and a row wraps as one line
const FRAME = 4 // the box's border and inner padding take this many columns

// Held by the host, so the meter survives a hot reload of this file.
const reading = atom({ plugin: 'context-meter', key: 'reading' } as const, null as Reading | null)
const isHidden = atom({ plugin: 'context-meter', key: 'isHidden' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'context-meter', description: 'Show or hide the context meter above the prompt' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    const hidden = (await $.store.get('isHidden').catch(() => undefined)) === true
    await update($, isHidden, () => hidden)
    void refresh($).catch(() => {})
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await refresh($).catch(() => {}) // a subagent's turn fills its own window, not this one
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'messages' in r) void refresh($).catch(() => {}) // a /compact empties the window without a turn ending
    return r
  })

  on('command.run', { command: 'context-meter' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    await $.store.set('isHidden', hidden).catch(() => {})
    if (!hidden) await refresh($).catch(() => {})
    return { text: hidden ? 'Context meter hidden. /context-meter shows it again' : 'Context meter on' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays, drawn above the meter so one-row mods stay visible
    const r = await read($, reading)
    if (e.props.hasSurvey || (await read($, isHidden)) || !r) return rest
    const { Box, Text } = $.ui.resolve(e)
    if (e.props.bodyColumns < MIN_WIDTH) return rest
    const width = e.props.bodyColumns - FRAME

    const draw = (runs: Run[]) => runs.map(s => <Text color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text>)
    const level = r.total / (r.compactsAt ?? r.window)
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between">
            <Text wrap="wrap">
              <Text bold color={CHIP_TEXT} backgroundColor={TEAL}>{' CONTEXT '}</Text>
              <Text bold>{`  ${tokens(r.total)}`}</Text>
              <Text dimColor>{` of ${tokens(r.window)}`}</Text>
            </Text>
            <Text wrap="wrap">
              {r.compactsAt !== undefined && <Text dimColor>{`compacts at ${tokens(r.compactsAt)}  `}</Text>}
              <Text bold color={level >= 0.9 ? 'error' : level >= 0.7 ? 'warning' : undefined}>{`${r.percent}%`}</Text>
            </Text>
          </Box>
          <Text>{draw(marked(r, cells({ ...r, slices: bar(r) }, width)))}</Text>
          {ledger(r).map(line => {
            if (width < LEADER + GAP.length + DETAIL_MIN) return <Text wrap="wrap">{draw(line)}</Text>
            // The detail gets its own column, so its wrapped lines stay indented beneath it.
            const detail = line.at(-1)!
            return (
              <Box flexDirection="row">
                <Box flexShrink={0}>
                  <Text>{draw([...line.slice(0, -1), { text: GAP }])}</Text>
                </Box>
                <Text wrap="wrap">{draw([{ ...detail, text: detail.text.slice(GAP.length) }])}</Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}

// Asks the engine for /context's breakdown, estimated locally (no token-count calls).
async function refresh($: EngineInterface) {
  if (await read($, isHidden)) return
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return // no window to measure against
  await update($, reading, () => toReading(b))
}

export function toReading(b: {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}): Reading {
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, color: c.color, kind: c.kind as Slice['kind'] }))
  const order = { used: 0, free: 1, buffer: 2 }
  slices.sort((x, y) => order[x.kind] - order[y.kind]) // stable: used rows keep /context's order
  for (const s of slices) s.color = s.kind === 'used' ? owner(s).color : QUIET
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }
}

// Who put a used row there: Claude Code, the user's setup, or the conversation.
function owner(s: Slice) {
  if (BUILT_IN.has(s.name)) return { label: 'built in', color: SLATE }
  if (s.name === 'messages') return { label: 'conversation', color: CORAL }
  return { label: 'your setup', color: TEAL }
}

// The used rows gathered by owner, in the order the meter draws them.
export function groups(r: Reading): Group[] {
  const out: Group[] = []
  for (const label of ['built in', 'your setup', 'conversation']) {
    const slices = r.slices.filter(s => s.kind === 'used' && owner(s).label === label)
    if (slices.length) out.push({ label, color: slices[0]!.color, slices, tokens: slices.reduce((a, s) => a + s.tokens, 0) })
  }
  return out
}

// The gauge's slices: one per owner, then free space and the buffer.
function bar(r: Reading): Slice[] {
  return [...groups(r).map(g => ({ name: g.label, tokens: g.tokens, color: g.color, kind: 'used' as const })), ...r.slices.filter(s => s.kind !== 'used')]
}

// The gauge as runs of cells: each slice gets its share of `width`, a used one at least one cell.
export function cells(r: Reading, width: number) {
  const sizes = r.slices.map(s => Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)))
  // Rounding leaves the sum a few cells off: free space takes the difference first, then the largest slices.
  let diff = width - sizes.reduce((a, n) => a + n, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const order = r.slices.map((_, i) => i).sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of order) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  return r.slices.map((s, i) => ({ color: s.color, kind: s.kind, text: GLYPH[s.kind].repeat(sizes[i]!) })).filter(c => c.text !== '')
}

// The gauge with the compaction point marked: the mark takes the buffer's first cell, and the buffer is drawn dim.
export function marked(r: Reading, gauge: ReturnType<typeof cells>): Run[] {
  const runs: Run[] = gauge.map(c => ({ text: c.text, color: c.color, dim: c.kind === 'buffer' }))
  const i = gauge.findIndex(c => c.kind === 'buffer')
  if (!r.compactsAt || i < 0) return runs
  runs.splice(i, 1, { text: MARK, bold: true }, { ...runs[i]!, text: runs[i]!.text.slice(1) })
  return runs.filter(s => s.text !== '')
}

// The ledger: a row per owner with dotted leaders to its total, then what is left before compaction.
// A group of several rows lists them dim on the right; a lone row shows its share of the window instead.
export function ledger(r: Reading): Run[][] {
  const row = (label: string, color: string, total: number, detail: string): Run[] => {
    const value = tokens(total)
    const dots = Math.max(2, LEADER - 2 - label.length - 1 - value.length - 1)
    return [
      { text: '● ', color },
      { text: `${label} ` },
      { text: `${'·'.repeat(dots)} `, color: QUIET },
      { text: value, bold: true, color: color === QUIET ? undefined : color },
      { text: `${GAP}${detail}`, dim: true },
    ]
  }
  const lines = groups(r).map(g =>
    row(g.label, g.color, g.tokens, g.slices.length > 1 ? g.slices.map(s => `${s.name} ${tokens(s.tokens)}`).join(' · ') : share(g.tokens, r.window)),
  )
  const buffer = r.slices.find(s => s.kind === 'buffer')
  const limit = r.compactsAt ?? r.window
  const until = r.compactsAt !== undefined ? `until ${MARK} compaction at ${tokens(r.compactsAt)}${buffer ? ` · buffer ${tokens(buffer.tokens)}` : ''}` : 'until the window is full'
  lines.push(row('left', QUIET, Math.max(0, limit - r.total), until))
  return lines
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function share(n: number, window: number) {
  const p = (n / window) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`
}
