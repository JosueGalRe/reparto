import { readFileSync } from 'node:fs'

import { Agent } from '@opencode/plugin'

import type { Validacion } from './actores.ts'
import type { AgentEditor } from '@opencode/plugin/promise/agent'

export const papeles = ['rapido', 'visual', 'protagonista', 'estelar', 'prosa'] as const
/** Agentes con shell de lectura restringido. */
export const conShellDeLectura = new Set(['director', 'dramaturgo', 'regidor'])

const guion = (nombre: string) => readFileSync(new URL(`../guiones/${nombre}.md`, import.meta.url), 'utf8').trim()

interface Rule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}
const allow = (...actions: string[]): Rule[] => actions.map((action) => ({ action, resource: '*', effect: 'allow' }))
const deny = (...actions: string[]): Rule[] => actions.map((action) => ({ action, resource: '*', effect: 'deny' }))
const mcpActions = ['context7_*', 'grep_app_*'] as const

// `git diff *` lleva el espacio para no dejar pasar `git difftool`. `head *` deja pasar `rg x | head`:
// V2 exige que cada tramo de `;`, `&&`, `|` y `$( )` esté permitido (S7). V2 oculta las tools negadas pero no
// Los comandos: el guion del director lleva esta misma lista (`seccionShell`).
export const comandosDeLectura = [
  'rg *',
  'git status*',
  'git diff',
  'git diff *',
  'git ls-files*',
  'git log*',
  'git show*',
  'head *',
]
// Ponytail: acoplado al plugin vendor/rtk.ts; cuando el shim exponga el agente, rtk debe omitir los de solo lectura.
const shellDeLectura: Rule[] = [
  ...comandosDeLectura,
  ...comandosDeLectura.filter((comando) => comando !== 'head *').map((comando) => `rtk ${comando}`),
].map((resource) => ({
  action: 'shell',
  resource,
  effect: 'allow',
}))

/**
 * Como el `explore` nativo: las reglas base, todo negado, la lista permitida y otra vez las restricciones
 * de la base (`.env`, directorios externos), porque gana la última regla que coincide. Así queda negada
 * cualquier tool con efectos que cargue otro plugin (`pty_*` incluidas) y `execute`, desde donde se llega a las MCP.
 */
function soloLectura(base: Rule[], extra: string[]): Rule[] {
  const restricciones = base.filter((rule) => rule.action === 'read' || rule.action === 'external_directory')

  return [
    ...base,
    ...deny('*'),
    ...allow('read', 'glob', 'grep', 'skill', 'webfetch', 'websearch', ...extra),
    ...shellDeLectura,
    ...restricciones,
  ]
}

function dramaturgo(base: Rule[]): Rule[] {
  return [
    ...soloLectura(base, ['question', 'delegar', 'bitacora', 'ensayar']),
    ...['edit', 'write', 'patch'].map((action) => ({ action, resource: '.reparto/planes/*', effect: 'allow' as const })),
  ]
}

function subagenteSoloLectura(base: Rule[]): Rule[] {
  const restricciones = base.filter((rule) => rule.action === 'read' || rule.action === 'external_directory')

  return [...base, ...deny('*'), ...allow('read', 'glob', 'grep', 'skill', 'webfetch', 'websearch', 'shell'), ...restricciones]
}

