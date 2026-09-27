import { expect, test } from 'bun:test'

import { type Catalog, migrarActor, migrarReparto } from '../scripts/migrate-omo.ts'

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
  const r = migrarReparto(
    {
      model: 'openai/gpt-6-sol',
      reasoning: 'medium',
      models: [{ model: 'openai/gpt-6-sol', reasoning: 'medium' }, 'opencode-go/kimi-k3'],
    },
    catalog,
    false,
  )

  expect(r.map((m) => m.actor)).toEqual([{ model: 'openai/gpt-6-sol', variant: 'medium' }, { model: 'opencode-go/kimi-k3' }])
  expect(r[1]!.nota).toBe('OMO heredaba "medium"; sin herencia: default del proveedor')
})

test('categoría: models[0] es el titular y el resto hereda su reasoning en OMO', () => {
  const r = migrarReparto({ models: [{ model: 'openai/gpt-6-sol', reasoning: 'xhigh' }, 'opencode-go/kimi-k3'] }, catalog, true)

  expect(r[0]!.actor).toEqual({ model: 'openai/gpt-6-sol', variant: 'xhigh' })
  expect(r[1]!.nota).toContain('"xhigh"')
})
