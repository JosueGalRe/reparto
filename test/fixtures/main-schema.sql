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
CREATE TABLE IF NOT EXISTS permisos (
  request_id TEXT PRIMARY KEY,
  hija TEXT NOT NULL,
  action TEXT NOT NULL,
  resources TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'respondido'))
);
