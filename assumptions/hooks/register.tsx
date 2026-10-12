import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { Assumption, Verdict, View } from '../types'

const PANE = 'assumptions'
const TOOL = 'mcp__assumptions__log_assumption'
const list = atom({ plugin: 'assumptions', key: 'list' } as const, [])
const archive = atom({ plugin: 'assumptions', key: 'archive' } as const, [])
const view = atom({ plugin: 'assumptions', key: 'view' } as const, 'active')
const editing = atom({ plugin: 'assumptions', key: 'editing' } as const, null)
const isConfirmingDelete = atom({ plugin: 'assumptions', key: 'isConfirmingDelete' } as const, false)
// The mods' shared look: each button its own rounded key, teal for the action to take
// next, slate for the rest (context-meter's colors).
const TEAL = '#20a39a'
const SLATE = '#64748b'

const keycap = (Box: any, border: string, button: unknown) => (
  <Box borderStyle="round" borderColor={border} paddingX={1} flexShrink={0}>
    {button}
  </Box>
)

// The active list lasts the session; the archive is kept per project, across sessions.
const storeKey = async ($: $) => `archive:${await $.session.root()}`

// Re-reads the store before writing, so two sessions in one project merge their changes.
const changeArchive = async ($: $, fn: (stored: Assumption[]) => Assumption[]) => {
  const key = await storeKey($)
  const next = fn(((await $.store.get(key)) as Assumption[] | undefined) ?? [])
  await $.store.set(key, next)
  await update($, archive, () => next)
}

const show = ($: $, to: View) =>
  Promise.all([update($, view, () => to), update($, isConfirmingDelete, () => false)])

const open = async ($: $, to: View = 'active') => {
  await show($, to)
  await $.ui.open({ id: PANE, title: 'Assumptions' })
}

// The archive is written before the active list is emptied: if the write fails, nothing moves.
const archiveAll = async ($: $) => {
  const moving = await read($, list)
  if (moving.length === 0) return
  const ids = new Set(moving.map(a => a.id))
  const now = await $.clock.now()
  try {
    await changeArchive($, stored => [
      ...stored.filter(a => !ids.has(a.id)),
      ...moving.map(a => ({ ...a, archivedAt: now })),
    ])
  } catch (error) {
    $.ui.toast(`Couldn't archive: ${error instanceof Error ? error.message : error}`)
    return
  }
  await update($, list, xs => xs.filter(a => !ids.has(a.id)))
  await update($, editing, () => null)
  $.ui.toast(`Archived ${moving.length}. Restore them from Archived.`)
}

// Restores the given ids, or the whole archive: back into the active list first, then out of the archive.
const restore = async ($: $, only?: readonly string[]) => {
  const stored = ((await $.store.get(await storeKey($))) as Assumption[] | undefined) ?? (await read($, archive))
  const back = stored.filter(a => !only || only.includes(a.id))
  if (back.length === 0) return
  const ids = new Set(back.map(a => a.id))
  await update($, list, xs => [
    ...xs.filter(a => !ids.has(a.id)),
    ...back.map(({ archivedAt: _, ...a }) => a),
  ])
  await changeArchive($, xs => xs.filter(a => !ids.has(a.id)))
  if (only === undefined) await update($, view, () => 'active')
}

// Deletes only the archived items the person saw when confirming, never ones archived since.
const deleteArchived = async ($: $, ids: readonly string[]) => {
  await changeArchive($, xs => xs.filter(a => !ids.includes(a.id)))
  await update($, isConfirmingDelete, () => false)
  $.ui.toast(`Deleted ${ids.length} archived assumption${ids.length === 1 ? '' : 's'}.`)
}

