import type { Plugin } from '@opencode/plugin'
import type { PermissionEvaluation } from '@opencode/plugin/promise/permission'

type EventoSdk = ReturnType<Plugin.Context['event']['subscribe']> extends AsyncIterable<infer Evento> ? Evento : never
type TipoConsumido =
  | 'session.execution.succeeded'
  | 'session.execution.interrupted'
  | 'session.execution.failed'
  | 'permission.asked'
  | 'permission.replied'

type Exito = Extract<EventoSdk, { type: 'session.execution.succeeded' }>
type Interrupcion = Extract<EventoSdk, { type: 'session.execution.interrupted' }>
type Fallo = Extract<EventoSdk, { type: 'session.execution.failed' }>
type PermisoPedido = Extract<EventoSdk, { type: 'permission.asked' }>
type PermisoRespondido = Extract<EventoSdk, { type: 'permission.replied' }>

type EventoConsumido =
  | (Pick<Exito, 'type' | 'created'> & { readonly data: Pick<Exito['data'], 'sessionID'> })
  | (Pick<Interrupcion, 'type' | 'created'> & { readonly data: Pick<Interrupcion['data'], 'sessionID'> })
  | (Pick<Fallo, 'type' | 'created'> & { readonly data: Pick<Fallo['data'], 'sessionID' | 'error'> })
  | (Pick<PermisoPedido, 'type' | 'created'> & {
      readonly data: Pick<PermisoPedido['data'], 'sessionID' | 'id' | 'action' | 'resources'>
    })
  | (Pick<PermisoRespondido, 'type' | 'created'> & {
      readonly data: Pick<PermisoRespondido['data'], 'sessionID' | 'requestID'>
    })

export type Evento =
  | EventoConsumido
  | { readonly type: Exclude<EventoSdk['type'], TipoConsumido>; readonly created?: number; readonly data?: object }

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>

export interface ContextoHija {
  readonly session: {
    readonly get: (entrada: { sessionID: string }) => Promise<Pick<Sesion, 'parentID' | 'agent' | 'model'>>
    readonly switchModel: (entrada: Parameters<Plugin.Context['session']['switchModel']>[0]) => Promise<unknown>
  }
}

export interface ContextoContinuacion {
  readonly session: {
    get: (entrada: { sessionID: string }) => Promise<{ agent?: string }>
    prompt: (entrada: {
      sessionID: string
      text: string
      delivery: 'queue'
      metadata: Record<string, boolean>
    }) => Promise<unknown>
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
