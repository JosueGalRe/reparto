import { etiqueta, modelRef, resolver } from './actores.ts'
import { bajasVigentes, deBaja } from './bajas.ts'
import { db, write } from './db.ts'
import { log } from './log.ts'
import { proceso } from './process.ts'

import type { Actor } from './config.ts'
import type { Plugin } from '@opencode/plugin'
import type { ToolContext } from '@opencode/plugin/promise/tool'

export type Estado = 'en_cola' | 'corriendo' | 'terminado' | 'fallido' | 'interrumpido' | 'estancado'

export interface Encargo {
  id: number
  hija: string
  padre: string
  a: string
  actor: string
  background: number
  estado: Estado
  desde: number | null
  cerrado: number | null
  mensaje_final: string | null
  error: string | null
  aviso_pendiente: number
  boot_id: string
  pid: number
  starttime: string
  creado: number
}

const permitidas: Record<Estado, readonly Estado[]> = {
  en_cola: ['corriendo', 'fallido'],
  corriendo: ['terminado', 'fallido', 'interrumpido', 'estancado'],
  estancado: ['corriendo', 'terminado', 'fallido', 'interrumpido'],
  terminado: [],
  fallido: [],
  interrumpido: [],
}

/** El mecanismo interno de ensayar solo invoca a sus dos revisores. */
export const destinos = new Set<string>(['critico', 'oracle'])

export const PLAZO_ESTANCADO = 30 * 60_000
const TOPE_AVISO = 8_000
const TOPE_RESULTADO = 4_000

const recortar = (texto: string, tope: number) =>
  texto.length > tope ? `${texto.slice(0, tope)}\n[… recortado, ${texto.length - tope} caracteres más]` : texto

export function tituloEncargo(agente: string, prompt: string): string {
  const resumen = (prompt.split('\n').find((linea) => linea.trim()) ?? '').trim().replace(/\s+/g, ' ')

  return `${agente} · ${resumen.length > 60 ? `${resumen.slice(0, 60)}…` : resumen}`
}

// ---------- Filas ----------

export const leer = (id: number) => db().query('SELECT * FROM encargos WHERE id = $id').get({ id }) as Encargo | null

type Cambios = Partial<Pick<Encargo, 'desde' | 'cerrado' | 'mensaje_final' | 'error' | 'aviso_pendiente'>>

