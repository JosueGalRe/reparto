import { write } from './db.ts'
import { esRegistro } from './validation-utils.ts'

import type { Database } from 'bun:sqlite'

export const estados = ['pendiente', 'en_curso', 'hecho', 'descartado'] as const
export interface Item {
  texto: string
  estado: (typeof estados)[number]
}

export function leerPendientes(db: Database, clave: string): Item[] {
  const fila = db
    .query<{ items: string }, { clave: string }>('SELECT items FROM pendientes WHERE clave = $clave')
    .get({ clave })

  if (!fila) {
    return []
  }

  const datos: unknown = JSON.parse(fila.items)
  const items = parsearItems({ items: datos })

  if (!items) {
    throw new Error(`pendientes: fila "${clave}" sin items`)
  }

  return items
}

export function escribirPendientes(db: Database, clave: string, items: Item[]) {
  return write(db, 'pendientes', () =>
    db
      .query(
        `INSERT INTO pendientes (clave, items, actualizado) VALUES ($clave, $items, $ahora)
         ON CONFLICT (clave) DO UPDATE SET items = excluded.items, actualizado = excluded.actualizado`,
      )
      .run({ clave, items: JSON.stringify(items), ahora: Date.now() }),
  )
}

export function parsearItems(input: unknown): Item[] | undefined {
  const entrada = input ?? {}

  if (!esRegistro(entrada)) {
    throw new Error('pendientes: se esperaba un objeto')
  }

  if (entrada.items === undefined) {
    return undefined
  }

  if (!Array.isArray(entrada.items)) {
    throw new Error('pendientes: `items` tiene que ser una lista')
  }

  return entrada.items.map((item: unknown, indice) => {
    if (!esRegistro(item) || typeof item.texto !== 'string' || !item.texto.trim()) {
      throw new Error(`pendientes: items[${indice}] sin \`texto\``)
    }

    const estado = item.estado ?? 'pendiente'
    const validado = estados.find((candidato) => candidato === estado)

    if (!validado) {
      throw new Error(`pendientes: items[${indice}].estado tiene que ser ${estados.join(', ')}`)
    }

    return { texto: item.texto, estado: validado }
  })
}

const marca: Record<Item['estado'], string> = { pendiente: '[ ]', en_curso: '[~]', hecho: '[x]', descartado: '[-]' }

export const formatear = (items: Item[]) =>
  items.length
    ? items.map((item, indice) => `${indice + 1}. ${marca[item.estado]} ${item.texto}`).join('\n')
    : '(la lista está vacía)'
