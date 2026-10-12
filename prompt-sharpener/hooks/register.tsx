import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Status } from '../types'
import { SYSTEM_PROMPT } from './system-prompt'

const MODEL = 'sonnet'
const TIMEOUT_MS = 45_000
const MAX_FILE_CHARS = 12_000
const MAX_SKILLS = 40

const INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']
const SKILLS_DIR = '.claude/skills'
// Mods cannot define keybinding actions, so the chord runs this command instead:
// "ctrl+x e": "command:enhance" in keybindings.json's Chat block. A chord-run command
// leaves the draft in the box.
const ENHANCE_COMMAND = 'enhance'
const TINT = 'suggestion'
// context-meter's teal and slate, so the mods read as one family; blue (used nowhere in the
// meter) for the wait. The main action of the moment gets the teal key.
const TEAL = '#20a39a'
const SLATE = '#64748b'
const BLUE = '#4a90d9'

const status = atom({ plugin: 'prompt-sharpener', key: 'status' } as const, 'idle' as Status)
// The draft as it was before the last enhancement, for Undo.
const original = atom({ plugin: 'prompt-sharpener', key: 'original' } as const, null as string | null)
const hasDraft = atom({ plugin: 'prompt-sharpener', key: 'hasDraft' } as const, false)

// Writes only on a change, so typing does not redraw the band on every key.
// Never throws: typing and sending must not depend on the band's bookkeeping.
const trackDraft = async ($: EngineInterface, text: string) => {
  const isPresent = text.trim() !== ''
  try {
    if ((await read($, hasDraft)) !== isPresent) await update($, hasDraft, () => isPresent)
    if (!isPresent && (await read($, original)) !== null) await update($, original, () => null)
  } catch {}
}

const readOrNull = ($: EngineInterface, path: string) =>
  $.fs.read(path).then(
    text => (typeof text === 'string' ? text : null),
    () => null,
  )

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text

