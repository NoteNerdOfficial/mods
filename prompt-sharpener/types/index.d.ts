export type Status = 'idle' | 'enhancing'

declare module 'claude-code' {
  interface PluginState {
    'prompt-sharpener': { status: Status; original: string | null; hasDraft: boolean }
  }
}
