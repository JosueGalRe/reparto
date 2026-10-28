import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'

import { publicar, validacionLista } from '../src/actores.ts'
import { registrarBaja } from '../src/bajas.ts'
import { openDb } from '../src/db.ts'
import { anotarPedido, evaluarSubagent, imponerHija, imponerPrimaria } from '../src/hooks.ts'
import { proceso } from '../src/process.ts'

import type { Config } from '../src/config.ts'
import type { ContextoHija, ContextoPrimaria, EvaluacionSubagent } from '../src/hooks-types.ts'

function almacen(): ContextoHija['storage'] {
  const datos = new Map<string, Parameters<ContextoHija['storage']['set']>[1]>()

  return {
    get: async (key) => datos.get(key),
    set: async (key, value) => {
      datos.set(key, value)
    },
  }
}

const dir = mkdtempSync(join(tmpdir(), 'reparto-hijas-'))
const config: Config = {
  agentes: {
    general: { titular: { model: 'luna/a', variant: 'low' }, suplentes: [{ model: 'other/b' }] },
    explore: { titular: { model: 'nadie/nada' } },
  },
}

beforeAll(() => {
  proceso.db = openDb(join(dir, 'hijas.db'))
  proceso.validacion = {
    actores: new Map([['general', [{ model: 'luna/a', variant: 'low' }, { model: 'other/b' }]]]),
    exclusiones: [],
    desactivados: ['explore'],
    desconocidos: [],
  }
})
afterAll(() => {
  proceso.db?.close()
  proceso.db = undefined
  proceso.validacion = undefined
  rmSync(dir, { recursive: true, force: true })
})

test('native child takes its configured actor on first and continued turns, including a baja', async () => {
  // Given: a native child inheriting the parent's model.
  const session: { parentID: string; agent: string; model: { providerID: string; id: string; variant?: string } } = {
    parentID: 'ses_parent',
    agent: 'general',
    model: { providerID: 'other', id: 'parent' },
  }
  const switched: unknown[] = []
  const ctx = {
    session: {
      get: async () => session,
      switchModel: async (input: { model: typeof session.model }) => {
        switched.push(input.model)
        session.model = input.model
      },
    },
    storage: almacen(),
  }

  // When: its first prompt and continued prompt arrive.
  expect(await imponerHija(ctx, config, 'ses_child')).toBe(true)
  expect(await imponerHija(ctx, config, 'ses_child')).toBe(true)
  // Then: the first actor includes the variant, and no redundant switch occurs.
  expect(switched).toEqual([{ providerID: 'luna', id: 'a', variant: 'low' }])

  // Given: the titular's provider goes on baja; When: the next turn arrives.
  registrarBaja(proceso.db!, { tipo: 'proveedor', id: 'luna', motivo: 'cuota', hasta: Date.now() + 60_000 })
  // Then: the suplente is selected for the continued turn.
  expect(await imponerHija(ctx, config, 'ses_child')).toBe(true)
  expect(switched).toEqual([
    { providerID: 'luna', id: 'a', variant: 'low' },
    { providerID: 'other', id: 'b' },
  ])
  proceso.db!.query('DELETE FROM bajas').run()
})

test('native child keeps the model its subagent call asked for, even with every actor on baja', async () => {
  // Given: a subagent call to general with an explicit model, one with an empty model, and every actor on baja.
  anotarPedido(
    { tool: 'subagent', sessionID: 'ses_parent', id: 'call_1', input: { agent: 'general', model: 'kimi/k3#high' } },
    config,
  )
  anotarPedido({ tool: 'subagent', sessionID: 'ses_parent', id: 'call_2', input: { agent: 'general', model: '' } }, config)
  registrarBaja(proceso.db!, { tipo: 'proveedor', id: 'luna', motivo: 'cuota', hasta: Date.now() + 60_000 })
  registrarBaja(proceso.db!, { tipo: 'proveedor', id: 'other', motivo: 'cuota', hasta: Date.now() + 60_000 })
  const permiso: EvaluacionSubagent = { action: 'subagent', effect: 'allow', sessionID: 'ses_parent', resources: ['general'] }

  // When: the call is evaluated; Then: it passes, and only the explicit model was recorded.
  evaluarSubagent(permiso, config)
  expect(permiso.effect).toBe('allow')
  expect([...(proceso.pedidos?.keys() ?? [])]).toEqual(['call_1'])
  proceso.db!.query('DELETE FROM bajas').run()

  // Given: the child V2 created with that model, and a sibling that inherited the parent's.
  const switched: unknown[] = []
  const ctx = (model: { providerID: string; id: string; variant?: string }): ContextoHija => ({
    session: {
      get: async () => ({ parentID: 'ses_parent', agent: 'general', model }),
      switchModel: async (input) => void switched.push(input.model),
    },
    storage: almacen(),
  })
  const pedida = ctx({ providerID: 'kimi', id: 'k3', variant: 'high' })

  // When: the child prompts twice and the sibling once.
  expect(await imponerHija(pedida, config, 'ses_pedida')).toBe(true)
  expect(await imponerHija(pedida, config, 'ses_pedida')).toBe(true)
  expect(await imponerHija(ctx({ providerID: 'kimi', id: 'k3', variant: 'high' }), config, 'ses_hermana')).toBe(true)
  // Then: the asked-for child is never switched; the sibling, with the pedido already consumed, takes the titular.
  expect(switched).toEqual([{ providerID: 'luna', id: 'a', variant: 'low' }])
  proceso.pedidos?.clear()
})