const frontmatterField = (text: string, field: string) => {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const line = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(head)?.[1] ?? ''
  return line.trim().replace(/^["']|["']$/g, '')
}

// Project instructions in full (capped), and skills as a name + description index.
export const projectContext = async ($: EngineInterface) => {
  const parts: string[] = []

  for (const path of INSTRUCTION_FILES) {
    const text = await readOrNull($, path)
    if (text?.trim()) {
      parts.push(`<file path="${path}">\n${clip(text.trim(), MAX_FILE_CHARS)}\n</file>`)
    }
  }

  const entries = await $.fs.list(SKILLS_DIR).catch(() => [])
  const skills: string[] = []
  for (const entry of entries.filter(x => x.kind === 'dir').slice(0, MAX_SKILLS)) {
    const text = await readOrNull($, `${SKILLS_DIR}/${entry.name}/SKILL.md`)
    if (text === null) continue
    const name = frontmatterField(text, 'name') || entry.name
    const description = frontmatterField(text, 'description')
    skills.push(`- ${name}${description ? `: ${description}` : ''}`)
  }
  if (skills.length > 0) {
    parts.push(`<skills>\n${skills.join('\n')}\n</skills>`)
  }

  return parts.join('\n\n')
}

const tidy = (reply: string) =>
  reply
    .trim()
    .replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1')
    .trim()

export const enhance = async ($: EngineInterface) => {
  if ((await read($, status)) === 'enhancing') return

  const draft = (await $.prompt.read()).text
  if (!draft.trim()) {
    $.ui.toast('Type a prompt first, then press Enhance.')
    return
  }

  await update($, status, () => 'enhancing')
  try {
    const context = await projectContext($)
    const result = await $.model.complete({
      model: MODEL,
      system: [{ text: SYSTEM_PROMPT, cache: true }],
      prompt: [
        `<project_context>\n${context || 'None found.'}\n</project_context>`,
        `<rough_request>\n${draft}\n</rough_request>`,
        'Rewrite the rough request as described. Return only the prompt.',
      ].join('\n\n'),
      maxTokens: 2048,
      timeoutMs: TIMEOUT_MS,
    })

    const text = result.isAnswered ? tidy(result.text) : ''
    if (!text) {
      const why = result.isAnswered ? 'empty reply' : result.reason
      $.ui.toast(`Enhance failed (${why}). Your prompt is unchanged.`)
      return
    }

    // Never overwrite edits made while the model was working.
    if ((await $.prompt.read()).text !== draft) {
      $.ui.toast('The draft changed while enhancing, so your edits were kept.')
      return
    }

    // Tinted until the next edit, which clears decorations by itself.
    const filled = await $.prompt.fill({
      text,
      mode: 'replace',
      decorations: [{ start: 0, end: text.length, color: TINT }],
    })
    if (!filled.isFilled) {
      $.ui.toast('Could not write to the prompt box. Your prompt is unchanged.')
      return
    }
    await update($, original, () => draft)
  } catch (error) {
    $.ui.toast(`Enhance failed: ${String(error)}. Your prompt is unchanged.`)
  } finally {
    await update($, status, () => 'idle')
  }
}

export const undo = async ($: EngineInterface) => {
  const before = await read($, original)
  if (before === null) return
  await $.prompt.fill({ text: before, mode: 'replace' })
  await update($, original, () => null)
}

// The only path by which this mod sends anything: an explicit press.
export const send = async ($: EngineInterface) => {
  const draft = (await $.prompt.read()).text
  if (!draft.trim()) {
    $.ui.toast('Nothing to send.')
    return
  }
  await $.prompt.fill({ text: '', mode: 'replace' })
  await update($, original, () => null)
  try {
    await $.prompt.submit({ text: draft, asUser: true })
  } catch (error) {
    await $.prompt.fill({ text: draft, mode: 'replace' })
    $.ui.toast(`Send failed: ${String(error)}. Your prompt is back in the box.`)
  }
}

export const register: Register = on => {
  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    await trackDraft($, result.text)
    return result
  })

  on('prompt.fill', async ($, e, next) => {
    const result = await next(e)
    if (result.isFilled) await trackDraft($, e.mode === 'replace' ? e.text : (await $.prompt.read()).text)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // The chord's /enhance goes through here too, but the draft stays in the box.
    if (e.origin.kind === 'composer' && e.text.trim() !== `/${ENHANCE_COMMAND}`) void trackDraft($, '')
    return next(e)
  }).catch(($, e, next) => next(e)) // never block a prompt: on failure, let it through

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: ENHANCE_COMMAND, description: 'Rewrite the draft in the prompt box into a sharper prompt (ctrl+x e)' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  // Answers at once with no output row; the band shows the progress.
  on('command.run', { command: ENHANCE_COMMAND }, async $ => {
    void enhance($)
    return {}
  })

  // Each button is its own rounded key: Enhance (or Undo once enhanced) and Send, with a hint beside them.
  // Drawn above whatever else draws there, so other mods' bands still show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const isEnhancing = (await read($, status)) === 'enhancing'
    const isEnhanced = (await read($, original)) !== null
    if (!isEnhancing && !(await read($, hasDraft))) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const key = (border: string, child: RenderElement) => (
      <Box borderStyle="round" borderColor={border} paddingX={1}>
        {child}
      </Box>
    )
    const stack = (row: RenderElement) => (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )

    if (isEnhancing) {
      return stack(
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {key(BLUE, <Text bold color={BLUE}>✦ Enhancing…</Text>)}
          <Text dimColor>your draft stays put until this finishes</Text>
        </Box>,
      )
    }

    return stack(
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {isEnhanced
          ? key(SLATE, <Button key="undo" plain onPress={() => undo($)}><Text>↶ Undo</Text></Button>)
          : key(TEAL, (
              <Button key="enhance" plain onPress={() => enhance($)}>
                <Text bold color={TEAL}>✦ Enhance</Text>
              </Button>
            ))}
        {key(isEnhanced ? TEAL : SLATE, (
          <Button key="send" plain onPress={() => send($)}>
            <Text bold={isEnhanced} color={isEnhanced ? TEAL : undefined}>Send ⏎</Text>
          </Button>
        ))}
        <Text dimColor>{isEnhanced ? ' ✓ enhanced · enter to send' : ' ctrl+x e to enhance · enter to send'}</Text>
      </Box>,
    )
  })
}
