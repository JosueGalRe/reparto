import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { openDb } from '../src/db.ts'
import { escribirPendientes, formatear, leerPendientes, parsearItems } from '../src/pendientes.ts'

test('reescribir y leer la lista de una sesión; otra sesión no la ve', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'reparto-pend-')), 'p.db'))

  escribirPendientes(db, 'ses_a', parsearItems({ items: [{ texto: 'leer' }, { texto: 'delegar', estado: 'en_curso' }] })!)
  escribirPendientes(
    db,
    'ses_a',
    parsearItems({
      items: [
        { texto: 'leer', estado: 'hecho' },
        { texto: 'delegar', estado: 'en_curso' },
      ],
    })!,
  )
  expect(formatear(leerPendientes(db, 'ses_a'))).toBe('1. [x] leer\n2. [~] delegar')
  expect(leerPendientes(db, 'ses_b')).toEqual([])
})

test('sin items es lectura; items inválidos se rechazan', () => {
  expect(parsearItems({})).toBeUndefined()
  expect(() => parsearItems({ items: [{ texto: 'x', estado: 'listo' }] })).toThrow(/estado/)
  expect(() => parsearItems({ items: [{}] })).toThrow(/texto/)
})

test.each(['null', '{}', '42', '[null]', '[[]]', '[{"texto":42}]', '[{"texto":"x","estado":"listo"}]'])(
  'una fila de pendientes corrupta falla: %s',
  (items) => {
    // Given: JSON válido con estructura corrupta en una fila real.
    using database = openDb(':memory:')

    database.query("INSERT INTO pendientes VALUES ('corrupta', ?, 0)").run(items)

    // When: se lee la fila; Then: no se devuelve una lista vacía ni items sin validar.
    expect(() => leerPendientes(database, 'corrupta')).toThrow(/pendientes:.*items/)
  },
)

test('una fila de pendientes con sintaxis JSON rota propaga el error', () => {
  // Given: una fila truncada, no una sesión sin lista.
  using database = openDb(':memory:')

  database.query("INSERT INTO pendientes VALUES ('truncada', '[', 0)").run()

  // When: se lee; Then: conserva el error de JSON.parse.
  expect(() => leerPendientes(database, 'truncada')).toThrow(SyntaxError)
})

test.each([42, 'texto', [], true].map((input) => ({ input })))('pendientes rechaza una entrada no objeto: %j', ({ input }) => {
  // Given: una entrada no objeto; When: se parsea; Then: no cuenta como una lectura sin items.
  expect(() => parsearItems(input)).toThrow('pendientes: se esperaba un objeto')
})
