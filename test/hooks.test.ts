import { Skill } from '@opencode/plugin'
import { expect, test } from 'bun:test'

import { adjuntarSkill } from '../src/hooks.ts'

import type { SessionPrompt } from '@opencode/plugin/promise/session'

const disponibles = [{ id: Skill.ID.make('tdd') }]

test('adjunta el skill exacto al inicio sin alterar el texto', () => {
  // Given: un prompt crudo con slash skill y texto posterior.
  const prompt: SessionPrompt['prompt'] = { text: '  /tdd hola' }

  // When: se comprueba el catálogo de skills.
  adjuntarSkill(prompt, disponibles)

  // Then: se adjunta el skill; el mensaje original permanece igual.
  expect(prompt).toEqual({ text: '  /tdd hola', skills: [{ id: disponibles[0]?.id }] })
})

test.each(['/foo hola', '/home/x hola', '/TDD hola', 'tdd hola'])(
  'ignora texto que no empieza con un skill disponible: %s',
  (text) => {
    // Given: un prompt que no nombra el skill exacto.
    const prompt = { text }

    // When: se comprueba el catálogo de skills.
    adjuntarSkill(prompt, disponibles)

    // Then: no se altera el prompt.
    expect(prompt).toEqual({ text })
  },
)

test('no duplica un skill ya adjunto', () => {
  // Given: el cliente ya envió el mismo skill.
  const prompt = { text: '/tdd hola', skills: [{ id: Skill.ID.make('tdd') }] }

  // When: se comprueba el catálogo de skills.
  adjuntarSkill(prompt, disponibles)

  // Then: queda una sola referencia.
  expect(prompt.skills).toEqual([{ id: Skill.ID.make('tdd') }])
})
