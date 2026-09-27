import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { db, openDb } from '../src/db.ts'
import { encargos } from '../src/encargos.ts'
import { ensayo } from '../src/ensayo.ts'
import { abiertos, proceso } from '../src/process.ts'

import { sesionesDobles } from './dobles-utils.ts'

type Sesiones = Parameters<typeof encargos>[0]['session']
const actor = { model: 'kimi/revisor', variant: 'thinking' }
const veredicto = `VEREDICTO: APROBADO\nNOTA: ${'x'.repeat(9_000)}\nACTA: 1 | cerrado`
const previo = { db: proceso.db, validacion: proceso.validacion, abiertos: proceso.abiertos, cerrando: proceso.cerrando }
let directorio: string

beforeEach(() => {
  Object.assign(previo, {
    db: proceso.db,
    validacion: proceso.validacion,
    abiertos: proceso.abiertos,
    cerrando: proceso.cerrando,
  })
  directorio = mkdtempSync(join(tmpdir(), 'reparto-delegar-'))
  proceso.db = openDb(join(directorio, 'test.db'))
  proceso.abiertos = new Map()
  proceso.cerrando = new Set()
  proceso.validacion = {
    actores: new Map([
      ['critico', [{ model: 'openai/titular' }, actor]],
      ['oracle', [{ model: 'anthropic/oracle' }]],
    ]),
    exclusiones: [],
    desactivados: [],
    desconocidos: [],
  }
})

afterEach(() => {
  proceso.db?.close()
  Object.assign(proceso, previo)
  rmSync(directorio, { recursive: true, force: true })
})

const inesperado = async () => {
  throw new Error('método inesperado')
}

function preparar() {
  const control = new AbortController()
  const tool = { sessionID: 'ses_padre', signal: control.signal }
  const creaciones: Parameters<Sesiones['create']>[0][] = []
  const prompts: Parameters<Sesiones['prompt']>[0][] = []
  const sesiones = new Map<string, Awaited<ReturnType<Sesiones['get']>>>()
  const ctx: { session: Sesiones } = {
    session: sesionesDobles({
      get: async ({ sessionID }) => {
        if (sessionID === tool.sessionID) {
          return {
            agent: 'dramaturgo',
            model: { providerID: 'openai', id: 'autor' },
            location: { directory: directorio },
            time: {},
          }
        }

        const sesion = sesiones.get(sessionID)

        if (!sesion) {
          throw new Error(`sesión inesperada: ${sessionID}`)
        }

        return sesion
      },
      create: async (entrada) => {
        if (!entrada) {
          throw new Error('creación sin entrada')
        }

        const id = `ses_revisor_${creaciones.push(entrada)}`

        sesiones.set(id, {
          location: { directory: directorio },
          time: { idle: Number.MAX_SAFE_INTEGER },
          outcome: 'succeeded',
          metadata: entrada.metadata ?? undefined,
          title: entrada.title ?? undefined,
          model: entrada.model ?? undefined,
        })

        return { id }
      },
      prompt: async (entrada) => {
        await ctx.session.get({ sessionID: entrada.sessionID })
        prompts.push(entrada)
      },
      context: async ({ sessionID }) => {
        await ctx.session.get({ sessionID })

        return [{ type: 'assistant', content: [{ type: 'text', text: veredicto }] }]
      },
      wait: async ({ sessionID }) => {
        await ctx.session.get({ sessionID })
      },
      interrupt: inesperado,
    }),
  }
  const ejecutar = encargos(ctx)

  return { ctx, ejecutar, control, tool, creaciones, prompts }
}

test('delegar conserva el veredicto completo y el actor elegido antes del prompt', async () => {
  // Given: el actor elegido difiere del titular y el veredicto supera el antiguo tope textual.
  const { ejecutar, tool, creaciones, prompts } = preparar()

  // When: corre el ejecutor real sobre SQLite.
  const hija = await ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa el plan' }, tool, actor)

  // Then: persiste el resultado íntegro y crea la hija con su dueño y actor, sin pasar skills.
  expect(db().query('SELECT estado, mensaje_final, actor, padre FROM encargos WHERE hija = ?').get(hija)).toEqual({
    estado: 'terminado',
    mensaje_final: veredicto,
    actor: 'kimi/revisor#thinking',
    padre: tool.sessionID,
  })
  expect(creaciones).toMatchObject([
    {
      agent: 'critico',
      model: { providerID: 'kimi', id: 'revisor', variant: 'thinking' },
      metadata: { padre: tool.sessionID },
      location: { directory: directorio },
    },
  ])
  expect(prompts).toEqual([{ sessionID: hija, text: 'Revisa el plan' }])
  expect(abiertos().has(hija)).toBe(false)
})

