import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Idea } from '../types'

const PANE = 'idea-shelf'
const ideas = atom({ plugin: 'idea-shelf', key: 'ideas' } as const, [])

// Each project keeps its own shelf, across sessions.
const storeKey = async ($: $) => `ideas:${await $.session.root()}`

const showCount = (count: number) =>
  count === 0 ? undefined : `💡 ${count} idea${count === 1 ? '' : 's'} shelved`

const change = async ($: $, fn: (list: Idea[]) => Idea[]) => {
  await update($, ideas, fn)
  const list = await read($, ideas)
  await $.store.set(await storeKey($), list)
  $.ui.status(showCount(list.length))

  return list
}

const shelve = async ($: $, text: string) => {
  const trimmed = text.trim()
  if (trimmed === '') return read($, ideas)
  const now = await $.clock.now()
  const idea: Idea = { id: `${now}-${Math.random().toString(36).slice(2, 6)}`, text: trimmed, createdAt: now }

  return change($, list => [...list, idea])
}

const drop = ($: $, id: string) => change($, list => list.filter(one => one.id !== id))

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'

// The mods' shared look: each button its own rounded key, teal for the action to take
// next, slate for the rest (context-meter's colors).
const TEAL = '#20a39a'
const SLATE = '#64748b'

const keycap = (Box: any, border: string, button: unknown) => (
  <Box borderStyle="round" borderColor={border} paddingX={1} flexShrink={0}>
    {button}
  </Box>
)

// Starts a fresh Claude session on the idea, so the current one stays on task:
// a background cmux workspace when running inside cmux, else a Terminal window.
// The idea travels as an env var or an argv item, never spliced into a shell line.
const launch = async ($: $, text: string) => {
  const root = await $.session.root()
  const inCmux = (await $.env.get('CMUX_WORKSPACE_ID')) !== undefined
  const name = `💡 ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`
  const argv = inCmux
    ? [CMUX, 'new-workspace', '--name', name, '--cwd', root,
       '--env', `IDEA_SHELF_PROMPT=${text}`, '--command', 'claude "$IDEA_SHELF_PROMPT"']
    : ['osascript',
       '-e', 'on run argv',
       '-e', 'tell application "Terminal" to do script "cd " & quoted form of item 1 of argv & " && claude " & quoted form of item 2 of argv',
       '-e', 'end run', root, text]
  const ran = await $.process.run(argv, { env: { CMUX_QUIET: '1' } })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
}

const send = async ($: $, idea: Idea) => {
  try {
    await launch($, idea.text)
  } catch (error) {
    $.ui.toast(`Couldn't start a new session: ${error instanceof Error ? error.message : error}`)
    return
  }
  await drop($, idea.id)
  $.ui.toast('Idea sent to a new Claude session')
}

const open = ($: $) => $.ui.open({ id: PANE, title: 'Idea shelf', focus: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(await storeKey($))) as Idea[] | undefined
    await update($, ideas, () => saved ?? [])
    $.ui.status(showCount(saved?.length ?? 0))
    await $.command.register({
      name: 'idea',
      description: 'Shelve an idea for later without sending it (no args: open the shelf)',
    })
    await $.command.register({ name: 'ideas', description: 'Open the idea shelf' })

    return next(e)
  })

  on('command.run', { command: 'idea' }, async ($, e) => {
    if (e.args.trim() === '') {
      await open($)
      return { text: 'Idea shelf opened.' }
    }
    const list = await shelve($, e.args)

    return { text: `Shelved. ${list.length} on the shelf.` }
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await open($)
    return { text: 'Idea shelf opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without a text field still lists and sends; /idea adds there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, ideas)

    return (
      <Box flexDirection="column">
        {Input && (
          <Input
            key="new"
            placeholder="Jot an idea, Enter to shelve it"
            submitLabel="shelve"
            value=""
            autoFocus
            onSubmit={(value: string) => void shelve($, value)}
          />
        )}
        {list.length === 0 && (
          <Text dimColor>Nothing shelved. Ideas wait here until you send them.</Text>
        )}
        {list.map((idea, i) => (
          <Box key={idea.id} flexDirection="column" marginTop={1}>
            <Text>
              {i + 1}. {idea.text}
            </Text>
            <Box flexDirection="row" columnGap={1}>
              {keycap(Box, TEAL, (
                <Button key={`send-${idea.id}`} plain onPress={() => void send($, idea)}>
                  <Text bold color={TEAL}>Send</Text>
                </Button>
              ))}
              {keycap(Box, SLATE, (
                <Button
                  key={`edit-${idea.id}`}
                  plain
                  onPress={async () => {
                    await drop($, idea.id)
                    await $.prompt.fill({ text: idea.text })
                  }}
                >
                  <Text>Edit</Text>
                </Button>
              ))}
              {keycap(Box, SLATE, (
                <Button key={`drop-${idea.id}`} plain dimColor onPress={() => void drop($, idea.id)}>
                  <Text>Delete</Text>
                </Button>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
