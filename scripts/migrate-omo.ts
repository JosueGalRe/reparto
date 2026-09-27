#!/usr/bin/env bun
// Migrate-omo.ts <omo.jsonc> <model.list.json>: prints reparto.jsonc migrated from OMO (plan 1.3).
// The catalog is the output of `scripts/api.sh model.list` (enabled models only, with their variants).
import { esRegistro } from '../src/validation-utils.ts'

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

function esReparto(valor: unknown): valor is OmoReparto {
  if (
    !esRegistro(valor) ||
    (valor.model !== undefined && typeof valor.model !== 'string') ||
    (valor.reasoning !== undefined && typeof valor.reasoning !== 'string') ||
    (valor.models !== undefined &&
      (!Array.isArray(valor.models) ||
        !valor.models.every(
          (entrada: unknown) =>
            typeof entrada === 'string' ||
            (esRegistro(entrada) &&
              typeof entrada.model === 'string' &&
              (entrada.reasoning === undefined || typeof entrada.reasoning === 'string')),
        )))
  ) {
    return false
  }

  return typeof valor.model === 'string' || (Array.isArray(valor.models) && valor.models.length > 0)
}

export function leerOmo(valor: unknown): Omo {
  if (!esRegistro(valor) || !esRegistro(valor['[opencode]'])) {
    throw new Error('migración: archivo OMO mal formado: falta [opencode]')
  }

  const origen = valor['[opencode]']

  if (!esRegistro(origen.agents) || !esRegistro(origen.categories)) {
    throw new Error('migración: archivo OMO mal formado: faltan agentes, categorías o modelos válidos')
  }

  const agents: Record<string, OmoReparto> = {}
  const categories: Record<string, OmoReparto> = {}

  for (const nombre of Object.keys(agentes)) {
    const entrada = origen.agents[nombre]

    if (!esReparto(entrada)) {
      throw new Error(`migración: archivo OMO mal formado: agente ${nombre} sin modelo válido`)
    }

    agents[nombre] = entrada
  }

  for (const nombre of Object.keys(papeles)) {
    const entrada = origen.categories[nombre]

    if (!esReparto(entrada)) {
      throw new Error(`migración: archivo OMO mal formado: categoría ${nombre} sin modelo válido`)
    }

    categories[nombre] = entrada
  }

  return { '[opencode]': { agents, categories } }
}

export function leerCatalogo(valor: unknown): Catalog {
  if (
    !esRegistro(valor) ||
    !Array.isArray(valor.data) ||
    !valor.data.every(
      (modelo: unknown) =>
        esRegistro(modelo) &&
        typeof modelo.providerID === 'string' &&
        typeof modelo.id === 'string' &&
        Array.isArray(modelo.variants) &&
        modelo.variants.every((variant: unknown) => esRegistro(variant) && typeof variant.id === 'string'),
    )
  ) {
    throw new Error('migración: catálogo mal formado: se esperan modelos con providerID, id y variants')
  }

  const catalog: Catalog = new Map()

  for (const modelo of valor.data) {
    catalog.set(
      `${modelo.providerID}/${modelo.id}`,
      modelo.variants.map((variant: { id: string }) => variant.id),
    )
  }

  return catalog
}

interface Migrado {
  actor: Actor
  nota?: string
}

/** OMO reasoning → raw V2 variant (ADR 0002). `heredado` is what OMO would have inherited for an entry without reasoning. */
export function migrarActor(model: string, reasoning: string | undefined, catalog: Catalog, heredado?: string): Migrado {
  if (reasoning === undefined) {
    return { actor: { model }, nota: heredado ? `OMO heredaba "${heredado}"; sin herencia: default del proveedor` : undefined }
  }

  if (reasoning === 'auto') {
    return { actor: { model }, nota: `OMO "auto" = sin variant` }
  }

  const variants = catalog.get(model)

  if (!variants) {
    return { actor: { model, variant: reasoning }, nota: 'REVISAR: el modelo no está en el catálogo' }
  }

  if (variants.includes(reasoning)) {
    return { actor: { model, variant: reasoning } }
  }

  if (!variants.length) {
    return { actor: { model }, nota: `OMO "${reasoning}"; el modelo no tiene variants: default del proveedor` }
  }

  const wanted = scale.indexOf(reasoning === 'off' ? 'none' : reasoning)
  const candidates = variants.filter((variant) => scale.includes(variant))

  // A model with variants off the scale (MiniMax: none/thinking) has no meaningful "closest"
  if (wanted === -1 || candidates.length < variants.length) {
    return {
      actor: { model, variant: reasoning },
      nota: `REVISAR: "${reasoning}" no está en el catálogo (${variants.join(', ')})`,
    }
  }

  // Closest by distance on the scale; on a tie, the higher one
  const closest = candidates.reduce((best, variant) => {
    const distancia = Math.abs(scale.indexOf(variant) - wanted),
      db = Math.abs(scale.indexOf(best) - wanted)

    return distancia < db || (distancia === db && scale.indexOf(variant) > scale.indexOf(best)) ? variant : best
  })

  return {
    actor: { model, variant: closest },
    nota: `OMO "${reasoning}" no está en el catálogo (${variants.join(', ')}): corregido a "${closest}"`,
  }
}

