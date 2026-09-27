#!/usr/bin/env bun
// Migrate-omo.ts <omo.jsonc> <model.list.json>: prints reparto.jsonc migrated from OMO (plan 1.3).
// The catalog is the output of `scripts/api.sh model.list` (enabled models only, with their variants).
import type { Actor } from '../src/config.ts'

type OmoEntry = string | { model: string; reasoning?: string }
interface OmoReparto {
  model?: string
  reasoning?: string
  models?: OmoEntry[]
}
interface Omo {
  '[opencode]': {
    agents: Record<string, OmoReparto>
    categories: Record<string, OmoReparto>
    background_task?: { providerConcurrency?: Record<string, number> }
  }
}
export type Catalog = Map<string, string[]>

const agentes: Record<string, string> = {
  sisyphus: 'director',
  explore: 'utilero',
  librarian: 'archivista',
  oracle: 'oracle',
  prometheus: 'dramaturgo',
  momus: 'critico',
  atlas: 'regidor',
}
const papeles: Record<string, string> = {
  quick: 'rapido',
  'visual-engineering': 'visual',
  'deep-low': 'protagonista',
  ultrabrain: 'estelar',
  writing: 'prosa',
}
const scale = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface Migrado {
  actor: Actor
  nota?: string
}

/** OMO reasoning → raw V2 variant (ADR 0002). `heredado` is what OMO would have inherited for an entry without reasoning. */
export function migrarActor(model: string, reasoning: string | undefined, catalog: Catalog, heredado?: string): Migrado {
  if (reasoning === undefined)
    {return { actor: { model }, nota: heredado ? `OMO heredaba "${heredado}"; sin herencia: default del proveedor` : undefined }}
  if (reasoning === 'auto') {return { actor: { model }, nota: `OMO "auto" = sin variant` }}
  const variants = catalog.get(model)

  if (!variants) {return { actor: { model, variant: reasoning }, nota: 'REVISAR: el modelo no está en el catálogo' }}
  if (variants.includes(reasoning)) {return { actor: { model, variant: reasoning } }}
  if (!variants.length)
    {return { actor: { model }, nota: `OMO "${reasoning}"; el modelo no tiene variants: default del proveedor` }}
  const wanted = scale.indexOf(reasoning === 'off' ? 'none' : reasoning)
  const candidates = variants.filter((v) => scale.includes(v))

  // A model with variants off the scale (MiniMax: none/thinking) has no meaningful "closest"
  if (wanted === -1 || candidates.length < variants.length)
    {return {
      actor: { model, variant: reasoning },
      nota: `REVISAR: "${reasoning}" no está en el catálogo (${variants.join(', ')})`,
    }}
  // Closest by distance on the scale; on a tie, the higher one
  const closest = candidates.reduce((best, v) => {
    const d = Math.abs(scale.indexOf(v) - wanted),
      db = Math.abs(scale.indexOf(best) - wanted)

    return d < db || (d === db && scale.indexOf(v) > scale.indexOf(best)) ? v : best
  })

  return {
    actor: { model, variant: closest },
    nota: `OMO "${reasoning}" no está en el catálogo (${variants.join(', ')}): corregido a "${closest}"`,
  }
}

export function migrarReparto(omo: OmoReparto, catalog: Catalog, esCategoria: boolean): Migrado[] {
  const entries = (omo.models ?? []).map((e) => (typeof e === 'string' ? { model: e, reasoning: undefined } : e))
  // Agents: model + reasoning is the titular and `models` lists the chain. Categories: models[0] is the titular.
  // In OMO an entry without reasoning inherits the agent's, or models[0]'s in a category.
  const heredado = esCategoria ? entries[0]?.reasoning : omo.reasoning
  const cadena = omo.model ? [{ model: omo.model, reasoning: omo.reasoning }, ...entries] : entries
  const vistos = new Set<string>()

  return cadena.flatMap((e) => {
    const clave = `${e.model}#${e.reasoning ?? heredado}`

    if (vistos.has(clave)) {return []}
    vistos.add(clave)

    return [migrarActor(e.model, e.reasoning, catalog, heredado)]
  })
}

