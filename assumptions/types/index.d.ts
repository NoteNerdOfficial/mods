export type Verdict = 'pending' | 'right' | 'wrong'

export type Assumption = {
  id: string
  text: string
  verdict: Verdict
  correction: string
  isSent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    assumptions: { list: Assumption[]; editing: string | null }
  }
}