const GUIDANCE = `# Logging assumptions
While building, whenever you make a non-obvious assumption the user has not confirmed (a requirement, a default, a naming or design choice, a library, a file location, a behaviour in an edge case), call the \`${TOOL}\` tool with one short sentence stating it. Do not stop to ask; log it and keep working. The user reviews these in a side pane and will send corrections. Skip trivial or already-confirmed choices.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'log_assumption',
      description:
        'Record one assumption you are making while building, so the user can confirm or correct it later. Call it and continue working; it never blocks.',
      inputSchema: {
        type: 'object',
        properties: {
          assumption: { type: 'string', description: 'The assumption, in one short sentence.' },
        },
        required: ['assumption'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'assumptions',
      description: 'Review the assumptions Claude has made this session (archived: open the archive)',
    })
    const saved = await $.store.get(await storeKey($)).catch(() => undefined)
    await update($, archive, () => (Array.isArray(saved) ? (saved as Assumption[]) : []))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [
        ...composed.sections,
        { id: 'assumptions:guidance', text: GUIDANCE, scope: 'session' as const },
      ],
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const text = String((e as { assumption?: unknown }).assumption ?? '').trim()
    if (!text) {
      return { deny: 'assumption is empty' }
    }
    const item: Assumption = {
      id: e.tool_use_id,
      text,
      verdict: 'pending',
      correction: '',
      isSent: false,
    }
    await update($, list, all => [...all, item])

    return { result: 'Logged. Continue working; the user will review it.' }
  })

  on('command.run', { command: 'assumptions' }, async ($, e) => {
    const toArchive = /^archived?$/i.test(e.args.trim())
    await open($, toArchive ? 'archived' : 'active')

    return { text: toArchive ? 'Assumptions archive opened.' : 'Assumptions pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, list)
    const pending = all.filter(a => a.verdict === 'pending').length
    const unsent = all.filter(a => a.verdict !== 'pending' && !a.isSent).length

    if (e.props.hasSurvey || (pending === 0 && unsent === 0)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {keycap(Box, TEAL, (
          <Button key="review" plain onPress={() => open($)}>
            <Text bold color={TEAL}>Review</Text>
          </Button>
        ))}
        <Text>
          <Text color="yellow">◆ </Text>
          <Text dimColor>
            {pending} assumption{pending === 1 ? '' : 's'} to review{unsent ? `, ${unsent} unsent` : ''}
          </Text>
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Mobile has no Input: corrections are typed on the other surfaces.
    const Input = 'Input' in els ? els.Input : null
    const all = await read($, list)
    const archived = await read($, archive)
    const shown = await read($, view)
    const edit = await read($, editing)
    const confirming = await read($, isConfirmingDelete)
    const ready = all.filter(a => a.verdict !== 'pending' && !a.isSent)

    const mark = (id: string, verdict: Verdict) =>
      update($, list, xs => xs.map(a => (a.id === id ? { ...a, verdict, isSent: false } : a)))

    const send = async () => {
      const lines = ready.map(a =>
        a.verdict === 'right'
          ? `- CONFIRMED: ${a.text}`
          : `- WRONG: ${a.text}${a.correction ? `\n  Correction: ${a.correction}` : ''}`,
      )
      await update($, list, xs =>
        xs.map(a => (ready.some(r => r.id === a.id) ? { ...a, isSent: true } : a)),
      )
      await $.prompt.submit({
        text: `Feedback on the assumptions you logged:\n${lines.join('\n')}\n\nAdjust the work for anything marked WRONG.`,
      })
    }

    const line = (a: Assumption, i: number) => (
      <>
        <Text dimColor={a.isSent}>
          <Text color={a.verdict === 'right' ? 'green' : a.verdict === 'wrong' ? 'red' : 'yellow'}>
            {a.verdict === 'right' ? '✓' : a.verdict === 'wrong' ? '✗' : '?'}
          </Text>{' '}
          {i + 1}. {a.text}
        </Text>
        {a.correction !== '' && <Text dimColor>   → {a.correction}</Text>}
      </>
    )

    const tab = (to: View, label: string) =>
      keycap(Box, shown === to ? TEAL : SLATE, (
        <Button key={`view-${to}`} plain onPress={() => show($, to)}>
          <Text bold={shown === to} color={shown === to ? TEAL : undefined}>{label}</Text>
        </Button>
      ))

    const tabs = (
      <Box flexDirection="row" columnGap={1} marginBottom={1}>
        {tab('active', `Active (${all.length})`)}
        {tab('archived', `Archived (${archived.length})`)}
      </Box>
    )

    if (shown === 'archived') {
      return (
        <Box flexDirection="column">
          {tabs}
          {archived.length === 0 && <Text dimColor>Nothing archived.</Text>}
          {archived.map((a, i) => (
            <Box key={a.id} flexDirection="column" marginBottom={1}>
              {line(a, i)}
              <Box flexDirection="row" columnGap={1} paddingLeft={3} alignItems="center">
                {keycap(Box, SLATE, (
                  <Button key={`restore-${a.id}`} plain onPress={() => restore($, [a.id])}>
                    <Text>Restore</Text>
                  </Button>
                ))}
                {a.archivedAt !== undefined && (
                  <Text dimColor>archived {new Date(a.archivedAt).toISOString().slice(0, 10)}</Text>
                )}
              </Box>
            </Box>
          ))}
          {archived.length > 0 && !confirming && (
            <Box flexDirection="row" columnGap={1}>
              {keycap(Box, TEAL, (
                <Button key="restore-all" plain onPress={() => restore($)}>
                  <Text bold color={TEAL}>{`Restore all ${archived.length}`}</Text>
                </Button>
              ))}
              {keycap(Box, SLATE, (
                <Button key="delete-archive" plain onPress={() => update($, isConfirmingDelete, () => true)}>
                  <Text>Delete archive</Text>
                </Button>
              ))}
            </Box>
          )}
          {archived.length > 0 && confirming && (
            <Box flexDirection="column">
              <Text color="red">
                Permanently delete {archived.length} archived assumption{archived.length === 1 ? '' : 's'}? This can't be undone.
              </Text>
              <Box flexDirection="row" columnGap={1}>
                {keycap(Box, 'red', (
                  <Button key="confirm-delete" plain onPress={() => deleteArchived($, archived.map(a => a.id))}>
                    <Text bold color="red">{`Delete ${archived.length}`}</Text>
                  </Button>
                ))}
                {keycap(Box, TEAL, (
                  <Button key="cancel-delete" plain onPress={() => update($, isConfirmingDelete, () => false)}>
                    <Text bold color={TEAL}>Keep</Text>
                  </Button>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        {all.length === 0 && (
          <Text dimColor>
            {archived.length > 0 ? 'No active assumptions. Older ones are under Archived.' : 'No assumptions logged yet.'}
          </Text>
        )}
        {all.map((a, i) => (
          <Box key={a.id} flexDirection="column" marginBottom={1}>
            {line(a, i)}
            {!a.isSent && (
              <Box flexDirection="row" columnGap={1} paddingLeft={3}>
                {keycap(Box, a.verdict === 'right' ? TEAL : SLATE, (
                  <Button key={`r-${a.id}`} plain onPress={() => mark(a.id, 'right')}>
                    <Text bold={a.verdict === 'right'} color={a.verdict === 'right' ? TEAL : undefined}>Right</Text>
                  </Button>
                ))}
                {keycap(Box, SLATE, (
                  <Button
                    key={`w-${a.id}`}
                    plain
                    onPress={async () => {
                      await mark(a.id, 'wrong')
                      await update($, editing, () => a.id)
                    }}
                  >
                    <Text bold={a.verdict === 'wrong'}>Wrong</Text>
                  </Button>
                ))}
              </Box>
            )}
            {Input && edit === a.id && (
              <Input
                key={`c-${a.id}`}
                placeholder="What should it be? (Enter to save, empty to skip)"
                autoFocus
                onSubmit={async (value: string) => {
                  await update($, list, xs =>
                    xs.map(x => (x.id === a.id ? { ...x, correction: value.trim() } : x)),
                  )
                  await update($, editing, () => null)
                }}
              />
            )}
          </Box>
        ))}
        {all.length > 0 && (
          <Box flexDirection="row" columnGap={1}>
            {ready.length > 0 && keycap(Box, TEAL, (
              <Button key="send" plain onPress={send}>
                <Text bold color={TEAL}>{`Send ${ready.length} to Claude`}</Text>
              </Button>
            ))}
            {keycap(Box, SLATE, (
              <Button key="archive-all" plain onPress={() => archiveAll($)}>
                <Text>{`Archive all ${all.length}`}</Text>
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
