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

test('argumentoClave no interpreta un array como argumentos de una tool', () => {
  // Given: JSON con un array en lugar de un objeto; When: se resume; Then: no expone índices como claves.
  expect(argumentoClave('["command"]')).toBe('')
})

test.each([null, undefined, 42, 'texto', [], Object.assign([], { id: 'ses_hija' })].map((input) => ({ input })))(
  'interrumpir y bitacora rechazan una entrada no objeto: %j',
  async ({ input }) => {
    // Given: una entrada inválida y un contexto que prohíbe efectos antes de validar.
    let llamadas = 0
    const inesperado = async () => {
      llamadas++
      throw new Error('no debe consultar ni modificar sesiones')
    }
    const gestor = encargos({
      session: {
        get: inesperado,
        create: inesperado,
        context: inesperado,
        prompt: inesperado,
        wait: inesperado,
        interrupt: inesperado,
      },
    })

    // When: las dos tools reciben la entrada; Then: mantienen el error de id sin llegar al SDK.
    await expect(gestor.interrumpir(input, { sessionID: 'ses_padre' })).rejects.toThrow(
      'interrumpir: falta `id` (el id de la sesión hija)',
    )
    await expect(gestor.bitacora(input)).rejects.toThrow('bitacora: falta `id` (el id de la sesión hija)')
    expect(llamadas).toBe(0)
  },
)

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
      context: async () => [],
    },
  } as never)

  const desde = Date.now()

  hijosNativos().set(hija, { padre: 'ses_p', desde, actividad: desde, avisado: false, permisos: new Set() })

  // When: a permission is requested and execution completes; Then: native UX alone handles both.
  await job.evento({
    type: 'permission.asked',
    created: desde + 1,
    data: { sessionID: hija, id: 'per_1', action: 'read', resources: ['x'] },
  })
  await job.evento({ type: 'session.execution.succeeded', created: desde + 2, data: { sessionID: hija } })
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
      context: async () => [],
    },
  }
  const job = encargos(ctx as never)

  hijosNativos().set(hija, { padre: 'ses_p', desde: 0, actividad: 1, avisado: false, permisos: new Set() })
  hijosNativos().set(blocked, { padre: 'ses_p', desde: 0, actividad: 1, avisado: false, permisos: new Set(['per_1']) })
  // When: the watcher runs twice.
  await job.vigilar()
  await job.vigilar()
  // Then: only the inactive child is reported once, without interruption.
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(hija)
  await job.evento({ type: 'session.execution.succeeded', created: 2, data: { sessionID: hija } })
  expect(hijosNativos().has(hija)).toBe(false)
  hijosNativos().delete(blocked)
})

test('a late terminal event cannot remove a continued native child watch', async () => {
  // Given: the same child watched from a newer execution.
  const hija = `ses_${crypto.randomUUID()}`
  const desde = Date.now()
  const vigilancia = { padre: 'ses_p', desde, actividad: desde, avisado: false, permisos: new Set<string>() }

  hijosNativos().set(hija, vigilancia)

  // When: an earlier execution finishes late; Then: the new watch survives.
  await encargos({} as never).evento({ type: 'session.execution.succeeded', created: desde - 1, data: { sessionID: hija } })
  expect(hijosNativos().get(hija)).toBe(vigilancia)
  hijosNativos().delete(hija)
})

test('one permission reply leaves the other pending for the stale watcher', async () => {
  // Given: two outstanding requests on an inactive native child.
  const hija = `ses_${crypto.randomUUID()}`
  const vigilancia = { padre: 'ses_p', desde: 0, actividad: 1, avisado: false, permisos: new Set<string>() }
  const notices: string[] = []
  const job = encargos({
    session: {
      prompt: async ({ text }: { text: string }) => {
        notices.push(text)
      },
    },
  } as never)

  hijosNativos().set(hija, vigilancia)

  // When: one of two requests is answered; Then: no stale notice is sent.
  await job.evento({ type: 'permission.asked', created: 2, data: { sessionID: hija, id: 'per_a' } })
  await job.evento({ type: 'permission.asked', created: 3, data: { sessionID: hija, id: 'per_b' } })
  await job.evento({ type: 'permission.replied', created: 4, data: { sessionID: hija, requestID: 'per_a' } })
  vigilancia.actividad = 1
  await job.vigilar()
  expect(notices).toHaveLength(0)
  expect([...vigilancia.permisos]).toEqual(['per_b'])
  hijosNativos().delete(hija)
})

