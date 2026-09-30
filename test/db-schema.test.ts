import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'

import { db, ensureSchema } from '../src/db.ts'
import { proceso } from '../src/process.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-migration-'))

afterAll(() => {
  proceso.db?.close()
  proceso.db = undefined
  rmSync(dir, { recursive: true, force: true })
})

test('setup schema upgrades the cached connection from main without reconnecting', async () => {
  // Given: a cached connection with only main's phase-one tables.
  const old = new Database(join(dir, 'old.db'), { create: true })

  old.run(await Bun.file(new URL('fixtures/main-schema.sql', import.meta.url)).text())
  proceso.db = old
  // When: a new module's setup reapplies its idempotent schema.
  ensureSchema(db())
  // Then: phase-two tables exist on the very same connection.
  expect(db()).toBe(old)
  expect(
    old.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('versiones', 'ensayos', 'acta')").all(),
  ).toHaveLength(3)
})
