export type Status = 'idle' | 'enhancing'

declare module 'claude-code' {
  interface PluginState {
    'prompt-sharpener': {
      status: Status
      original: string | null
      hasDraft: boolean
      // The clarifying questions waiting for answers; empty when none are.
      questions: string[]
      // The draft the questions are about, held while the box is free for the answers.
      pending: string | null
    }
  }
}
