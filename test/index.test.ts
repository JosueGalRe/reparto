import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, jest, test } from 'bun:test'

import { suscribir } from '../src/index.ts'

test.each([{ debug: false }, { debug: true }])('setup registra los hooks antes de las tools: %j', async ({ debug }) => {
  // Given: otro proceso aísla REPARTO_DEBUG, que se lee al importar hooks.ts.
  const directorio = mkdtempSync(join(tmpdir(), 'reparto-hooks-'))

  try {
    await Bun.write(join(directorio, 'reparto.jsonc'), '{}')
    const resultado = Bun.spawnSync({
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, REPARTO_DEBUG: debug ? '1' : '', REPARTO_DATA_DIR: join(directorio, 'data') },
      timeout: 5_000,
      // When: el setup real recibe registros SDK que anotan su orden, sin ejecutar los callbacks registrados.
      cmd: [
        process.execPath,
        '--eval',
        `
          import plugin from './src/index.ts'
          import { proceso } from './src/process.ts'

          const directorio = ${JSON.stringify(directorio)}
          const orden = []
          const cerrado = Promise.withResolvers()
          const registrar = async (nombre) => {
            orden.push(nombre)
            return { dispose: async () => {} }
          }
          const intervalo = globalThis.setInterval
          globalThis.setInterval = (callback, plazo) => {
            orden.push('timer')
            return intervalo(callback, plazo)
          }
          const cleanup = await plugin.setup({
            options: { config: directorio + '/reparto.jsonc' },
            location: { directory: directorio },
            app: { version: 'test' },
            model: { transform: () => registrar('model.transform') },
            agent: { transform: () => registrar('agent.transform') },
            command: { transform: () => registrar('command.transform') },
            session: { hook: (nombre) => registrar('session.' + nombre) },
            permission: { hook: (nombre) => registrar('permission.' + nombre) },
            tool: {
              transform: () => registrar('tool.transform'),
              hook: (nombre) => registrar('tool.' + nombre),
            },
            event: {
              async *subscribe({ signal }) {
                orden.push('event.subscribe')
                await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
                cerrado.resolve()
              },
            },
          })
          try {
            if (!cleanup) { throw new Error('setup no devolvió cleanup') }
            cleanup()
            await cerrado.promise
            console.log(JSON.stringify(orden))
          } finally {
            cleanup?.()
            globalThis.setInterval = intervalo
            proceso.db?.close()
          }
        `,
      ],
    })

    // Then: execute.after precede a tool.transform sin cambiar el orden de los hooks de sesión.
    expect(resultado.exitCode).toBe(0)
    expect(JSON.parse(resultado.stdout.toString())).toEqual([
      'model.transform',
      'agent.transform',
      'command.transform',
      'session.prompt',
      'session.prompt',
      'session.prompt',
      'session.context',
      'permission.evaluate',
      ...(debug ? ['session.model.request'] : []),
      'session.http.response',
      'session.experimental.ws.receive',
      'session.retry',
      'tool.execute.after',
      'tool.transform',
      'event.subscribe',
      'timer',
    ])
  } finally {
    rmSync(directorio, { recursive: true, force: true })
  }
})

test('cleanup aborta la suscripción y detiene el vigilante, incluso si se repite', async () => {
  // Given: una suscripción activa y el reloj controlado, sin esperar un minuto real.
  jest.useFakeTimers()
  const abortado = Promise.withResolvers<void>()
  const cerrado = Promise.withResolvers<void>()
  const recibido = Promise.withResolvers<void>()
  const orden: string[] = []
  let vigilancias = 0
  let signal: AbortSignal | undefined
  const ctx: Parameters<typeof suscribir>[0] = {
    location: { directory: '/prueba' },
    event: {
      async *subscribe(options) {
        signal = options?.signal

        if (!signal) {
          throw new Error('suscripción sin signal')
        }

        signal.addEventListener('abort', () => abortado.resolve(), { once: true })

        try {
          yield {
            id: 'evento',
            created: 1,
            type: 'session.execution.succeeded',
            durable: { aggregateID: 'ses_prueba', seq: 1, version: 1 },
            data: { sessionID: 'ses_prueba' },
          }
          await abortado.promise
        } finally {
          cerrado.resolve()
        }
      },
    },
  }
  const cleanup = suscribir(
    ctx,
    {
      evento: async () => {
        orden.push('encargos')
      },
      vigilar: async () => {
        vigilancias++
      },
    },
    {
      evento: async () => {
        orden.push('continuacion')
        recibido.resolve()
      },
    },
  )

  try {
    await recibido.promise
    jest.advanceTimersByTime(60_000)
    expect(vigilancias).toBe(1)

    // When: el plugin se detiene dos veces y transcurre otro intervalo.
    cleanup()
    cleanup()
    await cerrado.promise
    jest.advanceTimersByTime(120_000)

    // Then: la suscripción finaliza, no vuelve a vigilar y encargos recibió el evento antes que continuación.
    expect(signal?.aborted).toBe(true)
    expect(vigilancias).toBe(1)
    expect(orden).toEqual(['encargos', 'continuacion'])
  } finally {
    cleanup()
    jest.useRealTimers()
  }
})

test('cleanup cierra una suscripción mientras encargos aún procesa un evento', async () => {
  // Given: un handler retenido; cancelar no cancela el trabajo ya empezado.
  jest.useFakeTimers()
  const procesando = Promise.withResolvers<void>()
  const liberar = Promise.withResolvers<void>()
  const cerrado = Promise.withResolvers<void>()
  let continuaciones = 0
  let vigilancias = 0
  const ctx: Parameters<typeof suscribir>[0] = {
    location: { directory: '/prueba' },
    event: {
      async *subscribe(options) {
        try {
          yield {
            id: 'evento',
            created: 1,
            type: 'session.execution.succeeded',
            durable: { aggregateID: 'ses_prueba', seq: 1, version: 1 },
            data: { sessionID: 'ses_prueba' },
          }
          options?.signal?.throwIfAborted()
        } finally {
          cerrado.resolve()
        }
      },
    },
  }
  const cleanup = suscribir(
    ctx,
    {
      evento: async () => {
        procesando.resolve()
        await liberar.promise
      },
      vigilar: async () => {
        vigilancias++
      },
    },
    {
      evento: async () => {
        continuaciones++
      },
    },
  )

  try {
    await procesando.promise
    expect(continuaciones).toBe(0)

    // When: llega cleanup antes de que el handler termine.
    cleanup()
    liberar.resolve()
    await cerrado.promise
    jest.advanceTimersByTime(60_000)

    // Then: termina el evento en vuelo, pero no hay más vigilancia.
    expect(continuaciones).toBe(1)
    expect(vigilancias).toBe(0)
  } finally {
    cleanup()
    liberar.resolve()
    jest.useRealTimers()
  }
})
