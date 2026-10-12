export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

export type Reading = {
  slices: Slice[]
  total: number // tokens in use
  window: number // the window measured against
  percent: number
  compactsAt?: number // where auto-compaction runs, when it is on
}

// The used rows of one owner: built in, your setup, or the conversation.
export type Group = { label: string; color: string; slices: Slice[]; tokens: number }

// One styled stretch of a line, drawn as a Text.
export type Run = { text: string; color?: string; bold?: boolean; dim?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { reading: Reading | null; isHidden: boolean }
  }
}
