import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'

import { openDb } from '../src/db.ts'
import { argumentoClave, encargos, hijosNativos, leer, posterior, tituloEncargo, transicion } from '../src/encargos.ts'
import { proceso } from '../src/process.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-encargos-'))

beforeAll(() => {
  proceso.db = openDb(join(dir, 'e.db'))
})
afterAll(() => {
  proceso.db?.close()
  proceso.db = undefined
  rmSync(dir, { recursive: true, force: true })
})

function crear(estado: string) {
  return Number(
    proceso
      .db!.query(
        `INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
         VALUES ($hija, 'ses_p', 'rapido', 'openai/x', 1, $estado, 'b', 1, '1', 0)`,
      )
      .run({ hija: `ses_${crypto.randomUUID()}`, estado }).lastInsertRowid,
  )
}

test('transición atómica: de dos instancias con la misma foto, gana una sola', () => {
  const foto = leer(crear('corriendo'))!

  expect(transicion(foto, 'terminado', { mensaje_final: 'ok' })).toBe(true)
  expect(transicion(foto, 'fallido')).toBe(false)
  expect(leer(foto.id)).toMatchObject({ estado: 'terminado', mensaje_final: 'ok' })
})

test('transiciones no permitidas: los terminales no se reabren y en_cola no termina sin correr', () => {
  expect(transicion(leer(crear('terminado'))!, 'corriendo')).toBe(false)
  expect(transicion(leer(crear('en_cola'))!, 'terminado')).toBe(false)
  expect(transicion(leer(crear('estancado'))!, 'corriendo')).toBe(true)
})

test('un cierre de una ejecución anterior (antes de `desde`) no cuenta para la fila retomada', () => {
  expect(posterior(1_000, 2_000)).toBe(false)
  expect(posterior(2_000, 2_000)).toBe(false)
  expect(posterior(2_001, 2_000)).toBe(true)
  expect(posterior(undefined, 2_000)).toBe(false)
  expect(posterior(5_000, null)).toBe(false)
})

test('argumento clave de una tool call', () => {
  expect(argumentoClave(JSON.stringify({ filePath: '/a/b.ts', limit: 3 }))).toBe('filePath=/a/b.ts')
  expect(argumentoClave(JSON.stringify({ command: 'rg x\n| head' }))).toBe('command=rg x | head')
  expect(argumentoClave(JSON.stringify({ n: 1 }))).toBe('')
})

test('título de encargo resume la primera línea no vacía y recorta a 60 caracteres', () => {
  expect(tituloEncargo('protagonista', `\n  ${'palabra '.repeat(10)}fin\nresto`)).toBe(
    `protagonista · ${`${'palabra '.repeat(7)}palabra `.slice(0, 60)}…`,
  )
  expect(tituloEncargo('rapido', '\n  resumen corto  \nresto')).toBe('rapido · resumen corto')
})

test("bitacora records a native child's tool calls and reads its final message", async () => {
  // Given: a native child without a row in encargos, even after compaction.
  const hija = `ses_${crypto.randomUUID()}`
  const ctx = {
    session: {
      get: async () => ({ parentID: 'ses_p', agent: 'utilero', outcome: 'succeeded' }),
      context: async () => [{ type: 'assistant', content: [{ type: 'text', text: 'Found it' }] }],
    },
  }
  const job = encargos(ctx as never)

  // When: execute.after records a read and bitacora is requested.
  await job.registrarLlamada({
    sessionID: hija,
    messageID: 'msg_1',
    id: 'call_1',
    tool: 'read',
    input: { path: 'src/index.ts' },
    status: 'completed',
    result: { content: 'code' },
  })
  const result = await job.bitacora({ id: hija })

  // Then: the durable tool record and live final answer are visible.
  expect(result.content).toContain('read path=src/index.ts')
  expect(result.content).toContain('Found it')
})

test("interrumpir accepts only the caller's native child", async () => {
  // Given: a native child belonging to another parent.
  const hija = `ses_${crypto.randomUUID()}`
  let interrupted = 0
  const ctx = {
    session: {
      get: async () => ({ parentID: 'ses_owner' }),
      interrupt: async () => {
        interrupted++
      },
    },
  }
  const job = encargos(ctx as never)

  // When: a different caller tries, Then: it is rejected without interrupting.
  await expect(job.interrumpir({ id: hija }, { sessionID: 'ses_other' } as never)).rejects.toThrow(
    'no es un encargo de esta sesión',
  )
  expect(interrupted).toBe(0)
  // When: its owner interrupts, Then: V2 receives the interruption.
  await job.interrumpir({ id: hija }, { sessionID: 'ses_owner' } as never)
  expect(interrupted).toBe(1)
})

test('native completion and permission events do not send duplicate text notices', async () => {
  // Given: a tracked native child and a parent prompt spy.
  const hija = `ses_${crypto.randomUUID()}`
  let notices = 0
  const job = encargos({
    session: {
      prompt: async () => {
        notices++
      },
    },
  } as never)

  hijosNativos().set(hija, { padre: 'ses_p', actividad: Date.now(), avisado: false, permiso: false })

  // When: a permission is requested and execution completes; Then: native UX alone handles both.
  job.evento({ type: 'permission.asked', data: { sessionID: hija, id: 'per_1', action: 'read', resources: ['x'] } })
  job.evento({ type: 'session.execution.succeeded', data: { sessionID: hija } })
  expect(notices).toBe(0)
  expect(hijosNativos().has(hija)).toBe(false)
})

test('native stale watcher sends one notice, skips pending permission and stops after completion', async () => {
  // Given: inactive and permission-blocked native children.
  const hija = `ses_${crypto.randomUUID()}`
  const blocked = `ses_${crypto.randomUUID()}`
  const notices: string[] = []
  const ctx = {
    session: {
      prompt: async (entrada: { text: string }) => {
        notices.push(entrada.text)
      },
    },
  }
  const job = encargos(ctx as never)

  hijosNativos().set(hija, { padre: 'ses_p', actividad: 1, avisado: false, permiso: false })
  hijosNativos().set(blocked, { padre: 'ses_p', actividad: 1, avisado: false, permiso: true })
  // When: the watcher runs twice.
  await job.vigilar()
  await job.vigilar()
  // Then: only the inactive child is reported once, without interruption.
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(hija)
  job.evento({ type: 'session.execution.succeeded', data: { sessionID: hija } })
  expect(hijosNativos().has(hija)).toBe(false)
  hijosNativos().delete(blocked)
})
