import { etiqueta, modelRef } from './actores.ts'
import { bitacoraEncargos } from './bitacora.ts'
import { db, write } from './db.ts'
import { estaAbierto, etiquetaRef, posterior, recortar, tituloEncargo } from './encargos-utils.ts'
import { log } from './log.ts'
import { abiertos, hijasNativas, proceso } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { Actor } from './config.ts'
import type { Cambios, ContextoEncargos, Encargo, EntradaRevisor, EstadoEncargo } from './encargos-types.ts'
import type { Evento } from './hooks-types.ts'

const permitidas: Record<EstadoEncargo, readonly EstadoEncargo[]> = {
  en_cola: ['corriendo', 'fallido'],
  corriendo: ['terminado', 'fallido', 'interrumpido', 'estancado'],
  estancado: ['corriendo', 'terminado', 'fallido', 'interrumpido'],
  terminado: [],
  fallido: [],
  interrumpido: [],
}

/** El mecanismo interno de ensayar solo invoca a sus dos revisores. */
const revisoresPermitidos = new Set<string>(['critico', 'tiresias'])

const PLAZO_ESTANCADO = 30 * 60_000
const TOPE_MENSAJE_FINAL = 32_000

// ---------- Filas ----------

export const leerEncargo = (id: number) =>
  db().query<Encargo, { id: number }>('SELECT * FROM encargos WHERE id = $id').get({ id })

/** Transición atómica: solo la instancia que obtiene `changes = 1` sigue (y avisa). */
export function cambiarEstadoEncargo(encargo: Encargo, estado: EstadoEncargo, cambios: Cambios = {}): boolean {
  if (!permitidas[encargo.estado].includes(estado)) {
    log.error('transición no permitida', { id: encargo.id, de: encargo.estado, a: estado })

    return false
  }

  const sets = Object.keys(cambios)
    .map((clave) => `, ${clave} = $${clave}`)
    .join('')
  const resultado = write(db(), `encargo ${encargo.id}: ${encargo.estado} → ${estado}`, () =>
    db()
      .query(`UPDATE encargos SET estado = $a${sets} WHERE id = $id AND estado = $de`)
      .run({ a: estado, id: encargo.id, de: encargo.estado, ...cambios }),
  )

  return resultado?.changes === 1
}

// Ponytail: sin cola por proveedor; si los 429 propios la exigen, usar una cola global en SQLite.

// ---------- Encargos ----------

function textoPermiso(titulo: string, action: string, resources: readonly string[], requestID: string): string {
  return `[reparto] ${titulo} — espera permiso: ${action} ${resources.join(', ')} (${requestID})\nÁbrela en chats por su título y aprueba o rechaza ahí.`
}

function registrarPermiso(request: { id: string; sessionID: string; action: string; resources: readonly string[] }): boolean {
  return (
    write(
      db(),
      'permiso pedido',
      () =>
        db()
          .query(
            "INSERT OR IGNORE INTO permisos (request_id, hija, action, resources, estado) VALUES ($id, $hija, $action, $resources, 'pendiente')",
          )
          .run({
            id: request.id,
            hija: request.sessionID,
            action: request.action,
            resources: JSON.stringify(request.resources),
          }).changes,
    ) === 1
  )
}

