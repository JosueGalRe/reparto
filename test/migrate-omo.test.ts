import { expect, test } from 'bun:test'

import { type Catalog, leerCatalogo, leerOmo, migrar, migrarActor, migrarReparto } from '../scripts/migrate-omo.ts'

test('rechaza un archivo OMO mal formado antes de migrar', () => {
  // Given: falta el reparto del agente que la migración lee.
  const archivo: unknown = { '[opencode]': { agents: {}, categories: {} } }

  // When: se lee el OMO; Then: falla con el agente ausente.
  expect(() => leerOmo(archivo)).toThrow(/archivo OMO mal formado: agente sisyphus/)
})

test('rechaza un catálogo mal formado antes de migrar', () => {
  // Given: variants no es una lista de identificadores.
  const archivo: unknown = { data: [{ providerID: 'p', id: 'm', variants: [null] }] }

  // When: se lee el catálogo; Then: falla con un error en español.
  expect(() => leerCatalogo(archivo)).toThrow(/catálogo mal formado/)
})

const catalog: Catalog = new Map([
  ['opencode-go/kimi-k3', ['max']],
  ['opencode-go/glm-5.2', ['high', 'max']],
  ['opencode-go/minimax-m3', ['none', 'thinking']],
  ['kimi-code-plan-global/kimi-for-coding-highspeed', []],
  ['openai/gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
])

test.each([
  ['opencode-go/kimi-k3', 'low', { model: 'opencode-go/kimi-k3', variant: 'max' }],
  ['opencode-go/glm-5.2', 'xhigh', { model: 'opencode-go/glm-5.2', variant: 'max' }],
  ['kimi-code-plan-global/kimi-for-coding-highspeed', 'off', { model: 'kimi-code-plan-global/kimi-for-coding-highspeed' }],
  ['kimi-code-plan-global/kimi-for-coding-highspeed', 'auto', { model: 'kimi-code-plan-global/kimi-for-coding-highspeed' }],
  ['openai/gpt-6-sol', 'medium', { model: 'openai/gpt-6-sol', variant: 'medium' }],
])('%s #%s', (model, reasoning, actor) => {
  expect(migrarActor(model, reasoning, catalog).actor).toEqual(actor)
})

test('no se adivina fuera de la escala: MiniMax max no pasa a none', () => {
  expect(migrarActor('opencode-go/minimax-m3', 'max', catalog).nota).toStartWith('REVISAR')
  expect(migrarActor('openai/gpt-6-sol', 'turbo', catalog).nota).toStartWith('REVISAR')
})

test('sin herencia: la entrada sin reasoning va sin variant y lo anota; el titular repetido en models no se duplica', () => {
  const migrados = migrarReparto(
    {
      model: 'openai/gpt-6-sol',
      reasoning: 'medium',
      models: [{ model: 'openai/gpt-6-sol', reasoning: 'medium' }, 'opencode-go/kimi-k3'],
    },
    catalog,
    false,
  )

  expect(migrados.map((migrado) => migrado.actor)).toEqual([
    { model: 'openai/gpt-6-sol', variant: 'medium' },
    { model: 'opencode-go/kimi-k3' },
  ])
  expect(migrados[1]!.nota).toBe('OMO heredaba "medium"; sin herencia: default del proveedor')
})

test('categoría: models[0] es el titular y el resto hereda su reasoning en OMO', () => {
  const migrados = migrarReparto(
    { models: [{ model: 'openai/gpt-6-sol', reasoning: 'xhigh' }, 'opencode-go/kimi-k3'] },
    catalog,
    true,
  )

  expect(migrados[0]!.actor).toEqual({ model: 'openai/gpt-6-sol', variant: 'xhigh' })
  expect(migrados[1]!.nota).toContain('"xhigh"')
})

test('la migración no genera concurrencia del OMO', () => {
  // Given: una config OMO con concurrencia por proveedor.
  const entry = { model: 'opencode-go/kimi-k3' }
  const agents = Object.fromEntries(
    ['sisyphus', 'explore', 'librarian', 'oracle', 'prometheus', 'momus', 'atlas'].map((name) => [name, entry]),
  )
  const categories = Object.fromEntries(
    ['quick', 'visual-engineering', 'deep-low', 'ultrabrain', 'writing'].map((name) => [name, entry]),
  )
  const omo = { '[opencode]': { agents, categories, background_task: { providerConcurrency: { 'opencode-go': 2 } } } }

  // When: se migra al formato de reparto.
  const migrated = Bun.JSONC.parse(migrar(omo, catalog, 'schema.json'))

  // Then: el resultado no arrastra proveedores sin configuración vigente.
  expect(migrated).not.toHaveProperty('proveedores')
  expect(migrated).toHaveProperty('agentes.tiresias')
})
