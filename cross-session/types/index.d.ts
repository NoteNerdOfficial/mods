export type Entry = {
  id: string
  at: number
  dir: 'in' | 'out'
  // Who the message is from (in) or to (out).
  peer: string
  text: string
  // In: dropped by a mute. Out: not delivered.
  isBlocked: boolean
  // Out: how many secrets were redacted before sending.
  redacted: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cross-session': {
      log: Entry[]
      muted: string[]
      openId: string | null
      hasToasts: boolean
    }
  }
}
