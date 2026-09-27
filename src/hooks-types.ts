import type { Plugin } from '@opencode/plugin'
import type { PermissionEvaluation } from '@opencode/plugin/promise/permission'

type EventoSdk = ReturnType<Plugin.Context['event']['subscribe']> extends AsyncIterable<infer Evento> ? Evento : never
type EventoSesion =
  | {
      readonly type: 'session.execution.succeeded' | 'session.execution.interrupted'
      readonly data: { readonly sessionID: string }
    }
  | {
      readonly type: 'session.execution.failed'
      readonly data: { readonly sessionID: string; readonly error?: { readonly message?: string } }
    }
  | {
      readonly type: 'permission.asked'
      readonly data: {
        readonly sessionID: string
        readonly id: string
        readonly action?: string
        readonly resources?: readonly string[]
      }
    }
  | {
      readonly type: 'permission.replied'
      readonly data: { readonly sessionID: string; readonly requestID: string }
    }

export type Evento = { readonly created?: number } & (
  | EventoSesion
  | { readonly type: Exclude<EventoSdk['type'], EventoSesion['type']>; readonly data?: object }
)

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>

export interface ContextoHija {
  readonly session: {
    readonly get: (entrada: { sessionID: string }) => Promise<Pick<Sesion, 'parentID' | 'agent' | 'model'>>
    readonly switchModel: (entrada: Parameters<Plugin.Context['session']['switchModel']>[0]) => Promise<unknown>
  }
}

export interface EvaluacionSubagent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: PermissionEvaluation['effect']
  message?: string
}
