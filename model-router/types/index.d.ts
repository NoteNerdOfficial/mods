export type Mode = 'recommend' | 'auto' | 'off'
export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// One recommendation, for the exact text it was made from.
export type Pick = { text: string; model: ModelKey; effort: Effort; reason: string }

// A routed prompt held after Enter, counting down to sending on the pick.
export type Hold = { pick: Pick; secondsLeft: number }

// What the main loop last ran on, as the engine sent it.
export type Active = { model: string; effort?: string }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      mode: Mode
      pick: Pick | null
      isPickCurrent: boolean
      isThinking: boolean
      // The person pressed Use: route the next prompt they send (recommend mode).
      applyNext: boolean
      // The draft the person chose to send on their current model (Keep current, or Override in auto).
      keepText: string | null
      // What auto mode last routed a turn to.
      routed: Pick | null
      hold: Hold | null
      active: Active | null
    }
  }
}