function retener(sesiones: Sesiones) {
  const esperando = Promise.withResolvers<string>()
  const terminado = Promise.withResolvers<void>()

  sesiones.wait = async ({ sessionID }) => {
    esperando.resolve(sessionID)
    await terminado.promise
  }

  return { esperando, terminado }
}

test('delegar cancela por signal y retira el listener al terminar', async () => {
  // Given: wait está pendiente y una interrupción no debe leer el contexto.
  const { ctx, ejecutar, tool, control } = preparar()
  const { esperando, terminado } = retener(ctx.session)
  const interrupciones: string[] = []

  ctx.session.context = inesperado
  ctx.session.interrupt = async ({ sessionID }) => {
    interrupciones.push(sessionID)
    const sesion = await ctx.session.get({ sessionID })

    sesion.outcome = 'interrupted'
    terminado.resolve()
  }

  const pendiente = ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)
  const hija = await esperando.promise

  // When: se cancela mientras espera.
  control.abort()
  await pendiente

  // Then: cierra interrumpido y un nuevo evento de abort no vuelve a llamar al SDK.
  tool.signal.dispatchEvent(new Event('abort'))
  expect(interrupciones).toEqual([hija])
  expect(db().query('SELECT estado FROM encargos WHERE hija = ?').get(hija)).toEqual({ estado: 'interrumpido' })
  expect(abiertos().has(hija)).toBe(false)
})

test('el permiso del revisor avisa a su padre una sola vez aunque se repitan eventos', async () => {
  // Given: el revisor está esperando; el aviso al padre sigue el camino de permisos interno.
  const { ctx, ejecutar, tool, prompts } = preparar()
  const { esperando, terminado } = retener(ctx.session)
  const aviso = Promise.withResolvers<void>()
  const prompt = ctx.session.prompt

  ctx.session.prompt = async (entrada) => {
    await prompt(entrada)

    if (entrada.sessionID === tool.sessionID) {
      aviso.resolve()
    }
  }

  const pendiente = ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)
  const hija = await esperando.promise
  const evento = {
    type: 'permission.asked' as const,
    created: Date.now() + 1,
    data: { sessionID: hija, id: 'per_revisor', action: 'read', resources: ['plan.md'] },
  }

  try {
    // When: el mismo request llega dos veces y vuelve a llegar después de replied.
    await Promise.all([ejecutar.evento(evento), ejecutar.evento(evento)])
    await aviso.promise
    await ejecutar.evento({
      type: 'permission.replied',
      created: evento.created + 1,
      data: { sessionID: hija, requestID: 'per_revisor' },
    })
    await ejecutar.evento(evento)

    // Then: hay un único aviso encolado al dueño y un único request persistido.
    expect(prompts.filter((entrada) => entrada.sessionID === tool.sessionID)).toEqual([
      expect.objectContaining({
        delivery: 'queue',
        metadata: { repartoAviso: true },
        text: expect.stringContaining('per_revisor'),
      }),
    ])
    expect(db().query('SELECT request_id, hija FROM permisos').all()).toEqual([{ request_id: 'per_revisor', hija }])
  } finally {
    terminado.resolve()
    await pendiente
  }
})