const actorJson = (a: Actor) =>
  `{ "model": ${JSON.stringify(a.model)}${a.variant ? `, "variant": ${JSON.stringify(a.variant)}` : ''} }`
const linea = (m: Migrado, coma: boolean) => `${actorJson(m.actor)}${coma ? ',' : ''}${m.nota ? ` // ${m.nota}` : ''}`

function bloque(nombre: string, migrados: Migrado[], ultimo: boolean, origen: string): string {
  const [titular, ...suplentes] = migrados
  const out = [
    `    // ${origen}`,
    `    ${JSON.stringify(nombre)}: {`,
    `      "titular": ${linea(titular!, suplentes.length > 0)}`,
  ]

  if (suplentes.length) {
    out.push(`      "suplentes": [`)
    suplentes.forEach((s, i) => out.push(`        ${linea(s, i < suplentes.length - 1)}`))
    out.push(`      ]`)
  }

  out.push(`    }${ultimo ? '' : ','}`)

  return out.join('\n')
}

export function migrar(omo: Omo, catalog: Catalog, schema: string): string {
  const src = omo['[opencode]']
  const agentesOut: [string, Migrado[], string][] = []

  for (const [omoName, nombre] of Object.entries(agentes)) {
    agentesOut.push([nombre, migrarReparto(src.agents[omoName]!, catalog, false), `OMO: ${omoName}`])

    if (nombre === 'director')
      {agentesOut.push([
        'build',
        migrarReparto(src.agents[omoName]!, catalog, false),
        `OMO: ${omoName} (build toma el reparto del director)`,
      ])}
  }

  const papelesOut = Object.entries(papeles).map(
    ([omoName, nombre]) => [nombre, migrarReparto(src.categories[omoName]!, catalog, true), `OMO: ${omoName}`] as const,
  )
  const concurrencia = Object.entries(src.background_task?.providerConcurrency ?? {})

  return [
    `// Generado por scripts/migrate-omo.ts desde omo.jsonc (${new Date().toISOString().slice(0, 10)}).`,
    `// Sin equivalente, no se migran: hephaestus, metis, sisyphus-junior, multimodal-looker, deep-high,`,
    `// unspecified-low, unspecified-high, artistry, el profile cursor, modelConcurrency y runtime_fallback.`,
    `{`,
    `  "$schema": ${JSON.stringify(schema)},`,
    `  "agentes": {`,
    agentesOut.map(([n, m, o], i) => bloque(n, m, i === agentesOut.length - 1, o)).join('\n'),
    `  },`,
    `  "papeles": {`,
    papelesOut.map(([n, m, o], i) => bloque(n, m, i === papelesOut.length - 1, o)).join('\n'),
    `  },`,
    `  "proveedores": {`,
    concurrencia
      .map(([id, n], i) => `    ${JSON.stringify(id)}: { "concurrencia": ${n} }${i < concurrencia.length - 1 ? ',' : ''}`)
      .join('\n'),
    `  }`,
    `}`,
    ``,
  ].join('\n')
}

if (import.meta.main) {
  const [omoPath, catalogPath] = process.argv.slice(2)

  if (!omoPath || !catalogPath) {throw new Error('uso: migrate-omo.ts <omo.jsonc> <model.list.json>')}
  const omo = Bun.JSONC.parse(await Bun.file(omoPath).text()) as Omo
  const list = (await Bun.file(catalogPath).json()) as {
    data: { providerID: string; id: string; variants: { id: string }[] }[]
  }
  const catalog: Catalog = new Map(list.data.map((m) => [`${m.providerID}/${m.id}`, m.variants.map((v) => v.id)]))

  process.stdout.write(migrar(omo, catalog, new URL('../schema/reparto.schema.json', import.meta.url).pathname))
}