/** Transición atómica: solo la instancia que obtiene `changes = 1` sigue (y avisa). */
export function transicion(encargo: Encargo, estado: Estado, cambios: Cambios = {}): boolean {
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

/** Un evento o un outcome cuenta para la fila solo si es posterior a `desde`: el `outcome` es el de la última ejecución de la sesión. */
export const posterior = (instante: number | undefined, desde: number | null) =>
  instante !== undefined && desde !== null && instante > desde

// Ponytail: sin cola por proveedor; si los 429 propios la exigen, usar una cola global en SQLite.

export const abiertos = () => (proceso.abiertos ??= new Map())
export const hijosNativos = () => (proceso.hijosNativos ??= new Map())

// ---------- Encargos ----------

type Ctx = Plugin.Context

interface Entrada {
  a?: string
  prompt: string
}

function parsear(input: unknown): Entrada {
  const entrada = (input ?? {}) as Record<string, unknown>

  if (typeof entrada.prompt !== 'string' || !entrada.prompt.trim()) {
    throw new Error('delegar: falta `prompt`')
  }

  if (typeof entrada.a !== 'string') {
    throw new Error('delegar: falta `a`')
  }

  return {
    a: typeof entrada.a === 'string' ? entrada.a : undefined,
    prompt: entrada.prompt,
  }
}

const etiquetaRef = (modelo: { providerID: string; id: string; variant?: string } | undefined) =>
  modelo ? etiqueta({ model: `${modelo.providerID}/${modelo.id}`, variant: modelo.variant }) : 'desconocido'

export function textoPermiso(titulo: string, action: string, resources: readonly string[], requestID: string): string {
  return `[reparto] ${titulo} — espera permiso: ${action} ${resources.join(', ')} (${requestID})\nÁbrela en chats por su título y aprueba o rechaza ahí.`
}

export function registrarPermiso(request: {
  id: string
  sessionID: string
  action: string
  resources: readonly string[]
}): boolean {
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

export function encargos(ctx: Ctx) {
  async function mensajeFinal(hija: string): Promise<string | undefined> {
    const mensajes = await ctx.session.context({ sessionID: hija })

    for (const mensaje of mensajes.toReversed()) {
      if (mensaje.type !== 'assistant') {
        continue
      }

      const texto = mensaje.content
        .flatMap((parte) => (parte.type === 'text' ? [parte.text] : []))
        .join('\n')
        .trim()

      if (texto) {
        return texto
      }
    }
  }

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
      const encargo = leer(id)

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

      if (!transicion(encargo, cierreActual.estado, cambios)) {
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
  async function correr(id: number, prompt: string, skills: string[] | undefined): Promise<boolean> {
    const encargo = leer(id)!
    const desde = Date.now()

    if (encargo.estado !== 'en_cola' || !transicion(encargo, 'corriendo', { desde })) {
      return false
    }

    abiertos().set(encargo.hija, { id, actividad: desde })

    try {
      await ctx.session.prompt({
        sessionID: encargo.hija,
        text: prompt,
        ...(skills?.length ? { skills: skills.map((skill) => ({ id: skill })) } : {}),
      })

      return true
    } catch (error) {
      const actual = leer(id)!

      if (
        transicion(actual, 'fallido', {
          cerrado: Date.now(),
          error: `el prompt falló: ${String(error)}`,
        })
      ) {
        abiertos().delete(encargo.hija)
      }

      return false
    }
  }

  async function delegar(input: unknown, tool: ToolContext, actorElegido?: Actor) {
    const args = parsear(input)
    const validacion = proceso.validacion

    if (!validacion) {
      throw new Error('reparto todavía no validó los actores contra el catálogo; reintenta en unos segundos')
    }

    const padre = await ctx.session.get({ sessionID: tool.sessionID })

    let suplencia: string | undefined

    if (!destinos.has(args.a!)) {
      throw new Error(`"${args.a}" no es un agente ni un papel al que se pueda delegar (${[...destinos].join(', ')})`)
    }

    if (!validacion.actores.has(args.a!)) {
      throw new Error(`"${args.a}" está desactivado: no tiene actores válidos`)
    }

    const bajas = bajasVigentes(db())
    const elegido = actorElegido ?? resolver(validacion, args.a!, deBaja(bajas))

    if (!elegido) {
      throw new Error(
        `todos los actores de "${args.a}" están de baja: ${bajas.map((baja) => `${baja.id} hasta ${new Date(baja.hasta).toISOString()}`).join(', ')}`,
      )
    }

    if (elegido !== validacion.actores.get(args.a!)?.[0]) {
      suplencia = `el titular está de baja; entra ${etiqueta(elegido)}`
    }

    const sesion = await ctx.session.create({
      title: tituloEncargo(args.a!, args.prompt),
      agent: args.a,
      model: modelRef(elegido),
      location: { directory: padre.location.directory },
      metadata: { padre: tool.sessionID },
    })

    const hija = sesion.id
    const agente = args.a!
    const actor = etiqueta(elegido)

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
    // Chequeo e INSERT en la misma transacción IMMEDIATE: dos retomas simultáneas, aun desde procesos distintos, no pasan las dos.
    const id = write(db(), 'crear encargo', () => {
      if (
        db()
          .query("SELECT 1 FROM encargos WHERE hija = $hija AND estado IN ('en_cola', 'corriendo', 'estancado')")
          .get({ hija })
      ) {
        return 0
      }

      db().query("UPDATE permisos SET estado = 'respondido' WHERE hija = $hija AND estado = 'pendiente'").run({ hija })

      return Number(
        db()
          .query(
            `INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
             VALUES ($hija, $padre, $a, $actor, $background, 'en_cola', $boot_id, $pid, $starttime, $creado)`,
          )
          .run(fila).lastInsertRowid,
      )
    })

    if (id === 0) {
      throw new Error(`encargo ya corriendo: ${hija}`)
    }

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
    const nota = suplencia ? ` (${suplencia})` : ''

    const interrumpir = () => {
      const encargo = leer(id)

      if (encargo?.estado === 'en_cola') {
        transicion(encargo, 'fallido', { cerrado: Date.now(), error: 'cancelado antes de correr' })
      } else {
        void ctx.session
          .interrupt({ sessionID: hija })
          .catch((error) => log.error('interrupt falló', { hija, error: String(error) }))
      }
    }

    tool.signal.addEventListener('abort', interrumpir, { once: true })

    try {
      if (await correr(id, args.prompt, undefined)) {
        await ctx.session.wait({ sessionID: hija })
        await cerrar(id)
      }

      // Otra instancia puede estar cerrando la misma fila a partir del evento: se espera su transición
      for (let intento = 0; intento < 40 && isOpen(leer(id)); intento++) {
        await Bun.sleep(250)
      }
    } finally {
      tool.signal.removeEventListener('abort', interrumpir)
    }

    const encargo = leer(id)!

    if (isOpen(encargo)) {
      return {
        content: `Encargo ${hija} (${agente}) sigue ${encargo.estado}.`,
        metadata: { encargo: id, hija },
      }
    }

    const cuerpo =
      encargo.estado === 'terminado' ? recortar(encargo.mensaje_final ?? '', TOPE_AVISO) : (encargo.error ?? encargo.estado)

    return {
      content: `Encargo ${hija} (${agente}, ${actor})${nota} ${encargo.estado}.\n\n${cuerpo}`,
      metadata: { encargo: id, hija, estado: encargo.estado },
    }
  }

  /** Interrumpe un encargo abierto cuya hija tenga `metadata.padre` = la sesión que llama. */
  async function interrumpir(input: unknown, tool: ToolContext) {
    const entrada = (input ?? {}) as { id?: unknown }

    if (typeof entrada.id !== 'string') {
      throw new Error('interrumpir: falta `id` (el id de la sesión hija)')
    }

    const hija = entrada.id
    const sesion = await ctx.session.get({ sessionID: hija }).catch(() => undefined)

    if (!sesion || (sesion.parentID ?? sesion.metadata?.padre) !== tool.sessionID) {
      throw new Error(`interrumpir: ${hija} no es un encargo de esta sesión; solo se pueden interrumpir los encargos propios`)
    }

    if (sesion.parentID) {
      await ctx.session.interrupt({ sessionID: hija })
      hijosNativos().delete(hija)

      return { content: `Encargo ${hija} interrumpido.`, metadata: { hija, estado: 'interrumpido' } }
    }

    const encargo = db()
      .query("SELECT * FROM encargos WHERE hija = $hija AND estado IN ('en_cola', 'corriendo', 'estancado')")
      .get({ hija }) as Encargo | null

    if (!encargo) {
      throw new Error(`interrumpir: ${hija} no tiene un encargo abierto`)
    }

    if (encargo.estado === 'en_cola') {
      // No llegó a correr: no hay ejecución que interrumpir, y en_cola solo puede pasar a corriendo o fallido
      const cambios = { cerrado: Date.now(), error: 'interrumpido antes de correr' }

      if (transicion(encargo, 'fallido', cambios)) {
        abiertos().delete(hija)
      }
    } else {
      await ctx.session.interrupt({ sessionID: hija })

      // La transición a interrumpido la hace cerrar(), a partir de session.execution.interrupted
      for (let intento = 0; intento < 40 && isOpen(leer(encargo.id)); intento++) {
        await Bun.sleep(250)
      }

      if (isOpen(leer(encargo.id))) {
        await cerrar(encargo.id)
      }
    }

    const final = leer(encargo.id)!

    log.info('interrupción pedida', { id: encargo.id, hija, por: tool.sessionID, estado: final.estado })

    return {
      content: `Encargo ${hija} (${encargo.a}): ${final.estado}${final.error ? ` (${final.error})` : ''}.`,
      metadata: { encargo: encargo.id, hija, estado: final.estado },
    }
  }

  async function bitacora(input: unknown) {
    const entrada = (input ?? {}) as { id?: unknown; detalle?: unknown }

    if (typeof entrada.id !== 'string') {
      throw new Error('bitacora: falta `id` (el id de la sesión hija)')
    }

    const encargo = db()
      .query('SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1')
      .get({ hija: entrada.id }) as Encargo | null
    const sesion = encargo ? undefined : await ctx.session.get({ sessionID: entrada.id }).catch(() => undefined)

    if (!encargo && !sesion?.parentID) {
      throw new Error(`${entrada.id} no es un encargo de reparto`)
    }

    const completo = entrada.detalle === 'completo'
    const llamadas = db()
      .query('SELECT tool, argumentos, resultado, estado FROM bitacora WHERE hija = $hija ORDER BY hora')
      .all({ hija: entrada.id }) as {
      tool: string
      argumentos: string
      resultado: string | null
      estado: string
    }[]
    const lineas = llamadas.map((llamada) => {
      const base = `- ${llamada.tool} ${argumentoClave(llamada.argumentos)}${llamada.estado === 'error' ? ' [error]' : ''}`

      return completo && llamada.resultado ? `${base}\n  → ${llamada.resultado.replaceAll('\n', '\n    ')}` : base
    })
    const final = db().query('SELECT texto FROM mensajes_hijas WHERE hija = $hija').get({ hija: entrada.id }) as {
      texto: string
    } | null

    return {
      content: [
        encargo
          ? `Encargo ${encargo.hija} (${encargo.a}, ${encargo.actor}): ${encargo.estado}${encargo.error ? ` (${encargo.error})` : ''}.`
          : `Encargo ${entrada.id} (${sesion?.agent}): ${sesion?.outcome ?? 'abierto'}.`,
        `Tool calls (${llamadas.length}):`,
        lineas.join('\n') || '(ninguna)',
        `Mensaje final:`,
        encargo?.mensaje_final ?? final?.texto ?? (sesion ? await mensajeFinal(entrada.id) : undefined) ?? '(todavía no hay)',
      ].join('\n\n'),
    }
  }

  async function registrarLlamada(llamada: {
    tool: string
    sessionID: string
    messageID: string
    id: string
    input: unknown
    status: 'completed' | 'error'
    result?: { content?: unknown }
    error?: { message: string }
  }) {
    if (!abiertos().has(llamada.sessionID)) {
      const sesion = await ctx.session.get({ sessionID: llamada.sessionID }).catch(() => undefined)

      if (!sesion?.parentID) {
        return
      }
    }

    let resultado: string

    if (llamada.status === 'error') {
      resultado = llamada.error?.message ?? ''
    } else if (typeof llamada.result?.content === 'string') {
      resultado = llamada.result.content
    } else {
      resultado = JSON.stringify(llamada.result?.content ?? '')
    }

    write(db(), 'bitácora', () =>
      db()
        .query(
          `INSERT OR IGNORE INTO bitacora (hija, mensaje, llamada, tool, argumentos, resultado, estado, hora)
           VALUES ($hija, $mensaje, $llamada, $tool, $argumentos, $resultado, $estado, $hora)`,
        )
        .run({
          hija: llamada.sessionID,
          mensaje: llamada.messageID,
          llamada: llamada.id,
          tool: llamada.tool,
          argumentos: JSON.stringify(llamada.input ?? {}),
          resultado: recortar(resultado, TOPE_RESULTADO),
          estado: llamada.status,
          hora: Date.now(),
        }),
    )
  }

  /** Eventos de todas las locations del proceso (S15); los session.execution.* no traen location (S13). */
  async function evento(ev: { type: string; created?: number; data?: unknown }) {
    const data = ev.data as
      | {
          sessionID?: string
          id?: string
          requestID?: string
          action?: string
          resources?: string[]
          error?: { message?: string }
        }
      | undefined
    const abierto = data?.sessionID ? abiertos().get(data.sessionID) : undefined
    const nativo = data?.sessionID ? hijosNativos().get(data.sessionID) : undefined

    if (nativo && posterior(ev.created, nativo.desde)) {
      if (
        ev.type === 'session.execution.succeeded' ||
        ev.type === 'session.execution.failed' ||
        ev.type === 'session.execution.interrupted'
      ) {
        const hija = data?.sessionID

        if (hija) {
          hijosNativos().delete(hija)

          try {
            const texto = await mensajeFinal(hija)

            if (texto) {
              write(db(), 'mensaje final de hija', () =>
                db()
                  .query(`INSERT INTO mensajes_hijas (hija, desde, texto) VALUES ($hija, $desde, $texto)
                    ON CONFLICT (hija) DO UPDATE SET desde = excluded.desde, texto = excluded.texto
                    WHERE excluded.desde >= mensajes_hijas.desde`)
                  .run({ hija, desde: nativo.desde, texto }),
              )
            }
          } catch (error) {
            log.error('mensaje final de hija falló', { hija, error: String(error) })
          }
        }
      } else if (ev.type === 'permission.asked' && data?.id) {
        nativo.permisos.add(data.id)
      } else if (ev.type === 'permission.replied' && data?.requestID) {
        nativo.permisos.delete(data.requestID)
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
      void cerrar(abierto.id, { created: ev.created ?? Date.now(), error: data?.error?.message })

      return
    }

    if (ev.type === 'permission.asked' && data?.id && data.action && data.resources && data.sessionID) {
      const encargo = leer(abierto.id)

      if (!encargo || !isOpen(encargo)) {
        return
      }

      const { id, action, resources, sessionID } = data

      actividad()

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

    if (ev.type === 'permission.replied' && data?.requestID && data.sessionID) {
      const { requestID, sessionID } = data

      actividad()
      write(db(), 'permiso respondido', () =>
        db()
          .query("UPDATE permisos SET estado = 'respondido' WHERE request_id = $id AND hija = $hija")
          .run({ id: requestID, hija: sessionID }),
      )

      return
    }

    if (/^session\.(step|tool|text|reasoning)\./.test(ev.type)) {
      actividad()
    }

    function actividad() {
      abierto.actividad = Date.now()

      if (abierto.estancado) {
        const encargo = leer(abierto.id)

        if (encargo?.estado === 'estancado' && transicion(encargo, 'corriendo')) {
          abierto.estancado = false
          log.info('encargo reanudado', { id: encargo.id, hija: encargo.hija })
        }
      }
    }
  }

  async function vigilar() {
    const ahora = Date.now()

    for (const [hija, nativo] of hijosNativos()) {
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

const isOpen = (encargo: Encargo | null) =>
  !!encargo && (encargo.estado === 'en_cola' || encargo.estado === 'corriendo' || encargo.estado === 'estancado')

const clavesArgumento = ['command', 'pattern', 'filePath', 'path', 'query', 'url', 'a']

export function argumentoClave(argumentos: string): string {
  let entrada: unknown

  try {
    entrada = JSON.parse(argumentos)
  } catch {
    return recortar(argumentos, 160)
  }

  if (!entrada || typeof entrada !== 'object') {
    return ''
  }

  const registro = entrada as Record<string, unknown>
  const clave =
    clavesArgumento.find((clave) => typeof registro[clave] === 'string') ??
    Object.keys(registro).find((clave) => typeof registro[clave] === 'string')

  return clave ? `${clave}=${recortar(String(registro[clave]), 160).replaceAll('\n', ' ')}` : ''
}