export function migrarReparto(omo: OmoReparto, catalog: Catalog, esCategoria: boolean): Migrado[] {
  const entries = (omo.models ?? []).map((entrada) =>
    typeof entrada === 'string' ? { model: entrada, reasoning: undefined } : entrada,
  )
  // Agents: model + reasoning is the titular and `models` lists the chain. Categories: models[0] is the titular.
  // In OMO an entry without reasoning inherits the agent's, or models[0]'s in a category.
  const heredado = esCategoria ? entries[0]?.reasoning : omo.reasoning
  const cadena = omo.model ? [{ model: omo.model, reasoning: omo.reasoning }, ...entries] : entries
  const vistos = new Set<string>()

  return cadena.flatMap((entrada) => {
    const clave = `${entrada.model}#${entrada.reasoning ?? heredado}`

    if (vistos.has(clave)) {
      return []
    }

    vistos.add(clave)

    return [migrarActor(entrada.model, entrada.reasoning, catalog, heredado)]
  })
}

const actorJson = (actor: Actor) =>
  `{ "model": ${JSON.stringify(actor.model)}${actor.variant ? `, "variant": ${JSON.stringify(actor.variant)}` : ''} }`
const linea = (migrado: Migrado, coma: boolean) =>
  `${actorJson(migrado.actor)}${coma ? ',' : ''}${migrado.nota ? ` // ${migrado.nota}` : ''}`

function bloque(nombre: string, migrados: Migrado[], ultimo: boolean, origen: string): string {
  const [titular, ...suplentes] = migrados
  const out = [
    `    // ${origen}`,
    `    ${JSON.stringify(nombre)}: {`,
    `      "titular": ${linea(titular!, suplentes.length > 0)}`,
  ]

  if (suplentes.length) {
    out.push(`      "suplentes": [`)
    suplentes.forEach((suplente, indice) => out.push(`        ${linea(suplente, indice < suplentes.length - 1)}`))
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

    if (nombre === 'director') {
      agentesOut.push([
        'build',
        migrarReparto(src.agents[omoName]!, catalog, false),
        `OMO: ${omoName} (build toma el reparto del director)`,
      ])
    }
  }

  const papelesOut = Object.entries(papeles).map(
    ([omoName, nombre]) => [nombre, migrarReparto(src.categories[omoName]!, catalog, true), `OMO: ${omoName}`] as const,
  )

  return [
    `// Generado por scripts/migrate-omo.ts desde omo.jsonc (${new Date().toISOString().slice(0, 10)}).`,
    `// Sin equivalente, no se migran: hephaestus, metis, sisyphus-junior, multimodal-looker, deep-high,`,
    `// unspecified-low, unspecified-high, artistry, el profile cursor, modelConcurrency y runtime_fallback.`,
    `{`,
    `  "$schema": ${JSON.stringify(schema)},`,
    `  "agentes": {`,
    agentesOut
      .map(([nombre, modelo, origen], indice) => bloque(nombre, modelo, indice === agentesOut.length - 1, origen))
      .join('\n'),
    `  },`,
    `  "papeles": {`,
    papelesOut
      .map(([nombre, modelo, origen], indice) => bloque(nombre, modelo, indice === papelesOut.length - 1, origen))
      .join('\n'),
    `  }`,
    `}`,
    ``,
  ].join('\n')
}

if (import.meta.main) {
  const [omoPath, catalogPath] = process.argv.slice(2)

  if (!omoPath || !catalogPath) {
    throw new Error('uso: migrate-omo.ts <omo.jsonc> <model.list.json>')
  }

  const omo = leerOmo(Bun.JSONC.parse(await Bun.file(omoPath).text()))
  const catalogo: unknown = await Bun.file(catalogPath).json()
  const catalog = leerCatalogo(catalogo)

  process.stdout.write(migrar(omo, catalog, new URL('../schema/reparto.schema.json', import.meta.url).pathname))
}
