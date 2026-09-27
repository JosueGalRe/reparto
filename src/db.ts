import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, log } from "./log.ts";
import { proceso } from "./process.ts";

export const defaultDbPath = join(dataDir, "reparto.db");

// La sesión hija sigue siendo la fuente de verdad de la ejecución (ADR 0010): acá va solo lo que V2 no guarda.
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
CREATE TABLE IF NOT EXISTS encargos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hija TEXT NOT NULL,
  padre TEXT NOT NULL,
  a TEXT NOT NULL,
  actor TEXT NOT NULL,
  background INTEGER NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('en_cola', 'corriendo', 'terminado', 'fallido', 'interrumpido', 'estancado')),
  desde INTEGER,
  cerrado INTEGER,
  mensaje_final TEXT,
  error TEXT,
  aviso_pendiente INTEGER NOT NULL DEFAULT 0,
  boot_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  starttime TEXT NOT NULL,
  creado INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS encargos_abierto ON encargos (hija) WHERE estado IN ('en_cola', 'corriendo', 'estancado');
CREATE TABLE IF NOT EXISTS bitacora (
  hija TEXT NOT NULL,
  mensaje TEXT NOT NULL,
  llamada TEXT NOT NULL,
  tool TEXT NOT NULL,
  argumentos TEXT NOT NULL,
  resultado TEXT,
  estado TEXT NOT NULL,
  hora INTEGER NOT NULL,
  PRIMARY KEY (hija, mensaje, llamada)
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
CREATE TABLE IF NOT EXISTS permisos (
  request_id TEXT PRIMARY KEY,
  hija TEXT NOT NULL,
  action TEXT NOT NULL,
  resources TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'respondido'))
);
`;

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(schema);
  return db;
}

/** Una conexión por proceso, compartida por todas las locations. */
export const db = (): Database => (proceso.db ??= openDb(defaultDbPath));

const isBusy = (error: unknown) => error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_BUSY");

/**
 * Transacción corta (IMMEDIATE). SQLite respeta busy_timeout pero no garantiza turno (S5): un SQLITE_BUSY se
 * reintenta una vez; si vuelve a fallar queda en el log y devuelve undefined. Nunca lanza.
 */
export function write<T>(database: Database, what: string, fn: () => T): T | undefined {
  for (let attempt = 1; ; attempt++) {
    try {
      return database.transaction(fn).immediate();
    } catch (error) {
      if (isBusy(error) && attempt === 1) continue;
      log.error("escritura en SQLite falló", { what, attempt, error: String(error) });
      return undefined;
    }
  }
}
