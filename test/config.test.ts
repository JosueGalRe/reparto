import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, expect, test } from 'bun:test'

import { configPath, loadConfig, plazoMs } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-config-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function load(text: string) {
  const path = join(dir, `${crypto.randomUUID()}.jsonc`)

  writeFileSync(path, text)

  return loadConfig(path)
}

test('acepta JSONC con comentarios y comas finales', async () => {
  const result = await load(`{
    // Solista
    "agentes": { "build": { "titular": { "model": "claude-code/claude-opus-5-5", "variant": "high" }, "suplentes": [{ "model": "openai/gpt-5.5" },] } },
    "proveedores": { "claude-code": { "concurrencia": 2, "plazoBaja": "5h" } },
  }`)

  expect(result).toHaveProperty('config.agentes.build.titular.variant', 'high')
  expect(result).toHaveProperty('config.proveedores.claude-code.concurrencia', 2)
})

test('agentes acepta cualquier nombre; papeles ya no existe', async () => {
  expect(
    await load(`{ "agentes": { "plan": { "titular": { "model": "a/b" } }, "sisyphus": { "titular": { "model": "a/b" } } } }`),
  ).toHaveProperty('config')
  expect(await load(`{ "agentes": { "plan": { "suplentes": [] } } }`)).toHaveProperty('error')
  expect(await load(`{ "papeles": { "rapido": { "titular": { "model": "a/b" } } } }`)).toHaveProperty('error')
})

test('plazoMs', () => {
  expect([plazoMs('30m'), plazoMs('5h'), plazoMs('7d')]).toEqual([1_800_000, 18_000_000, 604_800_000])
})

test.each(['1w', '30', ''])('plazoMs rechaza una unidad inválida: %s', (plazo) => {
  // Given: un plazo sin unidad soportada; When: se convierte; Then: falla en vez de devolver NaN.
  expect(() => plazoMs(plazo)).toThrow(/plazoMs: unidad inválida/)
})

test.each([
  [`{ "agentes": { "director": { "suplentes": [] } } }`, `agentes.director: falta "titular"`],
  [`{ "papeles": { "quick": { "titular": { "model": "a/b" } } } }`, 'papeles: clave desconocida'],
  [`{ "agentes": { "general": { "titular": { "model": "kimi-k3" } } } }`, 'agentes.general.titular.model'],
  [
    `{ "agentes": { "general": { "titular": { "model": "a/b", "reasoning": "low" } } } }`,
    'agentes.general.titular.reasoning: clave desconocida',
  ],
  [
    `{ "agentes": { "general": { "titular": { "model": "a/b" }, "suplentes": {} } } }`,
    'agentes.general.suplentes: se esperaba una lista',
  ],
  [`{ "proveedores": { "openai": { "concurrencia": 0 } } }`, 'proveedores.openai.concurrencia: menor que 1'],
  [`{ "proveedores": { "openai": { "plazoBaja": 10080 } } }`, 'proveedores.openai.plazoBaja: se esperaba un texto'],
  [`{ "proveedores": { "openai": { "plazoBaja": "1w" } } }`, 'proveedores.openai.plazoBaja: "1w" no cumple'],
  [`[]`, '(raíz): se esperaba un objeto'],
])('rechaza estructura rota: %s', async (text, message) => {
  const result = await load(text)

  expect('error' in result && result.error).toContain(message)
})

test('JSONC inválido y archivo ausente dan error, no lanzan', async () => {
  expect(await load(`{ "agentes": `)).toHaveProperty('error')
  expect(await loadConfig(join(dir, 'no-existe.jsonc'))).toEqual({ error: `no existe ${join(dir, 'no-existe.jsonc')}` })
})

test('ruta: options.config con ~ o el default', () => {
  expect(configPath({ config: '~/x.jsonc' })).toBe(join(process.env.HOME!, 'x.jsonc'))
  expect(configPath({})).toBe(join(process.env.HOME!, '.config/opencode/reparto.jsonc'))
})