test('bitacora retains a native final message after context compaction', async () => {
  // Given: a child whose context initially includes its final answer.
  const hija = `ses_${crypto.randomUUID()}`
  let messages = [{ type: 'assistant', content: [{ type: 'text', text: 'Final answer' }] }]
  const job = encargos({
    session: { get: async () => ({ parentID: 'ses_p', agent: 'rapido', outcome: 'succeeded' }), context: async () => messages },
  } as never)

  hijosNativos().set(hija, { padre: 'ses_p', desde: 1, actividad: 1, avisado: false, permisos: new Set() })

  // When: completion is recorded and V2 compacts the context; Then: SQLite supplies the original answer.
  await job.evento({ type: 'session.execution.succeeded', created: 2, data: { sessionID: hija } })
  messages = []
  const result = await job.bitacora({ id: hija })

  expect(result.content).toContain('Mensaje final:\n\nFinal answer')
})

test('bitacora guarda mensaje final nativo íntegro hasta el tope y recortado por encima', async () => {
  // Given: final messages below, at, and above the storage limit.
  const casos = [
    { largo: 31_999, esperado: 'x'.repeat(31_999) },
    { largo: 32_000, esperado: 'x'.repeat(32_000) },
    { largo: 32_001, esperado: `${'x'.repeat(32_000)}\n[… recortado, 1 caracteres más]` },
  ]

  for (const [indice, caso] of casos.entries()) {
    const hija = `ses_${crypto.randomUUID()}`
    const messages = [{ type: 'assistant', content: [{ type: 'text', text: 'x'.repeat(caso.largo) }] }]
    const job = encargos({
      session: {
        get: async () => ({ parentID: 'ses_p', agent: 'rapido', outcome: 'succeeded' }),
        context: async () => messages,
      },
    } as never)

    hijosNativos().set(hija, { padre: 'ses_p', desde: indice + 10, actividad: 1, avisado: false, permisos: new Set() })

    // When: completion is recorded and context is compacted; Then: bitacora returns the stored limit behavior.
    await job.evento({ type: 'session.execution.succeeded', created: indice + 11, data: { sessionID: hija } })
    messages.length = 0
    const result = await job.bitacora({ id: hija })

    expect(result.content).toContain(`Mensaje final:\n\n${caso.esperado}`)
  }
})

test('un mensaje final nativo de una ejecución anterior no pisa el guardado', async () => {
  // Given: the latest execution's final message is already stored.
  const hija = `ses_${crypto.randomUUID()}`
  const job = encargos({
    session: {
      get: async () => ({ parentID: 'ses_p', agent: 'rapido', outcome: 'succeeded' }),
      context: async () => [{ type: 'assistant', content: [{ type: 'text', text: 'Old' }] }],
    },
  } as never)

  proceso.db!.query('INSERT INTO mensajes_hijas (hija, desde, texto) VALUES ($hija, 20, $texto)').run({ hija, texto: 'Latest' })
  hijosNativos().set(hija, { padre: 'ses_p', desde: 10, actividad: 1, avisado: false, permisos: new Set() })

  // When: the older execution completes; Then: the latest stored message remains.
  await job.evento({ type: 'session.execution.succeeded', created: 11, data: { sessionID: hija } })
  expect(proceso.db!.query('SELECT texto FROM mensajes_hijas WHERE hija = $hija').get({ hija })).toEqual({ texto: 'Latest' })
})