test('cierres simultáneos ignoran eventos viejos y leen el veredicto una sola vez', async () => {
  // Given: dos instancias observan la misma ejecución, retenida por wait.
  const { ctx, ejecutar, tool } = preparar()
  const { esperando, terminado } = retener(ctx.session)
  const leyendo = Promise.withResolvers<void>()
  const leido = Promise.withResolvers<void>()
  const context = ctx.session.context
  let lecturas = 0

  ctx.session.context = async (entrada) => {
    lecturas++
    leyendo.resolve()
    await leido.promise

    return context(entrada)
  }

  const pendiente = ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)
  const hija = await esperando.promise
  const fila = db().query<{ desde: number }, [string]>('SELECT desde FROM encargos WHERE hija = ?').get(hija)

  try {
    // When: llega el evento viejo, seguido de cierres concurrentes en ambas instancias y wait.
    if (!fila) {
      throw new Error('encargo sin fecha de inicio')
    }

    await ejecutar.evento({ type: 'session.execution.succeeded', created: fila.desde, data: { sessionID: hija } })
    expect(lecturas).toBe(0)
    await Promise.all(
      [ejecutar, encargos(ctx)].map((instancia) =>
        instancia.evento({
          type: 'session.execution.succeeded',
          created: Number.MAX_SAFE_INTEGER,
          data: { sessionID: hija },
        }),
      ),
    )
    await leyendo.promise
  } finally {
    terminado.resolve()
    leido.resolve()
    await pendiente
  }

  // Then: un solo cierre efectivo y ninguna entrada de seguimiento colgada.
  expect(lecturas).toBe(1)
  expect(db().query('SELECT estado, mensaje_final FROM encargos WHERE hija = ?').get(hija)).toEqual({
    estado: 'terminado',
    mensaje_final: veredicto,
  })
  expect(abiertos().size).toBe(0)
  expect(proceso.cerrando?.size).toBe(0)
})

test('un prompt fallido cierra su fila y el reintento crea otra sesión', async () => {
  // Given: el primer envío falla antes de wait.
  const { ctx, ejecutar, tool, control } = preparar()
  const prompt = ctx.session.prompt
  const wait = ctx.session.wait
  let interrupciones = 0

  ctx.session.prompt = async () => {
    throw new Error('fallo de transporte')
  }

  ctx.session.wait = inesperado

  // When: falla y luego se vuelve a delegar con transporte disponible.
  const fallida = await ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)

  ctx.session.prompt = prompt
  ctx.session.wait = wait
  const terminada = await ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)

  ctx.session.interrupt = async () => {
    interrupciones++
  }

  control.abort()
  // Then: no retoma ni sobrescribe la fallida, y ambos listeners se retiraron.
  expect(terminada).not.toBe(fallida)
  expect(db().query('SELECT estado FROM encargos ORDER BY id').all()).toEqual([{ estado: 'fallido' }, { estado: 'terminado' }])
  expect(interrupciones).toBe(0)
  expect(abiertos().size).toBe(0)
})

test('interrumpir rechaza al ajeno aunque el revisor no tenga parentID nativo', async () => {
  // Given: una hija real del ejecutor, ligada por metadata.padre.
  const { ejecutar, tool } = preparar()
  const hija = await ejecutar.delegar({ revisor: 'critico', prompt: 'Revisa' }, tool, actor)

  // When/Then: otro padre no puede interrumpirla.
  await expect(ejecutar.interrumpir({ id: hija }, { sessionID: 'ses_ajena' })).rejects.toThrow(
    'no es un encargo de esta sesión',
  )
})

test('un ensayo completo usa ambos delegar reales y no relanza una ronda ya cerrada', async () => {
  // Given: un plan local y revisores reales con contexto SDK doble.
  const { ctx, ejecutar, tool, creaciones } = preparar()

  await Bun.write(join(directorio, '.reparto/planes/demo.md'), '# Plan\n')
  const ensayar = ensayo(ctx, ejecutar)

  // When: se completa el ensayo y se repite sin modificar el plan.
  const primera = await ensayar({ plan: '.reparto/planes/demo.md' }, tool)
  const repetida = await ensayar({ plan: '.reparto/planes/demo.md' }, tool)

  // Then: ambos veredictos cierran la misma ronda y el reintento no crea hijas.
  expect(JSON.parse(primera.content)).toMatchObject({ cerrado: true, ronda: 1 })
  expect(JSON.parse(repetida.content)).toMatchObject({ cerrado: true, ronda: 1 })
  expect(creaciones).toHaveLength(2)
})
