import { expect, test } from 'bun:test'

import { motivoNegado, permisos, registrar, ruteo } from '../src/agentes.ts'

import type { AgentEditor } from '@opencode/plugin/promise/agent'

test.each([
  ['rg x > f', 'redirección'],
  ['rg x < f', 'redirección'],
  ['git diff <(touch f)', 'redirección'],
  ['rg `touch f`', 'backticks'],
  ['rg x\ntouch f', 'salto de línea'],
  ['git diff --output=f', 'opción --output'],
  ['git diff --output f', 'opción --output'],
  ['git diff --ext-diff', 'opción --ext-diff'],
  ['git diff --textconv HEAD', 'opción --textconv'],
  ['rg --pre cat x', 'opción --pre'],
  ["rg --pre-glob '*.gz' x", 'opción --pre-glob'],
])('niega %s', (tramo, motivo) => {
  expect(motivoNegado(tramo)).toBe(motivo)
})

test.each(['rg x', 'rg --pretty x', 'git diff --stat', 'git status --short', 'head -5'])('deja pasar %s', (tramo) => {
  expect(motivoNegado(tramo)).toBeUndefined()
})

test('director: la lista permitida va después de negar todo, y las restricciones de la base al final', () => {
  const base = [
    { action: '*', resource: '*', effect: 'allow' as const },
    { action: 'read', resource: '*.env', effect: 'ask' as const },
  ]
  const { director, papel } = permisos(base)
  const ultima = (action: string, resource = '*') =>
    director.findLast((r) => (r.action === action || r.action === '*') && (r.resource === resource || r.resource === '*'))
      ?.effect

  expect(ultima('edit')).toBe('deny')
  expect(ultima('pty_spawn')).toBe('deny')
  expect(ultima('execute')).toBe('deny')
  expect(ultima('delegar')).toBe('allow')
  expect(ultima('read', '*.env')).toBe('ask')

  for (const action of ['question', 'subagent', 'delegar', 'context7_*', 'grep_app_*']) {
    expect(papel.findLast((r) => r.action === action)?.effect).toBe('deny')
  }
})

test('director: permite solo los comandos de lectura reescritos por rtk', () => {
  const reglas = permisos([]).director
  const efecto = (resource: string) =>
    reglas.findLast(
      (rule) =>
        (rule.action === 'shell' || rule.action === '*') &&
        (rule.resource === '*' ||
          rule.resource === resource ||
          (rule.resource.endsWith('*') && resource.startsWith(rule.resource.slice(0, -1)))),
    )?.effect

  expect(efecto('rtk git status')).toBe('allow')
  expect(efecto('rtk rg x')).toBe('allow')
  expect(efecto('head -1')).toBe('allow') // El otro tramo de `rtk rg x | head -1`
  expect(efecto('rtk read x')).toBe('deny')
  expect(efecto('rtk curl https://example.com')).toBe('deny')
  expect(efecto('ls -la')).toBe('deny')
  expect(efecto('rg x > f')).toBe('allow')
  expect(motivoNegado('rg x > f')).toBe('redirección')
})

test.each(['edit', 'write', 'patch'])('dramaturgo: %s solo permite rutas de planes locales', (action) => {
  // Given: the ruleset installed after the permissive build defaults.
  const reglas = permisos([{ action: '*', resource: '*', effect: 'allow' }]).dramaturgo
  const efecto = (resource: string) =>
    reglas.findLast(
      (rule) =>
        (rule.action === action || rule.action === '*') &&
        (rule.resource === '*' || (rule.resource.endsWith('*') && resource.startsWith(rule.resource.slice(0, -1)))),
    )?.effect

  // When: a write target is checked; Then: only a local plan passes.
  expect(efecto('.reparto/planes/x.md')).toBe('allow')

  for (const path of ['src/x.ts', '.reparto/otro/x.md', '../.reparto/planes/x.md']) {expect(efecto(path)).toBe('deny')}
})

test('utilero: shell abierto, edición y delegación negadas', () => {
  const reglas = permisos([]).subagenteLectura
  const efecto = (action: string, resource: string) =>
    reglas.findLast(
      (rule) =>
        (rule.action === action || rule.action === '*') &&
        (rule.resource === '*' ||
          rule.resource === resource ||
          (rule.resource.endsWith('*') && resource.startsWith(rule.resource.slice(0, -1)))),
    )?.effect

  for (const command of ['ls -la', 'jq . f', "sqlite3 -readonly db 'select 1'"]) {expect(efecto('shell', command)).toBe('allow')}
  for (const tool of ['edit', 'write', 'patch', 'subagent', 'delegar', 'interrumpir']) {expect(efecto(tool, '*')).toBe('deny')}
})

