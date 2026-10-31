import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'

import { bajasVigentes, suplencias } from '../src/bajas.ts'
import { openDb } from '../src/db.ts'
import { proceso } from '../src/process.ts'

import type { Config } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-suplencias-'))
const config: Config = {
  agentes: {
    build: { titular: { model: 'kiro/claude-opus-5-5' }, suplentes: [{ model: 'github-copilot/claude-opus-5.5' }] },
  },
  proveedores: { kiro: { plazoAuth: '12h' } },
}
const cambios: unknown[] = []
const { retry } = suplencias({ session: { switchModel: async (input) => void cambios.push(input.model) } }, config)
const opus = { providerID: 'kiro', id: 'claude-opus-5-5', variant: 'xhigh' }
const reintento = (sessionID: string, attempt: number, model = opus) => ({
  sessionID,
  agent: 'build',
  model,
  error: { type: 'provider.auth', message: 'Kiro: Token refresh failed: 400' },
  attempt,
  decision: { retry: true as const, delay: 1000 },
})

beforeAll(() => {
  proceso.db = openDb(join(dir, 'suplencias.db'))
  proceso.validacion = {
    actores: new Map([['build', [{ model: 'kiro/claude-opus-5-5' }, { model: 'github-copilot/claude-opus-5.5' }]]]),
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

test('auth da de baja al proveedor por plazoAuth y entra el suplente de otro proveedor', async () => {
  // Given: el token de Kiro vencido en una sesión con el variant que eligió el cliente.
  const entrada = reintento('ses_auth', 2)
  const antes = Date.now()

  // When: llega el retry.
  await retry(entrada)

  // Then: Kiro queda de baja 12 h y el reintento sale ya con Copilot.
  const [kiro] = bajasVigentes(proceso.db!).filter((baja) => baja.id === 'kiro')

  expect(kiro?.hasta).toBeGreaterThanOrEqual(antes + 12 * 3_600_000)
  expect(kiro?.motivo).toStartWith('auth: ')
  expect(cambios.at(-1)).toEqual({ providerID: 'github-copilot', id: 'claude-opus-5.5' })
  expect(entrada.decision).toEqual({ retry: true, delay: 0 })
})