test('primary session keeps the model the client chose; without one it takes the actor once', async () => {
  // Given: a primary session whose first prompt arrives with a model chosen in the client.
  const session: { agent: string; model?: { providerID: string; id: string; variant?: string } } = {
    agent: 'general',
    model: { providerID: 'other', id: 'elegido' },
  }
  const switched: unknown[] = []
  const storage = new Map<string, Parameters<ContextoPrimaria['storage']['set']>[1]>()
  const ctx: ContextoPrimaria = {
    session: {
      get: async () => session,
      switchModel: async (input) => {
        switched.push(input.model)
        session.model = input.model
      },
    },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value)
      },
    },
  }

  // When: it prompts twice; Then: reparto leaves the chosen model alone.
  await imponerPrimaria(ctx, config, 'ses_elegido')
  await imponerPrimaria(ctx, config, 'ses_elegido')
  expect(switched).toEqual([])

  // Given: a session without a model; When: its first and continued prompts arrive.
  session.model = undefined
  await imponerPrimaria(ctx, config, 'ses_sin_modelo')
  await imponerPrimaria(ctx, config, 'ses_sin_modelo')
  // Then: the titular is imposed once and recorded.
  expect(switched).toEqual([{ providerID: 'luna', id: 'a', variant: 'low' }])
  expect(storage.get('impuesto/ses_sin_modelo/general')).toEqual({ actor: 'luna/a#low' })
})

test('subagent permission denies a target with all actors on baja', () => {
  // Given: both of general's actors are unavailable.
  registrarBaja(proceso.db!, { tipo: 'actor', id: 'luna/a#low', motivo: 'cuota', hasta: Date.now() + 60_000 })
  registrarBaja(proceso.db!, { tipo: 'actor', id: 'other/b', motivo: 'cuota', hasta: Date.now() + 60_000 })
  const input: EvaluacionSubagent = {
    action: 'subagent',
    effect: 'allow',
    agent: 'build',
    sessionID: 'ses_parent',
    resources: ['general'],
  }

  // When: native subagent evaluates permission; Then: it is denied with both bajas and deadlines.
  evaluarSubagent(input, config)
  expect(input.effect).toBe('deny')
  expect(input).toHaveProperty('message', expect.stringContaining('luna/a#low hasta '))
  expect(input).toHaveProperty('message', expect.stringContaining('other/b hasta '))
  proceso.db!.query('DELETE FROM bajas').run()
})

test('children without reparto keep the parent model; unconfigured subagent targets pass', async () => {
  // Given: a native child of an agent that is not in reparto.jsonc.
  const ctx = {
    session: {
      get: async () => ({ parentID: 'ses_parent', agent: 'tiresias', model: { providerID: 'parent', id: 'model' } }),
      switchModel: async () => {
        throw new Error('no debe cambiar el modelo')
      },
    },
    storage: almacen(),
  }
  const input: EvaluacionSubagent = { action: 'subagent', effect: 'allow', sessionID: 'ses_parent', resources: ['tiresias'] }

  // When/Then: reparto leaves both to V2.
  expect(await imponerHija(ctx, config, 'ses_child')).toBe(false)
  evaluarSubagent(input, config)
  expect(input.effect).toBe('allow')
})

test('subagent permission denies disabled or not-yet-validated reparto targets', () => {
  // Given: a disabled agent, then validation not yet published.
  const input: EvaluacionSubagent = {
    action: 'subagent',
    effect: 'allow',
    agent: 'build',
    sessionID: 'ses_parent',
    resources: ['explore'],
  }

  // When: native permission is checked; Then: the inherited parent model is never an implicit fallback.
  evaluarSubagent(input, config)
  expect(input.effect).toBe('deny')
  const saved = proceso.validacion

  proceso.validacion = undefined
  const pending: EvaluacionSubagent = { ...input, effect: 'allow' }

  evaluarSubagent(pending, config)
  expect(pending.effect).toBe('deny')
  expect(pending).toHaveProperty('message', expect.stringContaining('validación pendiente'))
  proceso.validacion = saved
})

test('native child fails closed if its actor is unavailable or switchModel fails', async () => {
  // Given: a child inheriting its parent's model.
  const ctx = {
    session: {
      get: async () => ({ parentID: 'ses_parent', agent: 'general', model: { providerID: 'parent', id: 'model' } }),
      switchModel: async () => {
        throw new Error('switch failed')
      },
    },
    storage: almacen(),
  }

  // When: V2 cannot switch the actor; Then: prompt rejects rather than using the inherited model.
  await expect(imponerHija(ctx, config, 'ses_failed')).rejects.toThrow('switch failed')
  const saved = proceso.validacion

  proceso.validacion = undefined
  proceso.validada = Promise.withResolvers()
  proceso.validada.resolve()
  await expect(imponerHija(ctx, config, 'ses_unvalidated')).rejects.toThrow('sin actor disponible')
  proceso.validacion = saved
  proceso.validada = undefined
})

test('the first prompt after a restart waits for the validation instead of skipping the actor', async () => {
  // Given: the validation is not published yet.
  const saved = proceso.validacion

  proceso.validacion = undefined
  proceso.validada = undefined
  const esperando = validacionLista()

  // When: it is published a moment later; Then: the waiting prompt gets it.
  publicar(saved!)
  expect(await esperando).toBe(saved)
  // And without a publication, the wait gives up at its cap.
  proceso.validacion = undefined
  proceso.validada = undefined
  expect(await validacionLista(10)).toBeUndefined()
  proceso.validacion = saved
})
