import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'

import { dataDir, log } from './log.ts'
import { proceso } from './process.ts'

const defaultDbPath = join(dataDir, 'reparto.db')

// Acá va solo lo que V2 no guarda (ADR 0010). En `versiones`, `ensayos` y `acta`, `plan` es el id de la sesión
// Del Dramaturgo (ADR 0014). Las tablas de encargos, estrenos y continuaciones quedan huérfanas en bases viejas.
const schema = `
CREATE TABLE IF NOT EXISTS bajas (
  tipo TEXT NOT NULL CHECK (tipo IN ('proveedor', 'actor')),
  id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  hasta INTEGER NOT NULL,
  PRIMARY KEY (tipo, id)
);
CREATE TABLE IF NOT EXISTS pendientes (
  clave TEXT PRIMARY KEY,
  items TEXT NOT NULL,
  actualizado INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versiones (
  plan TEXT NOT NULL,
  hash TEXT NOT NULL,
  contenido TEXT NOT NULL,
  PRIMARY KEY (plan, hash)
);
CREATE TABLE IF NOT EXISTS ensayos (
  plan TEXT NOT NULL,
  ronda INTEGER NOT NULL,
  hash TEXT NOT NULL,
  revisor TEXT NOT NULL,
  actor TEXT NOT NULL,
  veredicto TEXT NOT NULL,
  PRIMARY KEY (plan, ronda, revisor)
);
CREATE TABLE IF NOT EXISTS acta (
  plan TEXT NOT NULL,
  id INTEGER NOT NULL,
  objecion TEXT NOT NULL,
  causa TEXT NOT NULL,
  condicion_cierre TEXT NOT NULL,
  ronda_entrada INTEGER NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('abierto', 'cerrado')),
  PRIMARY KEY (plan, id)
);
`

/** Reapply additive, idempotent migrations even when the connection survives module reload. */
export function ensureSchema(database: Database): void {
  database.run(schema)
}

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })

  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  ensureSchema(db)

  return db
}

/** Una conexión por proceso, compartida por todas las locations. */
export const db = (): Database => (proceso.db ??= openDb(defaultDbPath))

const isBusy = (error: unknown) => error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_BUSY')

/**
 * Transacción corta (IMMEDIATE). SQLite respeta busy_timeout pero no garantiza turno (S5): un SQLITE_BUSY se
 * reintenta una vez; si vuelve a fallar queda en el log y devuelve undefined. Nunca lanza.
 */
export function write<operacion>(database: Database, what: string, fn: () => operacion): operacion | undefined {
  for (let attempt = 1; ; attempt++) {
    try {
      return database.transaction(fn).immediate()
    } catch (error) {
      if (isBusy(error) && attempt === 1) {
        continue
      }

      log.error('escritura en SQLite falló', { what, attempt, error: String(error) })

      return undefined
    }
  }
}
