import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, expect, test } from 'bun:test'

import { bajasVigentes, registrarBaja } from '../src/bajas.ts'
import { openDb } from '../src/db.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-db-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('WAL, y una baja escrita por otro proceso se ve acá y sobrevive a reabrir la base', async () => {
  const path = join(dir, 'a.db')
  const db = openDb(path)

  expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  const hasta = Date.now() + 3_600_000
  const child = Bun.spawnSync([
    'bun',
    '-e',
    `
    const { openDb } = await import(${JSON.stringify(join(import.meta.dir, '../src/db.ts'))});
    const { registrarBaja } = await import(${JSON.stringify(join(import.meta.dir, '../src/bajas.ts'))});
    registrarBaja(openDb(${JSON.stringify(path)}), { tipo: "proveedor", id: "openai", motivo: "cuota", hasta: ${hasta} });
  `,
  ])

  expect(child.exitCode).toBe(0)
  expect(bajasVigentes(db)).toEqual([{ tipo: 'proveedor', id: 'openai', motivo: 'cuota', hasta }])
  db.close()
  expect(bajasVigentes(openDb(path))).toHaveLength(1)
})

test('ON CONFLICT: la última baja del mismo proveedor reemplaza a la anterior; las vencidas no cuentan', () => {
  const db = openDb(join(dir, 'b.db'))

  registrarBaja(db, { tipo: 'proveedor', id: 'claude-code', motivo: 'plazoBaja', hasta: Date.now() + 1000 })
  registrarBaja(db, { tipo: 'proveedor', id: 'claude-code', motivo: 'resets_at', hasta: Date.now() + 5000 })
  registrarBaja(db, { tipo: 'actor', id: 'openai/gpt-6-sol#medium', motivo: 'auth', hasta: Date.now() - 1 })
  expect(bajasVigentes(db).map((b) => b.motivo)).toEqual(['resets_at'])
})

test('una sola fila abierta por hija', () => {
  const db = openDb(join(dir, 'c.db'))
  const fila = {
    hija: 'ses_x',
    padre: 'ses_p',
    a: 'rapido',
    actor: 'a/b',
    background: 1,
    boot_id: 'b',
    pid: 1,
    starttime: '1',
    creado: 0,
  }
  const insert = db.query(`INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
    VALUES ($hija, $padre, $a, $actor, $background, $estado, $boot_id, $pid, $starttime, $creado)`)

  insert.run({ ...fila, estado: 'corriendo' })
  expect(() => insert.run({ ...fila, estado: 'en_cola' })).toThrow(/UNIQUE/)
  insert.run({ ...fila, estado: 'terminado' })
})
