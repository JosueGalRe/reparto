import type { Plugin } from '@opencode/plugin'

export type EstadoEncargo = 'en_cola' | 'corriendo' | 'terminado' | 'fallido' | 'interrumpido' | 'estancado'

export interface Encargo {
  id: number
  hija: string
  padre: string
  a: string
  actor: string
  estado: EstadoEncargo
  desde: number | null
  cerrado: number | null
  mensaje_final: string | null
  error: string | null
  creado: number
}

export type Cambios = Partial<Pick<Encargo, 'desde' | 'cerrado' | 'mensaje_final' | 'error'>>

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>
type Mensaje = Awaited<ReturnType<Plugin.Context['session']['context']>>[number]

export interface ContextoEncargos {
  readonly session: {
    get: (entrada: { sessionID: string }) => Promise<
      Pick<Sesion, 'parentID' | 'agent' | 'model' | 'outcome' | 'title' | 'metadata' | 'location'> & {
        readonly time: Pick<Sesion['time'], 'idle'>
      }
    >
    create: (entrada: Parameters<Plugin.Context['session']['create']>[0]) => Promise<{ id: string }>
    context: (entrada: { sessionID: string }) => Promise<
      readonly (
        | {
            readonly type: 'assistant'
            readonly content: readonly (
              | { readonly type: 'text'; readonly text: string }
              | { readonly type: 'reasoning' | 'tool' }
            )[]
          }
        | { readonly type: Exclude<Mensaje['type'], 'assistant'> }
      )[]
    >
    prompt: (entrada: Parameters<Plugin.Context['session']['prompt']>[0]) => Promise<unknown>
    wait: (entrada: Parameters<Plugin.Context['session']['wait']>[0]) => Promise<void>
    interrupt: (entrada: Parameters<Plugin.Context['session']['interrupt']>[0]) => Promise<unknown>
  }
}

export interface EntradaRevisor {
  readonly revisor: string
  readonly prompt: string
}

export interface HijaNativa {
  padre: string
  desde: number
  actividad: number
  avisado: boolean
  permisos: Set<string>
}
