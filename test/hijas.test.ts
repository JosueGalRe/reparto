import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'

import { registrarBaja } from '../src/bajas.ts'
import { openDb } from '../src/db.ts'
import { evaluarSubagent, imponerHija } from '../src/index.ts'
import { proceso } from '../src/process.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-hijas-'))

beforeAll(() => {
  proceso.db = openDb(join(dir, 'hijas.db'))
  proceso.validacion = {
    actores: new Map([['rapido', [{ model: 'luna/a', variant: 'low' }, { model: 'other/b' }]]]),
    exclusiones: [],
    desactivados: [],
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
    agent: 'rapido',
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
  }

  // When: its first prompt and continued prompt arrive.
  expect(await imponerHija(ctx as never, 'ses_child')).toBe(true)
  expect(await imponerHija(ctx as never, 'ses_child')).toBe(true)
  // Then: the first actor includes the variant, and no redundant switch occurs.
  expect(switched).toEqual([{ providerID: 'luna', id: 'a', variant: 'low' }])

  // Given: the titular's provider goes on baja; When: the next turn arrives.
  registrarBaja(proceso.db!, { tipo: 'proveedor', id: 'luna', motivo: 'cuota', hasta: Date.now() + 60_000 })
  // Then: the suplente is selected for the continued turn.
  expect(await imponerHija(ctx as never, 'ses_child')).toBe(true)
  expect(switched).toEqual([
    { providerID: 'luna', id: 'a', variant: 'low' },
    { providerID: 'other', id: 'b' },
  ])
  proceso.db!.query('DELETE FROM bajas').run()
})

test('subagent permission denies a target with all actors on baja', () => {
  // Given: both of rapido's actors are unavailable.
  registrarBaja(proceso.db!, { tipo: 'actor', id: 'luna/a#low', motivo: 'cuota', hasta: Date.now() + 60_000 })
  registrarBaja(proceso.db!, { tipo: 'actor', id: 'other/b', motivo: 'cuota', hasta: Date.now() + 60_000 })
  const input = { action: 'subagent', effect: 'allow', agent: 'director', sessionID: 'ses_parent', resources: ['rapido'] }

  // When: native subagent evaluates permission; Then: it is denied with both bajas and deadlines.
  evaluarSubagent(input as never)
  expect(input.effect).toBe('deny')
  expect(input).toHaveProperty('message', expect.stringContaining('luna/a#low hasta '))
  expect(input).toHaveProperty('message', expect.stringContaining('other/b hasta '))
  proceso.db!.query('DELETE FROM bajas').run()
})

test('regidor without estreno cannot launch a native subagent', () => {
  // Given: no estreno for the regidor session.
  const input = { action: 'subagent', effect: 'allow', agent: 'regidor', sessionID: 'ses_unapproved', resources: ['rapido'] }

  // When: native permission is evaluated; Then: it points to the estreno command.
  evaluarSubagent(input as never)
  expect(input.effect).toBe('deny')
  expect(input).toHaveProperty('message', expect.stringContaining('/estreno <plan>'))
})

test('subagent permission denies disabled or not-yet-validated reparto targets', () => {
  // Given: a disabled papel, then validation not yet published.
  const input = { action: 'subagent', effect: 'allow', agent: 'director', sessionID: 'ses_parent', resources: ['visual'] }

  // When: native permission is checked; Then: the inherited parent model is never an implicit fallback.
  evaluarSubagent(input as never)
  expect(input.effect).toBe('deny')
  const saved = proceso.validacion

  proceso.validacion = undefined
  const pending = { ...input, effect: 'allow' }

  evaluarSubagent(pending as never)
  expect(pending.effect).toBe('deny')
  expect(pending).toHaveProperty('message', expect.stringContaining('validación pendiente'))
  proceso.validacion = saved
})

test('native child fails closed if its actor is unavailable or switchModel fails', async () => {
  // Given: a child inheriting its parent's model.
  const ctx = {
    session: {
      get: async () => ({ parentID: 'ses_parent', agent: 'rapido', model: { providerID: 'parent', id: 'model' } }),
      switchModel: async () => {
        throw new Error('switch failed')
      },
    },
  }

  // When: V2 cannot switch the actor; Then: prompt rejects rather than using the inherited model.
  await expect(imponerHija(ctx as never, 'ses_failed')).rejects.toThrow('switch failed')
  expect(proceso.hijosNativos?.has('ses_failed')).toBe(false)
  const saved = proceso.validacion

  proceso.validacion = undefined
  await expect(imponerHija(ctx as never, 'ses_unvalidated')).rejects.toThrow('sin actor disponible')
  proceso.validacion = saved
})
