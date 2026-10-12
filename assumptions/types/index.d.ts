export type Verdict = 'pending' | 'right' | 'wrong'

export type Assumption = {
  id: string
  text: string
  verdict: Verdict
  correction: string
  isSent: boolean
  // Set while the assumption sits in the archive; cleared on restore.
  archivedAt?: number
}

export type View = 'active' | 'archived'

declare module 'claude-code' {
  interface PluginState {
    assumptions: {
      list: Assumption[]
      archive: Assumption[]
      view: View
      editing: string | null
      isConfirmingDelete: boolean
    }
  }
}
