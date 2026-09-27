import { expect, test } from 'bun:test'

import { resolver, validar } from '../src/actores.ts'

import type { Catalog } from '../src/catalog.ts'
import type { Config } from '../src/config.ts'

const catalog: Catalog = new Map([
  ['opencode-go/kimi-k3', { enabled: true, variants: ['max'] }],
  ['kimi-code-plan-global/k3', { enabled: true, variants: ['low', 'high', 'max'] }],
  ['openai/gpt-5.5', { enabled: true, variants: ['low', 'medium', 'high', 'xhigh'] }],
  ['openai/gpt-4o-legacy', { enabled: false, variants: [] }],
  ['opencode-go/qwen3.7-plus', { enabled: true, variants: [] }],
])

const config: Config = {
  agentes: {
    director: { titular: { model: 'openai/gpt-5.5', variant: 'xhigh' } },
    plan: { titular: { model: 'openai/gpt-5.5' } },
    sisyphus: { titular: { model: 'openai/gpt-5.5' } },
  },
  papeles: {
    rapido: {
      titular: { model: 'opencode-go/kimi-k3', variant: 'low' },
      suplentes: [{ model: 'kimi-code-plan-global/k3', variant: 'low' }],
    },
    visual: { titular: { model: 'openai/gpt-4o-legacy' }, suplentes: [{ model: 'openai/gpt-5.5', variant: 'high' }] },
    prosa: { titular: { model: 'opencode-go/qwen3.7-plus', variant: 'off' }, suplentes: [{ model: 'nadie/nada' }] },
    estelar: { titular: { model: 'opencode-go/qwen3.7-plus' } },
  },
}

const v = validar(config, catalog, ['build', 'plan', 'general'])

test('variant fuera del catálogo: excluido, y la resolución devuelve el siguiente actor', () => {
  expect(v.exclusiones).toContainEqual({
    nombre: 'rapido',
    tipo: 'papel',
    actor: 'opencode-go/kimi-k3#low',
    motivo: 'el variant "low" no está en el catálogo (hay: max)',
  })
  expect(resolver(v, 'rapido')).toEqual({ model: 'kimi-code-plan-global/k3', variant: 'low' })
})

test('modelo con enabled: false queda excluido', () => {
  expect(v.exclusiones).toContainEqual(
    expect.objectContaining({ actor: 'openai/gpt-4o-legacy', motivo: expect.stringContaining('enabled: false') }),
  )
  expect(resolver(v, 'visual')).toEqual({ model: 'openai/gpt-5.5', variant: 'high' })
})

test('papel sin actores válidos sale desactivado', () => {
  expect(v.desactivados).toEqual(['prosa'])
  expect(resolver(v, 'prosa')).toBeUndefined()
  expect(v.exclusiones.filter((e) => e.nombre === 'prosa').map((e) => e.motivo)).toEqual([
    'el variant "off" no está en el catálogo (el modelo no tiene variants)',
    'el modelo no está en el catálogo',
  ])
})

test('sin variant corre el default: válido aunque el modelo no tenga variants', () => {
  expect(resolver(v, 'estelar')).toEqual({ model: 'opencode-go/qwen3.7-plus' })
})

test('agentes: los propios y los que existen en V2 pasan; el resto se avisa', () => {
  expect(v.desconocidos).toEqual(['sisyphus'])
})
