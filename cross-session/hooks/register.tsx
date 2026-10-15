import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Entry } from '../types'

const PANE = 'cross-session'
const log = atom({ plugin: 'cross-session', key: 'log' } as const, [])
const muted = atom({ plugin: 'cross-session', key: 'muted' } as const, [])
const openId = atom({ plugin: 'cross-session', key: 'openId' } as const, null)
const hasToasts = atom({ plugin: 'cross-session', key: 'hasToasts' } as const, true)

const KEEP = 200
const TEAL = '#20a39a'
const SLATE = '#64748b'
const RED = '#d6564f'

// Common credential shapes. Masks the value, keeps the label of a `key=value` pair.
const SECRETS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '$1[redacted]'],
]

const redact = (text: string) => {
  let hits = 0
  let out = text
  for (const [pattern, to] of SECRETS) {
    hits += out.match(pattern)?.length ?? 0
    out = out.replace(pattern, to)
  }
  return { text: out, hits }
}

const clock = (at: number) => {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const firstLine = (text: string) => {
  const line = text.split('\n')[0] ?? ''
  return line.length > 70 ? `${line.slice(0, 69)}…` : line
}

const showStatus = ($: $, list: Entry[]) => {
  if (list.length === 0) return $.ui.status(undefined)
  const inn = list.filter(e => e.dir === 'in' && !e.isBlocked).length
  const out = list.filter(e => e.dir === 'out').length
  const blocked = list.filter(e => e.dir === 'in' && e.isBlocked).length
  $.ui.status(`cross-session: ${inn} in · ${out} out${blocked ? ` · ${blocked} muted` : ''}`)
}

const record = async ($: $, entry: Omit<Entry, 'id' | 'at'>) => {
  const at = await $.clock.now()
  const full: Entry = { ...entry, id: `${at}-${Math.random().toString(36).slice(2, 6)}`, at }
  await update($, log, list => [...list, full].slice(-KEEP))
  showStatus($, await read($, log))
}

const open = ($: $) => $.ui.open({ id: PANE, title: 'Cross-session messages', focus: true })

const keycap = (Box: any, border: string, button: unknown) => (
  <Box borderStyle="round" borderColor={border} paddingX={1} flexShrink={0}>
    {button}
  </Box>
)

// A peer's label: a teammate's name, else the plugin that composed it, else the kind.
const fromOf = (origin: { kind: string; plugin?: string; teammate?: string }) =>
  origin.teammate ?? origin.plugin ?? origin.kind

const TRACKED = new Set(['peer', 'coordinator', 'peer-send-message'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cross-session',
      description: 'Open the cross-session message log (`clear` empties it)',
    })
    await $.command.register({
      name: 'cross-session-send',
      description: 'Send a message to another agent or session: /cross-session-send <to> <text>',
    })

    return next(e)
  })

  on('command.run', { command: 'cross-session' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, log, () => [])
      showStatus($, [])
      return { text: 'Cross-session log cleared.' }
    }
    await open($)

    return { text: 'Cross-session log opened.' }
  })

  on('command.run', { command: 'cross-session-send' }, async ($, e) => {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (!match) return { text: 'Usage: /cross-session-send <to> <text>' }
    const sent = await $.session.send({ to: match[1]!, text: match[2]! })

    return { text: sent.isDelivered ? `Sent to ${match[1]}.` : `Not delivered: ${sent.reason}` }
  })

  on('session.send', async ($, e, next) => {
    const { text, hits } = redact(e.text)
    const sent = await next(hits > 0 ? { ...e, text } : e)
    await record($, {
      dir: 'out',
      peer: e.to,
      text,
      isBlocked: !sent.isDelivered,
      redacted: hits,
      note: sent.isDelivered ? undefined : sent.reason,
    })

    return sent
  })

  on('session.receive', async ($, e, next) => {
    if (!TRACKED.has(e.origin.kind)) return next(e)
    const from = fromOf(e.origin as { kind: string; plugin?: string; teammate?: string })
    const isMuted = (await read($, muted)).includes(from)
    await record($, { dir: 'in', peer: from, text: e.text, isBlocked: isMuted, redacted: 0 })
    if (isMuted) return { consumed: `${from} is muted by cross-session` }
    if (await read($, hasToasts)) $.ui.toast(`Message from ${from}: ${firstLine(e.text)}`)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, log)
    const mutedList = await read($, muted)
    const selected = await read($, openId)
    const toasts = await read($, hasToasts)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {keycap(Box, SLATE, (
            <Button key="toasts" plain onPress={() => void update($, hasToasts, v => !v)}>
              <Text>Toasts: {toasts ? 'on' : 'off'}</Text>
            </Button>
          ))}
          {keycap(Box, SLATE, (
            <Button
              key="clear"
              plain
              onPress={async () => {
                await update($, log, () => [])
                showStatus($, [])
              }}
            >
              <Text>Clear</Text>
            </Button>
          ))}
        </Box>
        {mutedList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Muted:</Text>
            <Box flexDirection="row" columnGap={1}>
              {mutedList.map(peer =>
                keycap(Box, RED, (
                  <Button
                    key={`unmute-${peer}`}
                    plain
                    onPress={() => void update($, muted, m => m.filter(p => p !== peer))}
                  >
                    <Text color={RED}>Unmute {peer}</Text>
                  </Button>
                )),
              )}
            </Box>
          </Box>
        )}
        {list.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No messages yet. Messages to and from other sessions and agents appear here.</Text>
          </Box>
        )}
        {[...list].reverse().map(entry => {
          const isOpen = selected === entry.id
          const arrow = entry.dir === 'in' ? '←' : '→'
          const flag = entry.isBlocked ? (entry.dir === 'in' ? ' [muted]' : ' [not delivered]') : ''
          const redactedNote = entry.redacted > 0 ? ` [${entry.redacted} redacted]` : ''

          return (
            <Box key={entry.id} flexDirection="column" marginTop={1}>
              <Button
                key={`row-${entry.id}`}
                plain
                onPress={() => void update($, openId, cur => (cur === entry.id ? null : entry.id))}
              >
                <Text dimColor={entry.isBlocked}>
                  {clock(entry.at)} {arrow} {entry.peer}{flag}{redactedNote}: {firstLine(entry.text)}
                </Text>
              </Button>
              {isOpen && (
                <Box flexDirection="column" marginLeft={2}>
                  <Text>{entry.text}</Text>
                  {entry.note && <Text color={RED}>{entry.note}</Text>}
                  {entry.dir === 'in' && !mutedList.includes(entry.peer) && (
                    <Box flexDirection="row">
                      {keycap(Box, TEAL, (
                        <Button
                          key={`mute-${entry.id}`}
                          plain
                          onPress={() => void update($, muted, m => [...m, entry.peer])}
                        >
                          <Text color={TEAL}>Mute {entry.peer}</Text>
                        </Button>
                      ))}
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
