import type { Plugin } from '@opencode/plugin'
import type { PermissionEvaluation } from '@opencode/plugin/promise/permission'

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
