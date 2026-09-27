import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import schema from '../schema/reparto.schema.json'

export interface Actor {
  model: string
  variant?: string
}

export interface Reparto {
  titular: Actor
  suplentes?: Actor[]
}

export interface Proveedor {
  plazoBaja?: string
}

export interface Config {
  fallosInternos?: number
  agentes?: Record<string, Reparto>
  papeles?: Record<string, Reparto>
  proveedores?: Record<string, Proveedor>
}

// "30m" | "5h" | "7d" → ms; el schema ya garantiza el formato
export const plazoMs = (plazo: string) =>
  Number(plazo.slice(0, -1)) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[plazo.at(-1) as 'm' | 'h' | 'd']

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

  const errors = validate(data, schema as JsonSchema, '')

  if (errors.length) {
    return { error: `${path} no cumple el schema: ${errors.join('; ')}` }
  }

  return { config: data as Config }
}

// Ponytail: solo el subconjunto de JSON Schema que usa schema/reparto.schema.json; si el schema crece, ampliar aquí.
// Diverge a propósito del estándar: un `additionalProperties` omitido cuenta como false (en JSON Schema es true).
// Todo objeto del schema lo declara; si alguien lo omite, el editor aceptará claves que este validador rechaza.
interface JsonSchema {
  $ref?: string
  type?: 'object' | 'array' | 'string' | 'integer'
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  required?: string[]
  items?: JsonSchema
  minimum?: number
  minLength?: number
  pattern?: string
}

function validate(value: unknown, node: JsonSchema, path: string): string[] {
  const at = path || '(raíz)'

  if (node.$ref) {
    const def = (schema as { $defs: Record<string, JsonSchema> }).$defs[node.$ref.replace('#/$defs/', '')]

    return validate(value, def!, path)
  }

  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${at}: se esperaba un objeto`]
      }

      const record = value as Record<string, unknown>
      const errors = (node.required ?? []).filter((key) => !(key in record)).map((key) => `${at}: falta "${key}"`)

      for (const [key, child] of Object.entries(record)) {
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

      return node.items ? value.flatMap((item, indice) => validate(item, node.items!, `${path}[${indice}]`)) : []
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
      if (!Number.isInteger(value)) {
        return [`${at}: se esperaba un entero`]
      }

      if (node.minimum !== undefined && (value as number) < node.minimum) {
        return [`${at}: menor que ${node.minimum}`]
      }

      return []
    }
  }

  return []
}