/** Se agrega al guion de los agentes con shell de lectura: V2 no les muestra qué comandos están permitidos. */
export const seccionShell = [
  '## Shell',
  `\`shell\` only runs these read commands: ${comandosDeLectura.map((comando) => `\`${comando}\``).join(', ')}.`,
  'Run one command per shell call. Do not chain with `&&` or `;`, and do not add helpers such as `printf`, `echo`, `cat`, `ls`, `find`, `wc` or `sort`: they are not on the list, so the whole call is denied. ' +
    'The only pipe allowed is into `head`. Redirection (`>`, `<`), backticks, newlines and the options `--output`, `--ext-diff`, `--textconv`, `--pre` are denied too. ' +
    'List files with `rg --files` or `git ls-files`, search with `grep` or `rg`, find paths with `glob`, and read files with `read`. If a command is denied, do not retry variations of it.',
].join('\n\n')

export function permisos(base: Rule[]) {
  return {
    director: [
      ...soloLectura(base, ['question', 'delegar', 'interrumpir', 'bitacora', 'pendientes']),
      ...deny(...mcpActions),
      ...allow(mcpActions[0]),
    ],
    regidor: [...soloLectura(base, ['question', 'delegar', 'interrumpir', 'bitacora', 'pendientes']), ...deny(...mcpActions)],
    dramaturgo: [...dramaturgo(base), ...deny(...mcpActions)],
    subagenteLectura: [...subagenteSoloLectura(base), ...deny(...mcpActions)],
    archivista: [...subagenteSoloLectura(base), ...deny(...mcpActions), ...allow(...mcpActions)],
    // Papeles y subagentes no delegan: un encargo nunca espera a otro dentro de la misma cola.
    papel: [...base, ...deny('question', 'subagent', 'delegar', ...mcpActions)],
  }
}

const descripciones: Record<string, string> = {
  director: 'Takes your requests, delegates every change to agents and papeles, and verifies the result. Does not edit.',
  dramaturgo: 'Interviews Bryan and writes scoped, verifiable plans in .reparto/planes/ only.',
  utilero: 'Explores this repository and reports where things are. Read-only.',
  archivista: 'Finds documentation and code outside the repository. Read-only.',
  oracle: 'Read-only consultant for hard decisions: architecture, trade-offs, stubborn bugs.',
  critico: 'Read-only reviewer of plans in the ensayo general.',
  regidor: 'Executes an estrenado plan through delegation and verifies each task without editing.',
  rapido: 'Papel for mechanical, bounded changes with no design decision.',
  visual: 'Papel for changes whose result a person sees.',
  protagonista: 'Default papel for implementation that needs understanding the code first.',
  estelar: 'Escalation papel: failed or doubtful protagonista work, tasks oracle rates hard, invariant-dependent correctness.',
  prosa: 'Papel for deliverables that are text for people.',
}

export function registrar(editor: AgentEditor) {
  const base = (editor.get('build')?.permissions ?? []).map((rule) => ({ ...rule }))
  const reglas = permisos(base)
  const definir = (id: string, mode: 'primary' | 'subagent', system: string, permissions: Rule[], hidden = false) =>
    editor.update(id, (agent) => {
      agent.name = Agent.Name.make(id[0]!.toUpperCase() + id.slice(1))
      agent.mode = mode
      agent.hidden = hidden
      agent.description = descripciones[id]
      agent.system = system
      agent.permissions = permissions
    })

  definir('director', 'primary', `${guion('director')}\n\n${seccionShell}`, reglas.director)
  definir('regidor', 'primary', `${guion('regidor')}\n\n${seccionShell}`, reglas.regidor)
  definir('dramaturgo', 'primary', `${guion('dramaturgo')}\n\n${seccionShell}`, reglas.dramaturgo)

  for (const id of ['utilero', 'oracle', 'critico']) {
    definir(id, 'subagent', guion(id), reglas.subagenteLectura)
  }

  definir('archivista', 'subagent', guion('archivista'), reglas.archivista)

  // Los papeles no se invocan por nombre (no son agentes): se ocultan del `@`.
  for (const id of papeles) {
    definir(id, 'subagent', `${guion('papel')}\n\n${guion(id)}`, reglas.papel, true)
  }

  editor.update('build', (agent) => {
    agent.permissions.push(...deny('subagent', ...mcpActions))
  })

  for (const agent of editor.list()) {
    const id = String(agent.id)

    if (id === 'director' || id === 'archivista' || id === 'build') {
      continue
    }

    editor.update(id, (entry) => entry.permissions.push(...deny(...mcpActions)))
  }

  editor.default('director')
}

/** Parte de sistema que se agrega en cada request del director: los papeles activos y lo que quedó excluido. */
export function ruteo(validacion: Validacion | undefined): string {
  const desactivados = new Set(validacion?.desactivados)
  const filas = guion('ruteo')
    .split('\n')
    .filter((fila) => !papeles.some((papel) => desactivados.has(papel) && fila.startsWith(`| \`${papel}\``)))
  const partes = ['## Routing table', filas.join('\n')]
  const disabled = papeles.filter((papel) => desactivados.has(papel))

  if (disabled.length) {
    partes.push(
      `Disabled papeles (no valid actor, do not delegate to them): ${disabled.map((papel) => `\`${papel}\``).join(', ')}.`,
    )
  }

  if (validacion?.exclusiones.length) {
    partes.push(
      '## Excluded actors',
      'These actors in reparto.jsonc failed validation against the model catalog and will not run. Mention them to the user briefly in your first reply of this session:',
      validacion.exclusiones
        .map((exclusion) => `- ${exclusion.tipo} \`${exclusion.nombre}\`: ${exclusion.actor}: ${exclusion.motivo}`)
        .join('\n'),
    )
  }

  return partes.join('\n\n')
}

/** Lo que las reglas de V2 dejan pasar dentro de un tramo permitido y reparto niega (S7, ADR 0006). */
export function motivoNegado(tramo: string): string | undefined {
  if (/[<>]/.test(tramo)) {
    return 'redirección'
  }

  if (tramo.includes('`')) {
    return 'backticks'
  }

  if (/[\r\n]/.test(tramo)) {
    return 'salto de línea'
  }

  const opcion = tramo.match(/(?:^|\s)(--(?:output|ext-diff|textconv|pre|pre-glob))(?:[=\s]|$)/)

  if (opcion) {
    return `opción ${opcion[1]}`
  }
}
