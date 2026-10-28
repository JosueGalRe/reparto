import type { Plugin } from '@opencode/plugin'
import type { PermissionEvaluation } from '@opencode/plugin/promise/permission'

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>

export interface ContextoHija {
  readonly session: {
    readonly get: (entrada: { sessionID: string }) => Promise<Pick<Sesion, 'parentID' | 'agent' | 'model'>>
    readonly switchModel: (entrada: Parameters<Plugin.Context['session']['switchModel']>[0]) => Promise<unknown>
  }
  readonly storage: Pick<Plugin.Context['storage'], 'get' | 'set'>
}

export interface ContextoPrimaria {
  readonly session: {
    readonly get: (entrada: { sessionID: string }) => Promise<Pick<Sesion, 'parentID' | 'agent' | 'model' | 'metadata'>>
    readonly switchModel: ContextoHija['session']['switchModel']
  }
  readonly storage: ContextoHija['storage']
}

export interface LlamadaTool {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
}

export interface EvaluacionSubagent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: PermissionEvaluation['effect']
  message?: string
}
