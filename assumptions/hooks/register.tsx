import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Assumption, Verdict } from '../types'

const PANE = 'assumptions'
const TOOL = 'mcp__assumptions__log_assumption'
const list = atom({ plugin: 'assumptions', key: 'list' } as const, [])
const editing = atom({ plugin: 'assumptions', key: 'editing' } as const, null)

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
      description: 'Review the assumptions Claude has made this session',
    })

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

  on('command.run', { command: 'assumptions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Assumptions' })

    return { text: 'Assumptions pane opened.' }
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
      <Box>
        <Text color="yellow">◆ </Text>
        <Text dimColor>
          {pending} assumption{pending === 1 ? '' : 's'} to review{unsent ? `, ${unsent} unsent` : ''}{' '}
        </Text>
        <Button
          key="review"
          label="Review"
          onPress={() => $.ui.open({ id: PANE, title: 'Assumptions' })}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Mobile has no Input: corrections are typed on the other surfaces.
    const Input = 'Input' in els ? els.Input : null
    const all = await read($, list)
    const edit = await read($, editing)
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

    if (all.length === 0) {
      return <Text dimColor>No assumptions logged yet.</Text>
    }

    return (
      <Box flexDirection="column">
        {all.map((a, i) => (
          <Box key={a.id} flexDirection="column" marginBottom={1}>
            <Text dimColor={a.isSent}>
              <Text color={a.verdict === 'right' ? 'green' : a.verdict === 'wrong' ? 'red' : 'yellow'}>
                {a.verdict === 'right' ? '✓' : a.verdict === 'wrong' ? '✗' : '?'}
              </Text>{' '}
              {i + 1}. {a.text}
            </Text>
            {a.correction !== '' && <Text dimColor>   → {a.correction}</Text>}
            {!a.isSent && (
              <Box>
                <Text>   </Text>
                <Button key={`r-${a.id}`} label="Right" onPress={() => mark(a.id, 'right')} />
                <Text> </Text>
                <Button
                  key={`w-${a.id}`}
                  label="Wrong"
                  onPress={async () => {
                    await mark(a.id, 'wrong')
                    await update($, editing, () => a.id)
                  }}
                />
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
        {ready.length > 0 && (
          <Button key="send" variant="primary" label={`Send ${ready.length} to Claude`} onPress={send} />
        )}
      </Box>
    )
  })
}
