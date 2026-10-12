import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Active, Hold, Mode, Pick } from '../types'
import {
  MODEL_IDS,
  SYSTEM_PROMPT,
  activeLabel,
  classifierPrompt,
  hintWraps,
  isRoutable,
  label,
  matches,
  parsePick,
} from './router'

const CLASSIFIER = 'claude-haiku-5-5'
// The classifier's wait plus the hold must stay inside a hook's 10s budget.
const TIMEOUT_MS = 5_000
const HOLD_MS = 3_000
const HOLD_TICK_MS = 250
const DEBOUNCE_MS = 1_200
const MAX_CACHED = 50
const COMMAND = 'model-router'
const MODES: readonly Mode[] = ['recommend', 'auto', 'off']
const STORE_KEY = 'mode'
// The mods' shared palette: teal for the main action, slate for the rest, blue for a wait.
const TEAL = '#20a39a'
const SLATE = '#64748b'
const BLUE = '#4a90d9'

const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'recommend' as Mode)
const pick = atom({ plugin: 'model-router', key: 'pick' } as const, null as Pick | null)
const isPickCurrent = atom({ plugin: 'model-router', key: 'isPickCurrent' } as const, false)
const isThinking = atom({ plugin: 'model-router', key: 'isThinking' } as const, false)
const applyNext = atom({ plugin: 'model-router', key: 'applyNext' } as const, false)
const keepText = atom({ plugin: 'model-router', key: 'keepText' } as const, null as string | null)
const routed = atom({ plugin: 'model-router', key: 'routed' } as const, null as Pick | null)
const hold = atom({ plugin: 'model-router', key: 'hold' } as const, null as Hold | null)
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as Active | null)

// How a turn is routed: `pick` resolves to the setting, applied only when `apply`.
// `isHeld`: auto mode, and the pick was not on screen when the prompt was sent.
type Plan = { apply: boolean; pick: Promise<Pick | null>; isHeld: boolean }

const cache = new Map<string, Promise<Pick | null>>()
const plans = new Map<string, Plan>()
let lastPlan: Plan | null = null
let debounce: Timer | null = null
// What the person pressed during a hold, read by the held request.
let holdAnswer: 'override' | 'now' | null = null

// One Haiku call per distinct text; a failure resolves null and is not cached.
export const classify = ($: EngineInterface, text: string): Promise<Pick | null> => {
  const hit = cache.get(text)
  if (hit) return hit
  const asked = $.model
    .complete({
      model: CLASSIFIER,
      system: [{ text: SYSTEM_PROMPT, cache: true }],
      prompt: classifierPrompt(text),
      maxTokens: 120,
      effort: 'low',
      timeoutMs: TIMEOUT_MS,
    })
    .then(
      r => (r.isAnswered ? parsePick(text, r.text) : null),
      () => null,
    )
    .then(p => {
      if (p === null) cache.delete(text)
      return p
    })
  cache.set(text, asked)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
  return asked
}

// Sizes up the draft once typing pauses, so the band can recommend before sending.
export const recommend = async ($: EngineInterface, text: string) => {
  await update($, isThinking, () => true)
  const p = await classify($, text)
  await update($, isThinking, () => false)
  if (p === null || (await $.prompt.read()).text !== text) return
  await update($, pick, () => p)
  await update($, isPickCurrent, () => true)
}

// Never throws: typing must not depend on the band's bookkeeping.
export const trackDraft = async ($: EngineInterface, text: string) => {
  try {
    debounce?.cancel()
    debounce = null
    const current = await read($, pick)
    if ((await read($, isPickCurrent)) && current?.text !== text) await update($, isPickCurrent, () => false)
    if (text.trim() === '') {
      if (await read($, applyNext)) await update($, applyNext, () => false)
      if ((await read($, keepText)) !== null) await update($, keepText, () => null)
    }
    if ((await read($, mode)) === 'off' || !isRoutable(text)) return
    if (current?.text === text) {
      await update($, isPickCurrent, () => true)
      return
    }
    debounce = $.clock.after(DEBOUNCE_MS, () => void recommend($, text).catch(() => {}))
  } catch {}
}

// Takes effect from the next prompt: a running turn keeps its model, and so its prompt cache.
export const setMode = async ($: EngineInterface, next: Mode) => {
  if (next !== 'auto' && (await read($, hold)) !== null) holdAnswer = 'override'
  await update($, mode, () => next)
  await $.store.set(STORE_KEY, next).catch(() => {})
  await update($, applyNext, () => false)
  await update($, keepText, () => null)
  if (next !== 'auto') $.ui.status(undefined)
}

// Use: send the next prompt on the pick.
export const useNext = async ($: EngineInterface) => {
  await update($, keepText, () => null)
  await update($, applyNext, () => true)
}

// Keep current (recommend) or Override (auto): send this draft on the session's own model.
export const keepCurrent = async ($: EngineInterface, text: string) => {
  await update($, applyNext, () => false)
  await update($, keepText, () => text)
}