test('dramaturgo puede ensayar y leer bitacora; critico sigue siendo de solo lectura', () => {
  // Given: the effective permission rules for both agents.
  const { dramaturgo, subagenteLectura } = permisos([])

  // When: the final matching rule is resolved; Then: only dramaturgo gets the ensayo tools.
  for (const nombre of ['ensayar', 'bitacora'])
    {expect(dramaturgo.findLast((r) => r.action === nombre || r.action === '*')?.effect).toBe('allow')}
  for (const nombre of ['edit', 'write', 'patch', 'delegar', 'ensayar'])
    {expect(subagenteLectura.findLast((r) => r.action === nombre || r.action === '*')?.effect).toBe('deny')}
  expect(subagenteLectura.findLast((r) => r.action === 'shell' || r.action === '*')?.effect).toBe('allow')
})

test("regidor keeps director's read-only rules without inheriting context7", () => {
  // Given: a build agent with permissive defaults.
  const agents = new Map<
    string,
    { permissions: { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[]; mode?: string }
  >()

  agents.set('general', { permissions: [{ action: '*', resource: '*', effect: 'allow' }] })
  const editor = {
    list: () => [...agents.entries()].map(([id, agent]) => ({ id, ...agent })),
    get: (id: string) => agents.get(id),
    update: (
      id: string,
      fn: (agent: {
        permissions: { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[]
        mode?: string
      }) => void,
    ) => {
      const agent = agents.get(id) ?? { permissions: [] }

      fn(agent)
      agents.set(id, agent)
    },
    default: () => {},
  } as unknown as AgentEditor

  // When: the plugin registers its agents; Then: regidor keeps the read-only rules but not director's MCP grant.
  registrar(editor)
  expect(agents.get('regidor')?.mode).toBe('primary')
  expect(agents.get('regidor')?.permissions.slice(0, -2)).toEqual(permisos([]).regidor)
  expect(agents.get('regidor')?.permissions.findLast((r) => r.action === 'context7_*')?.effect).toBe('deny')
  expect(agents.get('archivista')?.permissions.findLast((r) => r.action === 'grep_app_*')?.effect).toBe('allow')
  expect(agents.get('general')?.permissions.findLast((r) => r.action === 'grep_app_*')?.effect).toBe('deny')
})

test('MCP permissions only expose context7 to director and archivista, grep_app to archivista', () => {
  // Given: a permissive base and each registered agent's effective rules.
  const base = [{ action: '*', resource: '*', effect: 'allow' as const }]
  const { director, archivista, subagenteLectura: utilero, papel, regidor, dramaturgo } = permisos(base)

  // When: V2 resolves the last matching permission action; Then: only the designated agents see each server.
  for (const [rules, context7, grepApp] of [
    [director, 'allow', 'deny'],
    [archivista, 'allow', 'allow'],
    [utilero, 'deny', 'deny'],
    [papel, 'deny', 'deny'],
    [regidor, 'deny', 'deny'],
    [dramaturgo, 'deny', 'deny'],
  ] as const) {
    expect(rules.findLast((rule) => rule.action === 'context7_*' || rule.action === '*')?.effect).toBe(context7)
    expect(rules.findLast((rule) => rule.action === 'grep_app_*' || rule.action === '*')?.effect).toBe(grepApp)
  }
})

test('ruteo: un papel desactivado no aparece en la tabla, y las exclusiones se listan', () => {
  const texto = ruteo({
    actores: new Map(),
    exclusiones: [
      {
        nombre: 'prosa',
        tipo: 'papel',
        actor: 'opencode-go/qwen3.7-plus#off',
        motivo: 'el variant "off" no está en el catálogo',
      },
    ],
    desactivados: ['prosa'],
    desconocidos: [],
  })

  expect(texto).toContain('| `protagonista` |')
  expect(texto).not.toContain('| `prosa` |')
  expect(texto).toContain('Disabled papeles')
  expect(texto).toContain('opencode-go/qwen3.7-plus#off')
})

test('el guion de lectura lista exactamente los comandos permitidos', async () => {
  const { comandosDeLectura, seccionShell } = await import('../src/agentes.ts')

  for (const comando of comandosDeLectura) {expect(seccionShell).toContain(`\`${comando}\``)}
  expect(comandosDeLectura).toEqual(expect.arrayContaining(['git ls-files*', 'git log*', 'git show*']))
})