export function encargos(ctx: ContextoEncargos) {
  const { mensajeFinal, registrarLlamada, bitacora } = bitacoraEncargos(ctx)

  /** Cómo cerró la última ejecución, si es posterior a `desde`; undefined si todavía corre. */
  async function cierre(encargo: Encargo, errorEvento?: string) {
    const sesion = await ctx.session.get({ sessionID: encargo.hija })

    if (!sesion.outcome || !posterior(sesion.time.idle, encargo.desde)) {
      return
    }

    const ultimoActor = etiquetaRef(sesion.model)

    if (sesion.outcome === 'interrupted') {
      return { estado: 'interrumpido' as const, ultimoActor }
    }

    const mensaje = await mensajeFinal(encargo.hija)

    if (sesion.outcome === 'succeeded') {
      return mensaje
        ? { estado: 'terminado' as const, mensaje, ultimoActor }
        : { estado: 'fallido' as const, error: 'terminó sin salida', ultimoActor }
    }

    return { estado: 'fallido' as const, mensaje, error: errorEvento ?? 'la ejecución falló', ultimoActor }
  }

  /** Cierra un revisor sincrónico de este proceso. */
  async function cerrar(id: number, evento?: { created: number; error?: string }) {
    proceso.cerrando ??= new Set()

    if (proceso.cerrando.has(id)) {
      return
    }

    proceso.cerrando.add(id)

    try {
      const encargo = leerEncargo(id)

      if (!encargo || (encargo.estado !== 'corriendo' && encargo.estado !== 'estancado')) {
        return
      }

      // El cierre de una ejecución anterior de la misma hija, procesado tarde, no toca la fila retomada
      if (evento && !posterior(evento.created, encargo.desde)) {
        return
      }

      const cierreActual = await cierre(encargo, evento?.error)

      if (!cierreActual) {
        return
      }

      const cambios = {
        cerrado: Date.now(),
        mensaje_final: cierreActual.mensaje ?? null,
        error: cierreActual.error ?? null,
      }

      if (!cambiarEstadoEncargo(encargo, cierreActual.estado, cambios)) {
        return
      }

      abiertos().delete(encargo.hija)

      log.info('encargo cerrado', {
        id,
        hija: encargo.hija,
        a: encargo.a,
        estado: cierreActual.estado,
        error: cierreActual.error,
        actor: cierreActual.ultimoActor,
      })
    } catch (error) {
      log.error('cierre falló', { id, error: String(error) })
    } finally {
      proceso.cerrando.delete(id)
    }
  }

  /** Pasa a corriendo y manda el prompt. */
  async function correr(id: number, prompt: string): Promise<boolean> {
    const encargo = leerEncargo(id)!
    const desde = Date.now()

    if (encargo.estado !== 'en_cola' || !cambiarEstadoEncargo(encargo, 'corriendo', { desde })) {
      return false
    }

    abiertos().set(encargo.hija, { id })

    try {
      await ctx.session.prompt({
        sessionID: encargo.hija,
        text: prompt,
      })

      return true
    } catch (error) {
      const actual = leerEncargo(id)!

      if (
        cambiarEstadoEncargo(actual, 'fallido', {
          cerrado: Date.now(),
          error: `el prompt falló: ${String(error)}`,
        })
      ) {
        abiertos().delete(encargo.hija)
      }

      return false
    }
  }

  async function delegar(args: EntradaRevisor, tool: { sessionID: string; signal: AbortSignal }, actorElegido: Actor) {
    const validacion = proceso.validacion

    if (!validacion) {
      throw new Error('reparto todavía no validó los actores contra el catálogo; reintenta en unos segundos')
    }

    const padre = await ctx.session.get({ sessionID: tool.sessionID })

    let suplencia: string | undefined

    if (!revisoresPermitidos.has(args.revisor)) {
      throw new Error(
        `"${args.revisor}" no es un agente ni un papel al que se pueda delegar (${[...revisoresPermitidos].join(', ')})`,
      )
    }

    if (!validacion.actores.has(args.revisor)) {
      throw new Error(`"${args.revisor}" está desactivado: no tiene actores válidos`)
    }

    if (actorElegido !== validacion.actores.get(args.revisor)?.[0]) {
      suplencia = `el titular está de baja; entra ${etiqueta(actorElegido)}`
    }

    const sesion = await ctx.session.create({
      title: tituloEncargo(args.revisor, args.prompt),
      agent: args.revisor,
      model: modelRef(actorElegido),
      location: { directory: padre.location.directory },
      metadata: { padre: tool.sessionID },
    })

    const hija = sesion.id
    const agente = args.revisor
    const actor = etiqueta(actorElegido)

    const fila = {
      hija,
      padre: tool.sessionID,
      a: agente,
      actor,
      background: 0,
      creado: Date.now(),
      boot_id: '',
      pid: process.pid,
      starttime: '',
    }
    const id = write(db(), 'crear encargo', () =>
      Number(
        db()
          .query(
            `INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
             VALUES ($hija, $padre, $a, $actor, $background, 'en_cola', $boot_id, $pid, $starttime, $creado)`,
          )
          .run(fila).lastInsertRowid,
      ),
    )

    if (id === undefined) {
      throw new Error('no se pudo registrar el encargo (SQLite); ver el log de reparto')
    }

    log.info('encargo creado', {
      id,
      hija,
      padre: tool.sessionID,
      a: agente,
      actor,
      suplencia,
    })

    const interrumpir = () => {
      const encargo = leerEncargo(id)

      if (encargo?.estado === 'en_cola') {
        cambiarEstadoEncargo(encargo, 'fallido', { cerrado: Date.now(), error: 'cancelado antes de correr' })
      } else {
        void ctx.session
          .interrupt({ sessionID: hija })
          .catch((error) => log.error('interrupt falló', { hija, error: String(error) }))
      }
    }

    tool.signal.addEventListener('abort', interrumpir, { once: true })

    try {
      if (await correr(id, args.prompt)) {
        await ctx.session.wait({ sessionID: hija })
        await cerrar(id)
      }

      // Otra instancia puede estar cerrando la misma fila a partir del evento: se espera su transición
      for (let intento = 0; intento < 40 && estaAbierto(leerEncargo(id)); intento++) {
        await Bun.sleep(250)
      }
    } finally {
      tool.signal.removeEventListener('abort', interrumpir)
    }

    return hija
  }

  /** Interrumpe un encargo abierto cuya hija tenga `metadata.padre` = la sesión que llama. */
  async function interrumpir(entrada: unknown, tool: { sessionID: string }) {
    if (!esRegistro(entrada) || typeof entrada.id !== 'string') {
      throw new Error('interrumpir: falta `id` (el id de la sesión hija)')
    }

    const hija = entrada.id
    const sesion = await ctx.session.get({ sessionID: hija }).catch(() => undefined)

    if (!sesion || (sesion.parentID ?? sesion.metadata?.padre) !== tool.sessionID) {
      throw new Error(`interrumpir: ${hija} no es un encargo de esta sesión; solo se pueden interrumpir los encargos propios`)
    }

    if (sesion.parentID) {
      await ctx.session.interrupt({ sessionID: hija })
      hijasNativas().delete(hija)

      return { content: `Encargo ${hija} interrumpido.`, metadata: { hija, estado: 'interrumpido' } }
    }

    const encargo = db()
      .query<Encargo, { hija: string }>(
        "SELECT * FROM encargos WHERE hija = $hija AND estado IN ('en_cola', 'corriendo', 'estancado')",
      )
      .get({ hija })

    if (!encargo) {
      throw new Error(`interrumpir: ${hija} no tiene un encargo abierto`)
    }

    if (encargo.estado === 'en_cola') {
      // No llegó a correr: no hay ejecución que interrumpir, y en_cola solo puede pasar a corriendo o fallido
      const cambios = { cerrado: Date.now(), error: 'interrumpido antes de correr' }

      if (cambiarEstadoEncargo(encargo, 'fallido', cambios)) {
        abiertos().delete(hija)
      }
    } else {
      await ctx.session.interrupt({ sessionID: hija })

      // La transición a interrumpido la hace cerrar(), a partir de session.execution.interrupted
      for (let intento = 0; intento < 40 && estaAbierto(leerEncargo(encargo.id)); intento++) {
        await Bun.sleep(250)
      }

      if (estaAbierto(leerEncargo(encargo.id))) {
        await cerrar(encargo.id)
      }
    }

    const final = leerEncargo(encargo.id)!

    log.info('interrupción pedida', { id: encargo.id, hija, por: tool.sessionID, estado: final.estado })

    return {
      content: `Encargo ${hija} (${encargo.a}): ${final.estado}${final.error ? ` (${final.error})` : ''}.`,
      metadata: { encargo: encargo.id, hija, estado: final.estado },
    }
  }

  /** Eventos de todas las locations del proceso (S15); los session.execution.* no traen location (S13). */
  async function evento(ev: Evento) {
    const sessionID = ev.data && 'sessionID' in ev.data && typeof ev.data.sessionID === 'string' ? ev.data.sessionID : undefined
    const abierto = sessionID ? abiertos().get(sessionID) : undefined
    const nativo = sessionID ? hijasNativas().get(sessionID) : undefined

    if (nativo && posterior(ev.created, nativo.desde)) {
      if (
        ev.type === 'session.execution.succeeded' ||
        ev.type === 'session.execution.failed' ||
        ev.type === 'session.execution.interrupted'
      ) {
        const hija = sessionID

        if (hija) {
          hijasNativas().delete(hija)

          try {
            const texto = await mensajeFinal(hija)

            if (texto) {
              write(db(), 'mensaje final de hija', () =>
                db()
                  .query(`INSERT INTO mensajes_hijas (hija, desde, texto) VALUES ($hija, $desde, $texto)
                    ON CONFLICT (hija) DO UPDATE SET desde = excluded.desde, texto = excluded.texto
                    WHERE excluded.desde >= mensajes_hijas.desde`)
                  .run({ hija, desde: nativo.desde, texto: recortar(texto, TOPE_MENSAJE_FINAL) }),
              )
            }
          } catch (error) {
            log.error('mensaje final de hija falló', { hija, error: String(error) })
          }
        }
      } else if (ev.type === 'permission.asked' && ev.data.id) {
        nativo.permisos.add(ev.data.id)
      } else if (ev.type === 'permission.replied' && ev.data.requestID) {
        nativo.permisos.delete(ev.data.requestID)
        nativo.actividad = Date.now()
      } else if (/^session\.(step|tool|text|reasoning)\./.test(ev.type)) {
        nativo.actividad = Date.now()
        nativo.avisado = false
      }
    }

    if (!abierto) {
      return
    }

    if (
      ev.type === 'session.execution.succeeded' ||
      ev.type === 'session.execution.failed' ||
      ev.type === 'session.execution.interrupted'
    ) {
      void cerrar(abierto.id, {
        created: ev.created,
        error: ev.type === 'session.execution.failed' ? ev.data.error.message : undefined,
      })

      return
    }

    if (ev.type === 'permission.asked' && ev.data.id && sessionID) {
      const encargo = leerEncargo(abierto.id)

      if (!encargo || !estaAbierto(encargo)) {
        return
      }

      const { id, action, resources } = ev.data

      if (registrarPermiso({ id, action, resources, sessionID })) {
        void (async () => {
          try {
            const hija = await ctx.session.get({ sessionID: encargo.hija })

            await ctx.session.prompt({
              sessionID: encargo.padre,
              text: textoPermiso(hija.title ?? encargo.hija, action, resources, id),
              delivery: 'queue',
              metadata: { repartoAviso: true },
            })
            log.info('permiso avisado', { id: encargo.id, hija: encargo.hija, padre: encargo.padre, requestID: id })
          } catch (error) {
            log.error('aviso de permiso falló', {
              id: encargo.id,
              hija: encargo.hija,
              padre: encargo.padre,
              requestID: id,
              error: String(error),
            })
          }
        })()
      }

      return
    }
  }

  async function vigilar() {
    const ahora = Date.now()

    for (const [hija, nativo] of hijasNativas()) {
      if (nativo.avisado || nativo.permisos.size || ahora - nativo.actividad < PLAZO_ESTANCADO) {
        continue
      }

      nativo.avisado = true

      try {
        await ctx.session.prompt({
          sessionID: nativo.padre,
          text: `[reparto] ${hija} — estancado\n\nSin actividad desde hace 30 min. Sigue abierto; decide si lo interrumpes.\n(bitacora({ id: "${hija}" }) para el resto)`,
          delivery: 'queue',
          metadata: { repartoAviso: true },
        })
      } catch (error) {
        log.error('aviso de estancado falló', { hija, error: String(error) })
      }
    }
  }

  return { delegar, interrumpir, bitacora, registrarLlamada, evento, vigilar }
}