// Counts down in the band; resolves what the person pressed, or 'now' when time runs out.
// A generator so turn.step can `yield*` it without yielding anything.
export async function* holdFor($: EngineInterface, chosen: Pick, signal: AbortSignal): AsyncGenerator<never, 'override' | 'now'> {
  holdAnswer = null
  try {
    for (let waited = 0; waited < HOLD_MS && holdAnswer === null; waited += HOLD_TICK_MS) {
      const secondsLeft = Math.ceil((HOLD_MS - waited) / 1000)
      if ((await read($, hold))?.secondsLeft !== secondsLeft) await update($, hold, () => ({ pick: chosen, secondsLeft }))
      await $.clock.sleep(HOLD_TICK_MS, { signal })
    }
    return holdAnswer ?? 'now'
  } catch {
    return 'now'
  } finally {
    holdAnswer = null
    await update($, hold, () => null).catch(() => {})
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    if (MODES.includes(saved as Mode)) await update($, mode, () => saved as Mode)
    if ((await read($, active)) === null) {
      const model = await $.session.model().catch(() => '')
      if (model) await update($, active, () => ({ model }))
    }
    await $.command
      .register({
        name: COMMAND,
        description: 'Model routing: recommend (default), auto or off',
        argumentHint: 'recommend | auto | off',
      })
      .catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    // With no argument it toggles auto, so leaving auto is one short command.
    const next: Mode | undefined = MODES.includes(asked as Mode)
      ? (asked as Mode)
      : asked === ''
        ? (await read($, mode)) === 'auto' ? 'recommend' : 'auto'
        : undefined
    if (next === undefined) {
      $.ui.toast(`Model router is ${await read($, mode)}. /${COMMAND} recommend | auto | off`)
      return {}
    }
    await setMode($, next)
    $.ui.toast(
      next === 'auto'
        ? 'Model router: auto. Each prompt runs on its pick; Override or Exit auto in the band.'
        : next === 'off'
          ? 'Model router: off.'
          : 'Model router: recommend. Press Use in the band to apply a pick.',
    )
    return {}
  })

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    await trackDraft($, result.text)
    return result
  })

  on('prompt.fill', async ($, e, next) => {
    const result = await next(e)
    if (result.isFilled) await trackDraft($, (await $.prompt.read()).text)
    return result
  })

  // Plans the turn before its first request. A continuation or slash-command turn keeps the last plan.
  on('turn.start', async ($, e, next) => {
    try {
      const current = await read($, mode)
      if (current === 'off') {
        lastPlan = null
      } else if (isRoutable(e.text)) {
        const isKept = (await read($, keepText)) === e.text
        const apply = !isKept && (current === 'auto' || (await read($, applyNext)))
        const wasShown = (await read($, pick))?.text === e.text
        lastPlan = { apply, pick: classify($, e.text), isHeld: current === 'auto' && apply && !wasShown }
        await update($, applyNext, () => false)
        await update($, keepText, () => null)
      }
      if (lastPlan) plans.set(e.turnId, lastPlan)
      if (plans.size > MAX_CACHED) plans.delete(plans.keys().next().value as string)
    } catch {}
    return next(e)
  })

  // Rewrites the main loop's requests; subagents keep their own model.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const was = await read($, active).catch(() => null)
    if (was?.model !== e.model || was?.effort !== e.effort) {
      await update($, active, () => ({ model: e.model, effort: e.effort === undefined ? undefined : String(e.effort) })).catch(() => {})
    }

    const plan = plans.get(e.turnId)
    const chosen = plan?.apply ? await plan.pick.catch(() => null) : null
    if (chosen === null || !plan) return yield* next(e)

    // Sent before its pick showed: hold the first request so the person can still override.
    if (plan.isHeld && e.index === 0 && !matches(chosen, e.model, e.effort === undefined ? undefined : String(e.effort))) {
      const isOverridden = (yield* holdFor($, chosen, next.signal)) === 'override'
      const settled = { ...plan, isHeld: false, apply: !isOverridden }
      plans.set(e.turnId, settled)
      if (lastPlan === plan) lastPlan = settled
      if (isOverridden) return yield* next(e)
    }

    if ((await read($, mode).catch(() => 'recommend')) === 'auto') {
      $.ui.status(`⇢ ${label(chosen.model, chosen.effort)} (auto)`)
      if (e.index === 0) await update($, routed, () => chosen).catch(() => {})
    }
    return yield* next({ ...e, model: MODEL_IDS[chosen.model], effort: chosen.effort })
  })

  // A row above whatever else draws there (another mod's band included).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const current = await read($, mode)
    if (e.props.hasSurvey || current === 'off') return below

    const p = await read($, pick)
    const draftPick = (await read($, isPickCurrent)) && p ? p : null
    const thinking = await read($, isThinking)
    const held = await read($, hold)
    // Recommend mode stays out of the way with nothing to recommend; auto always shows its way out.
    if (current === 'recommend' && !draftPick && !thinking && !held) return below

    const now = await read($, active)
    const nowLabel = now ? activeLabel(now.model, now.effort) : 'your current model'
    const fits = draftPick !== null && now !== null && matches(draftPick, now.model, now.effort)
    const isKept = draftPick !== null && (await read($, keepText)) === draftPick.text
    const isApplied = await read($, applyNext)
    const lastRouted = await read($, routed)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Keys never shrink: the hint wraps into what room is left instead.
    const key = (border: string, child: RenderElement) => (
      <Box borderStyle="round" borderColor={border} paddingX={1} flexShrink={0}>
        {child}
      </Box>
    )
    const row = (...children: RenderElement[]) => (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {children}
        </Box>
        {below}
      </Box>
    )
    // Centered beside the keys on one line; wrapped, it starts at their top edge and grows downward.
    // `keys` and `lead` are what's drawn before it, for the estimate of whether it wraps.
    const hint = (text: string, keys: readonly string[], lead = '') => (
      <Box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        alignSelf={hintWraps(text, e.props.bodyColumns, keys, lead) ? 'flex-start' : 'center'}
      >
        <Text dimColor wrap="wrap">{text}</Text>
      </Box>
    )
    const exitAuto = key(SLATE, (
      <Button key="exit-auto" plain onPress={() => setMode($, 'recommend')}>
        <Text>Exit auto</Text>
      </Button>
    ))
    const unkeep = key(SLATE, (
      <Button key="unkeep" plain onPress={() => update($, keepText, () => null)}>
        <Text>↶</Text>
      </Button>
    ))
    const keep = (text: string, name: string) =>
      key(SLATE, (
        <Button key="keep" plain onPress={() => keepCurrent($, text)}>
          <Text>{name}</Text>
        </Button>
      ))

    if (held) {
      const sending = `⏸ Sending on ${label(held.pick.model, held.pick.effort)} in ${held.secondsLeft}s`
      return row(
        key(BLUE, <Text bold color={BLUE}>{sending}</Text>),
        key(SLATE, (
          <Button key="hold-override" plain onPress={() => { holdAnswer = 'override' }}>
            <Text>Override</Text>
          </Button>
        )),
        key(TEAL, (
          <Button key="hold-now" plain onPress={() => { holdAnswer = 'now' }}>
            <Text bold color={TEAL}>Send now</Text>
          </Button>
        )),
        exitAuto,
        hint(`${held.pick.reason} · Override sends on ${nowLabel}`, [sending, 'Override', 'Send now', 'Exit auto']),
      )
    }

    if (current === 'auto') {
      if (!draftPick && thinking) return row(<Text color={BLUE}>⇢ auto · sizing up this prompt…</Text>, exitAuto)
      if (!draftPick) {
        const last = lastRouted ? ` · last prompt ran on ${label(lastRouted.model, lastRouted.effort)}` : ''
        return row(<Text dimColor>⇢ auto routing on{last}</Text>, exitAuto)
      }
      if (fits) return row(<Text dimColor>✓ auto · {nowLabel} fits: {draftPick.reason}</Text>, exitAuto)
      if (isKept) {
        const keeping = `✓ Keeping ${nowLabel}`
        return row(<Text>{keeping}</Text>, unkeep, exitAuto, hint('overridden for this prompt', ['↶', 'Exit auto'], keeping))
      }
      const routing = `⇢ Auto: ${label(draftPick.model, draftPick.effort)}`
      return row(
        key(TEAL, <Text bold color={TEAL}>{routing}</Text>),
        keep(draftPick.text, 'Override'),
        exitAuto,
        hint(`${draftPick.reason} · Override keeps ${nowLabel}`, [routing, 'Override', 'Exit auto']),
      )
    }

    if (!draftPick) return row(<Text color={BLUE} dimColor>⇢ sizing up this prompt…</Text>)
    if (fits) return row(<Text dimColor>✓ {nowLabel} fits: {draftPick.reason}</Text>)
    if (isKept) {
      const keeping = `✓ Keeping ${nowLabel}`
      return row(<Text dimColor>{keeping}</Text>, unkeep, hint('pick dismissed for this prompt', ['↶'], keeping))
    }
    const choice = isApplied
      ? `✓ ${label(draftPick.model, draftPick.effort)} ↶`
      : `⇢ Use ${label(draftPick.model, draftPick.effort)}`
    return row(
      isApplied
        ? key(TEAL, (
            <Button key="undo" plain onPress={() => update($, applyNext, () => false)}>
              <Text bold color={TEAL}>{choice}</Text>
            </Button>
          ))
        : key(TEAL, (
            <Button key="use" plain onPress={() => useNext($)}>
              <Text bold color={TEAL}>{choice}</Text>
            </Button>
          )),
      keep(draftPick.text, 'Keep current'),
      key(SLATE, (
        <Button key="auto" plain onPress={() => setMode($, 'auto')}>
          <Text>Auto</Text>
        </Button>
      )),
      hint(isApplied ? `${draftPick.reason} · sends on it` : `${draftPick.reason} · you're on ${nowLabel}`, [choice, 'Keep current', 'Auto']),
    )
  })
}
