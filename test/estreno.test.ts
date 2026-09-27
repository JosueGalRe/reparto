import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, expect, spyOn, test } from 'bun:test'

import { continuacion, decidirContinuacion, decisionGuardada } from '../src/continuacion.ts'
import { openDb } from '../src/db.ts'
import { clavePlan, estreno, evaluarEstreno, planDeSesion, registrarEstreno, tareas } from '../src/estreno.ts'
import { log } from '../src/log.ts'
import { escribirPendientes, leerPendientes } from '../src/pendientes.ts'
import { proceso } from '../src/process.ts'

import type { Plugin } from '@opencode/plugin'

const dir = mkdtempSync(join(tmpdir(), 'reparto-estreno-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))
const db = openDb(join(dir, 'estreno.db'))
const plan = '.reparto/planes/demo.md'
const contenido = '## Tasks\n\n### T1: first\n- Do: a\n\n### T2: second\n- Do: b\n'
const verdict = JSON.stringify({ veredicto: 'APROBADO', objeciones: [], notas: [], cierres: {} })

function ensayado(nombre: string, hash: string, ronda: number, veredicto = verdict) {
  for (const revisor of ['critico', 'oracle']) {
    db.query("INSERT INTO ensayos (plan, ronda, hash, revisor, actor, veredicto) VALUES (?, ?, ?, ?, 'p/m', ?)").run(
      nombre,
      ronda,
      hash,
      revisor,
      veredicto,
    )
  }
}

test('estreno accepts two approvals on current hash, seeds tasks and resumes instead of resetting', () => {
  // Given: both reviewers approved exactly the current version.
  const nombre = `${plan}-approved`

  ensayado(nombre, 'A', 1)
  // When: Bryan invokes the command for the version twice, with progress in between.
  const ref = { plan: nombre, hash: 'A' }
  const first = registrarEstreno(db, ref, contenido, false)

  escribirPendientes(db, clavePlan(ref), [{ ...first.items[0]!, estado: 'hecho' }, first.items[1]!])
  const resumed = registrarEstreno(db, ref, contenido, false)

  // Then: the first task stays done and the second remains pending.
  expect(first.estreno.tipo).toBe('normal')
  expect(resumed.items.map((item) => item.estado)).toEqual(['hecho', 'pendiente'])
  expect(tareas(contenido).map((item) => item.texto)).toEqual(['T1: first', 'T2: second'])
})

test('planDeSesion encuentra la sesión ligada por registrarEstreno', () => {
  // Given: un plan aprobado con tareas pendientes.
  const ref = { plan: `${plan}-sesion`, hash: 'A' }

  ensayado(ref.plan, ref.hash, 1)
  // When: el estreno reserva la sesión del regidor.
  registrarEstreno(db, ref, contenido, false, 'ses_regidor_demo')

  // Then: la sesión apunta al plan estrenado.
  expect(planDeSesion(db, 'ses_regidor_demo')).toEqual(ref)
})

test('planDeSesion devuelve undefined cuando no hay sesión ligada', () => {
  // Given: una sesión sin estreno.
  // When: se consulta su plan; Then: conserva el contrato de ausencia.
  expect(planDeSesion(db, 'ses_sin_estreno')).toBeUndefined()
})

test('continuación falla si falta la fila insertada antes de decidir', () => {
  // Given: SQLite elimina la fila justo después del INSERT, antes del SELECT.
  const database = openDb(join(dir, 'continuacion-sin-fila.db'))
  const error = spyOn(log, 'error').mockImplementation(() => {})

  try {
    database.run(`CREATE TRIGGER borrar_continuacion AFTER INSERT ON continuaciones BEGIN
      DELETE FROM continuaciones WHERE sesion = NEW.sesion;
    END`)

    // When: se intenta decidir; Then: no se emite una continuación con estado inexistente.
    expect(decisionGuardada(database, 'ses_sin_fila', { plan: 'plan', hash: 'A' }, 'evento-sin-fila')).toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      'escritura en SQLite falló',
      expect.objectContaining({
        error: expect.stringContaining('falta estado de ses_sin_fila después de insertarlo'),
      }),
    )
    expect(database.query('SELECT * FROM continuacion_eventos').all()).toEqual([])
  } finally {
    error.mockRestore()
    database.close()
  }
})

test('estreno falla si falta la fila insertada antes de devolverla', () => {
  // Given: un ensayo aprobado y un trigger que elimina el estreno tras insertarlo.
  const database = openDb(join(dir, 'estreno-sin-fila.db'))

  try {
    for (const revisor of ['critico', 'oracle']) {
      database
        .query(
          "INSERT INTO ensayos (plan, ronda, hash, revisor, actor, veredicto) VALUES ('plan-sin-fila', 1, 'A', ?, 'p/m', ?)",
        )
        .run(revisor, verdict)
    }

    database.run(`CREATE TRIGGER borrar_estreno AFTER INSERT ON estrenos BEGIN
      DELETE FROM estrenos WHERE plan = NEW.plan;
    END`)

    // When: se estrena; Then: la transacción se revierte sin devolver un registro nulo.
    expect(() => registrarEstreno(database, { plan: 'plan-sin-fila', hash: 'A' }, contenido, false)).toThrow(
      /no se pudo guardar en SQLite/,
    )
    expect(
      database.query('SELECT * FROM pendientes WHERE clave = ?').all(clavePlan({ plan: 'plan-sin-fila', hash: 'A' })),
    ).toEqual([])
  } finally {
    database.close()
  }
})

test('estreno refuses an edited current file even after version A was approved', () => {
  // Given: A was reviewed; When: current content hashes as B; Then: no estreno.
  const nombre = `${plan}-edit`

  ensayado(nombre, 'A', 1)
  expect(() => evaluarEstreno(db, nombre, 'B', false)).toThrow(/cambió.*versión ensayada/)
  registrarEstreno(db, { plan: nombre, hash: 'A' }, contenido, false)
  expect(() => registrarEstreno(db, { plan: nombre, hash: 'B' }, `${contenido}edited`, false)).toThrow(
    /cambió después del estreno/,
  )
})

test('con-objeciones requires completed fifth round and retains the open acta', () => {
  // Given: five completed rounds without approval, with an open objection.
  const nombre = `${plan}-fifth`
  const objeciones = JSON.stringify({ veredicto: 'OBJECIONES', objeciones: [{ seccion: 'T1' }], notas: [], cierres: {} })

  for (let ronda = 1; ronda <= 5; ronda++) {
    ensayado(nombre, 'A', ronda, objeciones)
  }

  db.query(
    "INSERT INTO acta (plan, id, objecion, causa, condicion_cierre, ronda_entrada, estado) VALUES (?, 1, 'T1: risk', 'data', 'fix', 1, 'abierto')",
  ).run(nombre)
  // When: Bryan invokes the override; Then: the open objection is recorded.
  expect(() => evaluarEstreno(db, nombre, 'A', false)).toThrow(/quedan objeciones/)
  const result = registrarEstreno(db, { plan: nombre, hash: 'A' }, contenido, true)

  expect(result.estreno.tipo).toBe('con_objeciones')
  expect(JSON.parse(result.estreno.objeciones)).toMatchObject([{ id: 1, estado: 'abierto' }])
  const temprano = `${plan}-early`

  ensayado(temprano, 'A', 4, objeciones)
  expect(() => evaluarEstreno(db, temprano, 'A', true)).toThrow(/requiere 5 rondas/)
})

test('continuation: idle continues, background waits, interrupt blocks, unchanged twice stops', () => {
  // Given: two unfinished tasks and no prior continuation.
  const items = tareas(contenido)
  const empty = { firma: null, intentos: 0, interrumpido: 0, detenido: 0 }

  // When: the session becomes idle; Then: one continuation is allowed.
  expect(decidirContinuacion(items, 0, empty)).toEqual({ tipo: 'continuar', intentos: 1 })
  expect(decidirContinuacion(items, 2, empty).tipo).toBe('esperar')
  expect(decidirContinuacion(items, 0, { ...empty, interrumpido: 1 }).tipo).toBe('interrumpido')
  expect(decidirContinuacion(items, 0, { ...empty, firma: JSON.stringify(items), intentos: 2 }).tipo).toBe('detener')
  expect(
    decidirContinuacion([{ ...items[0]!, estado: 'hecho' }, items[1]!], 0, {
      ...empty,
      firma: JSON.stringify(items),
      intentos: 2,
    }),
  ).toEqual({ tipo: 'continuar', intentos: 1 })
})

test('native background children suppress continuation until they close', () => {
  // Given: a seeded plan and two running native children (no encargo rows).
  const ref = { plan: `${plan}-bg`, hash: 'A' }
  const sesion = `ses_${crypto.randomUUID()}`

  escribirPendientes(db, clavePlan(ref), tareas(contenido))

  // When: the regidor goes idle; Then: it waits rather than prompting itself.
  expect(decisionGuardada(db, sesion, ref, 'bg-1', 2)?.decision.tipo).toBe('esperar')
  expect(decisionGuardada(db, sesion, ref, 'bg-2', 0)?.decision.tipo).toBe('continuar')
  expect(leerPendientes(db, clavePlan(ref))).toHaveLength(2)
})

test('two location instances receiving the same event consume one continuation', () => {
  // Given: one unfinished plan and a duplicate event delivered to two instances.
  const ref = { plan: `${plan}-event`, hash: 'A' }

  escribirPendientes(db, clavePlan(ref), tareas(contenido))
  // When: both handlers claim the same event; Then: only one consumes an attempt.
  const first = decisionGuardada(db, 'ses_event', ref, 'event-1')
  const second = decisionGuardada(db, 'ses_event', ref, 'event-1')

  expect(first?.decision.tipo).toBe('continuar')
  expect(second).toBeUndefined()
  expect(db.query("SELECT intentos FROM continuaciones WHERE sesion = 'ses_event'").get()).toEqual({ intentos: 1 })
})

test('two plugin instances handling one event send one prompt', async () => {
  // Given: two independent plugin handlers subscribed to the same event.
  const ref = { plan: `${plan}-handlers`, hash: 'A' }

  ensayado(ref.plan, ref.hash, 1)
  registrarEstreno(db, ref, contenido, false, 'ses_handlers')
  const previous = proceso.db

  proceso.db = db
  const prompts: string[] = []
  const ctx = {
    session: {
      get: async () => ({ agent: 'regidor' }),
      prompt: async (input: { text: string }) => {
        prompts.push(input.text)
      },
    },
  } as unknown as Plugin.Context

  try {
    // When: both see the same id; Then: the event creates just one continuation prompt.
    const event = { id: 'event-handlers', type: 'session.execution.succeeded', data: { sessionID: 'ses_handlers' } }

    await Promise.all([continuacion(ctx).evento(event), continuacion(ctx).evento(event)])
    expect(prompts).toHaveLength(1)
  } finally {
    proceso.db = previous
  }
})

test('same relative name in two locations does not share an ensayo or estreno', () => {
  // Given: identical relative plan names but distinct canonical paths.
  const rutaA = `/repo/a/${plan}`
  const rutaB = `/repo/b/${plan}`

  ensayado(rutaA, 'A', 1)
  // When: the second location attempts estreno; Then: it lacks its own review.
  expect(() => registrarEstreno(db, { plan: rutaB, hash: 'A' }, contenido, false)).toThrow(/no tiene ensayo/)
  expect(registrarEstreno(db, { plan: rutaA, hash: 'A' }, contenido, false).estreno.plan).toBe(rutaA)
  expect(db.query('SELECT plan FROM estrenos WHERE plan = ?').get(rutaB)).toBeNull()
})

test('concurrent estreno reservations reuse the active session', () => {
  // Given: two approvals and two callers racing for the same plan and hash.
  const name = `${plan}-race`

  ensayado(name, 'A', 1)
  // When: each reserves under BEGIN IMMEDIATE; Then: only the winner owns a regidor session.
  const first = registrarEstreno(db, { plan: name, hash: 'A' }, contenido, false, 'ses_first')
  const second = registrarEstreno(db, { plan: name, hash: 'A' }, contenido, false, 'ses_second')

  expect(first.nueva).toBe(true)
  expect(second).toMatchObject({ nueva: false, activa: 'ses_first' })
  expect(db.query('SELECT count(*) AS n FROM sesiones_regidor WHERE plan = ?').get(name)).toEqual({ n: 1 })
})

test('an existing estreno with a different hash refuses reservation', () => {
  // Given: a valid estreno for version A; When: B attempts a new regidor; Then: refusal.
  const name = `${plan}-mismatch`

  ensayado(name, 'A', 1)
  registrarEstreno(db, { plan: name, hash: 'A' }, contenido, false, 'ses_old')
  expect(() => registrarEstreno(db, { plan: name, hash: 'B' }, contenido, false, 'ses_new')).toThrow(
    /cambió después del estreno/,
  )
  expect(db.query('SELECT sesion FROM sesiones_regidor WHERE plan = ?').all(name)).toEqual([{ sesion: 'ses_old' }])
})

test('two simultaneous estreno commands create just one regidor session', async () => {
  // Given: two nonempty caller sessions and one approved plan.
  const location = join(dir, 'race-location')
  const path = join(location, '.reparto/planes/demo.md')

  mkdirSync(join(location, '.reparto/planes'), { recursive: true })
  writeFileSync(path, contenido)
  ensayado(path, createHash('sha256').update(contenido).digest('hex'), 1)
  const previous = proceso.db

  proceso.db = db
  let created = 0
  const prompts: string[] = []
  const ctx = {
    session: {
      get: async () => ({ location: { directory: location } }),
      context: async () => [{ type: 'user' }],
      create: async () => ({ id: `ses_race_${++created}`, title: 'regidor · demo' }),
      prompt: async (input: { sessionID: string }) => {
        prompts.push(input.sessionID)
      },
    },
  } as unknown as Plugin.Context

  try {
    // When: both command invocations race; Then: only one creates and starts a regidor.
    await Promise.all(
      ['caller-a', 'caller-b'].map((sessionID) =>
        estreno(ctx)({ sessionID, prompt: { text: '/estreno .reparto/planes/demo.md' } }),
      ),
    )
    expect(created).toBe(1)
    expect(db.query('SELECT sesion FROM sesiones_regidor WHERE plan = ?').all(path)).toEqual([{ sesion: 'ses_race_1' }])
    expect(prompts.filter((id) => id === 'ses_race_1')).toHaveLength(1)
    expect(prompts).toContain('caller-b')
  } finally {
    proceso.db = previous
  }
})

for (const failure of ['switch', 'delivery'] as const) {
  test(`failed ${failure} releases the reservation so retry starts the regidor`, async () => {
    // Given: an approved plan and an empty session whose first switch or delivery fails.
    const location = join(dir, `retry-${failure}`)
    const path = join(location, '.reparto/planes/demo.md')

    mkdirSync(join(location, '.reparto/planes'), { recursive: true })
    writeFileSync(path, contenido)
    const hash = createHash('sha256').update(contenido).digest('hex')

    ensayado(path, hash, 1)
    const previous = proceso.db

    proceso.db = db
    let switches = 0
    let prompts = 0
    const deliveries: { sessionID: string; metadata?: Record<string, unknown> }[] = []
    const ctx = {
      session: {
        get: async () => ({ location: { directory: location } }),
        context: async () => [],
        switchAgent: async () => {
          if (++switches === 1 && failure === 'switch') {
            throw new Error('switch failed')
          }
        },
        prompt: async (input: { sessionID: string; metadata?: Record<string, unknown> }) => {
          if (++prompts === 1 && failure === 'delivery') {
            throw new Error('delivery failed')
          }

          deliveries.push(input)
        },
      },
    } as unknown as Plugin.Context
    const sessionID = `ses_retry_${failure}`
    const command = () => estreno(ctx)({ sessionID, prompt: { text: '/estreno .reparto/planes/demo.md' } })

    try {
      // When: the first call fails; Then: the estreno and tasks remain, but the reservation does not.
      await expect(command()).rejects.toThrow(`${failure} failed`)
      expect(db.query('SELECT sesion FROM sesiones_regidor WHERE plan = ?').all(path)).toEqual([])
      expect(db.query('SELECT hash FROM estrenos WHERE plan = ?').get(path)).toEqual({ hash })
      expect(leerPendientes(db, clavePlan({ plan: path, hash }))).toHaveLength(2)
      // When: Bryan retries; Then: this session switches and receives the plan once.
      await command()
      expect(switches).toBe(2)
      expect(db.query('SELECT sesion FROM sesiones_regidor WHERE plan = ?').all(path)).toEqual([{ sesion: sessionID }])
      expect(deliveries).toMatchObject([{ sessionID, metadata: { repartoInicio: true } }])
    } finally {
      proceso.db = previous
    }
  })
}
