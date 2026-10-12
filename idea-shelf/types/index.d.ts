export type Idea = { id: string; text: string; createdAt: number }

declare module 'claude-code' {
  interface PluginState {
    'idea-shelf': { ideas: Idea[] }
  }
}
