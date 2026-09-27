import { write } from './db.ts'

import type { Database } from 'bun:sqlite'

export const estados = ['pendiente', 'en_curso', 'hecho', 'descartado'] as const
export interface Item {
  texto: string
  estado: (typeof estados)[number]
}

export function leerPendientes(db: Database, clave: string): Item[] {
  const fila = db.query('SELECT items FROM pendientes WHERE clave = $clave').get({ clave }) as { items: string } | null

  return fila ? (JSON.parse(fila.items) as Item[]) : []
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
  const entrada = (input ?? {}) as { items?: unknown }

  if (entrada.items === undefined) {
    return undefined
  }

  if (!Array.isArray(entrada.items)) {
    throw new Error('pendientes: `items` tiene que ser una lista')
  }

  return entrada.items.map((item, indice) => {
    const registro = (item ?? {}) as Record<string, unknown>

    if (typeof registro.texto !== 'string' || !registro.texto.trim()) {
      throw new Error(`pendientes: items[${indice}] sin \`texto\``)
    }

    const estado = registro.estado ?? 'pendiente'

    if (!estados.includes(estado as Item['estado'])) {
      throw new Error(`pendientes: items[${indice}].estado tiene que ser ${estados.join(', ')}`)
    }

    return { texto: registro.texto, estado: estado as Item['estado'] }
  })
}

const marca: Record<Item['estado'], string> = { pendiente: '[ ]', en_curso: '[~]', hecho: '[x]', descartado: '[-]' }

export const formatear = (items: Item[]) =>
  items.length
    ? items.map((item, indice) => `${indice + 1}. ${marca[item.estado]} ${item.texto}`).join('\n')
    : '(la lista está vacía)'
