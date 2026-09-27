import type { Plugin } from '@opencode/plugin'

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>

export interface ContextoEstreno {
  readonly session: {
    get: (entrada: { sessionID: string }) => Promise<{ location: Pick<Sesion['location'], 'directory'> }>
    context: (entrada: { sessionID: string }) => Promise<readonly unknown[]>
    create: (entrada: Parameters<Plugin.Context['session']['create']>[0]) => Promise<{ id: string; title?: string }>
    prompt: (entrada: {
      sessionID: string
      text: string
      delivery: 'queue'
      metadata: Record<string, boolean>
    }) => Promise<unknown>
    switchAgent: (entrada: { sessionID: string; agent: string }) => Promise<unknown>
  }
}
