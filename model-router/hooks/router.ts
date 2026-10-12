import type { Effort, ModelKey, Pick } from '../types'

export const MODEL_IDS: Record<ModelKey, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

export const MODEL_NAMES: Record<ModelKey, string> = {
  fable: 'Fable 5.1',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 5.5',
}

const MODELS = Object.keys(MODEL_IDS) as ModelKey[]
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The balanced default when the classifier is unsure or unreadable.
export const FALLBACK = { model: 'sonnet', effort: 'medium' } as const

export const SYSTEM_PROMPT = `You route a coding assistant's next task to the right model and reasoning effort.
Read the user's prompt and pick the cheapest setting that will still do the job well. Bias: balanced.

Models, cheapest first:
- haiku: trivial or mechanical work. Quick factual questions, renames, formatting, a one-line fix, a shell or git one-liner, reading a file back.
- sonnet: everyday engineering. Implement a feature across a few files, write tests, fix a bug with a clear cause, explain code, write docs, small refactors.
- opus: hard work. Debugging with an unclear cause, multi-file or cross-cutting refactors, architecture and design choices, security or performance review, ambiguous specs that need judgement.
- fable: the hardest work. Novel algorithms, subtle concurrency or correctness, deep investigation across a large codebase, long autonomous multi-step builds where mistakes are expensive.

Effort: low (no real thinking needed), medium (some planning), high (careful multi-step reasoning), xhigh (very hard, worth the wait). Use max almost never.
Typical pairs: haiku+low, sonnet+medium, sonnet+high, opus+high, fable+high, fable+xhigh.
When unsure, answer sonnet+medium.

Answer with one line of JSON and nothing else:
{"model":"haiku|sonnet|opus|fable","effort":"low|medium|high|xhigh|max","reason":"<at most 6 words on the kind of work>"}`

export const classifierPrompt = (text: string) =>
  `<prompt>\n${text.length > 6000 ? `${text.slice(0, 6000)}\n[...truncated]` : text}\n</prompt>`

// Reads the classifier's reply; anything unreadable falls back to the balanced default.
export const parsePick = (text: string, reply: string): Pick => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  let raw: Record<string, unknown> = {}
  try {
    raw = json ? JSON.parse(json) : {}
  } catch {}
  const model = MODELS.includes(raw.model as ModelKey) ? (raw.model as ModelKey) : FALLBACK.model
  const effort = EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : FALLBACK.effort
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 60) : ''
  return { text, model, effort, reason: reason || 'general task' }
}

// 'claude-opus-5-5', 'opus', 'opus[1m]' → 'opus'.
export const modelKeyOf = (id: string): ModelKey | undefined => MODELS.find(key => id.toLowerCase().includes(key))

export const label = (model: ModelKey, effort?: string) =>
  effort ? `${MODEL_NAMES[model]} · ${effort}` : MODEL_NAMES[model]

export const activeLabel = (model: string, effort?: string) => {
  const key = modelKeyOf(model)
  const name = key ? MODEL_NAMES[key] : model
  return effort ? `${name} · ${effort}` : name
}

// Whether the pick is what the main loop already runs on (effort compared only when known).
export const matches = (pick: Pick, model: string, effort?: string) =>
  modelKeyOf(model) === pick.model && (effort === undefined || effort === pick.effort)

// A key's border and padding, each one cell a side.
const KEY_FRAME = 4

const cells = (text: string) => [...text].length

// Whether the hint will wrap after the items before it: `keys` are the boxed labels,
// `lead` any plain text ahead of them. An estimate, as flexbox can't report wrapping.
export const hintWraps = (hint: string, columns: number, keys: readonly string[], lead = '') => {
  const items = keys.length + (lead ? 1 : 0)
  const used = keys.reduce((sum, k) => sum + cells(k) + KEY_FRAME, cells(lead)) + items // a 1-cell gap after each
  return cells(hint) > columns - used
}

export const isRoutable = (text: string) => {
  const t = text.trim()
  return t.length >= 8 && !t.startsWith('/') && !t.startsWith('!')
}
