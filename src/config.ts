import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import schema from '../schema/reparto.schema.json'

import { esRegistro } from './validation-utils.ts'

export interface Actor {
  model: string
  variant?: string
}

export interface Reparto {
  titular: Actor
  suplentes?: Actor[]
}

interface Proveedor {
  plazoBaja?: string
}

export interface Config {
  fallosInternos?: number
  agentes?: Record<string, Reparto>
  proveedores?: Record<string, Proveedor>
}

// "30m" | "5h" | "7d" → ms; el schema ya garantiza el formato
export function plazoMs(plazo: string): number {
  const unidad = plazo.at(-1)

  if (unidad !== 'm' && unidad !== 'h' && unidad !== 'd') {
    throw new Error(`plazoMs: unidad inválida en "${plazo}"; se esperaba m, h o d`)
  }

  return Number(plazo.slice(0, -1)) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[unidad]
}

const defaultPath = join(homedir(), '.config', 'opencode', 'reparto.jsonc')

export function configPath(options: Readonly<Record<string, unknown>>): string {
  const path = typeof options.config === 'string' ? options.config : defaultPath

  return resolve(path.replace(/^~(?=\/|$)/, homedir()))
}

export async function loadConfig(path: string): Promise<{ config: Config } | { error: string }> {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return { error: `no existe ${path}` }
  }

  let data: unknown

  try {
    data = Bun.JSONC.parse(await file.text())
  } catch (error) {
    return { error: `${path} no es JSONC válido: ${error instanceof Error ? error.message : String(error)}` }
  }

  try {
    validarConfig(data)
  } catch (error) {
    return { error: `${path} no cumple el schema: ${error instanceof Error ? error.message : String(error)}` }
  }

  return { config: data }
}

function validarConfig(data: unknown): asserts data is Config {
  const errors = validate(data, schema, '')

  if (errors.length) {
    throw new Error(errors.join('; '))
  }
}

// Ponytail: solo el subconjunto de JSON Schema que usa schema/reparto.schema.json; si el schema crece, ampliar aquí.
// Diverge a propósito del estándar: un `additionalProperties` omitido cuenta como false (en JSON Schema es true).
// Todo objeto del schema lo declara; si alguien lo omite, el editor aceptará claves que este validador rechaza.
interface JsonSchema {
  $ref?: string
  type?: string
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  required?: string[]
  items?: JsonSchema
  minimum?: number
  minLength?: number
  pattern?: string
}

const definiciones: Record<string, JsonSchema> = schema.$defs

function validate(value: unknown, node: JsonSchema, path: string): string[] {
  const at = path || '(raíz)'

  if (node.$ref) {
    const def = definiciones[node.$ref.replace('#/$defs/', '')]

    if (!def) {
      return [`${at}: referencia de schema desconocida "${node.$ref}"`]
    }

    return validate(value, def, path)
  }

  switch (node.type) {
    case 'object': {
      if (!esRegistro(value)) {
        return [`${at}: se esperaba un objeto`]
      }

      const errors = (node.required ?? []).filter((key) => !(key in value)).map((key) => `${at}: falta "${key}"`)

      for (const [key, child] of Object.entries(value)) {
        const sub = node.properties?.[key] ?? node.additionalProperties
        const childPath = path ? `${path}.${key}` : key

        if (sub === false || sub === undefined) {
          errors.push(`${childPath}: clave desconocida`)
        } else if (sub && sub !== true) {
          errors.push(...validate(child, sub, childPath))
        }
      }

      return errors
    }

    case 'array': {
      if (!Array.isArray(value)) {
        return [`${at}: se esperaba una lista`]
      }

      const items = node.items

      return items ? value.flatMap((item: unknown, indice) => validate(item, items, `${path}[${indice}]`)) : []
    }

    case 'string': {
      if (typeof value !== 'string') {
        return [`${at}: se esperaba un texto`]
      }

      if (node.minLength !== undefined && value.length < node.minLength) {
        return [`${at}: vacío`]
      }

      if (node.pattern && !new RegExp(node.pattern).test(value)) {
        return [`${at}: "${value}" no cumple ${node.pattern}`]
      }

      return []
    }

    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return [`${at}: se esperaba un entero`]
      }

      if (node.minimum !== undefined && value < node.minimum) {
        return [`${at}: menor que ${node.minimum}`]
      }

      return []
    }
  }

  return [`${at}: tipo de schema no soportado "${node.type}"`]
}
