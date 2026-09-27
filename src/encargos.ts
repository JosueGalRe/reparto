import { readFileSync } from 'node:fs'

import { etiqueta, modelRef, resolver } from './actores.ts'
import { papeles } from './agentes.ts'
import { bajasVigentes, deBaja } from './bajas.ts'
import { db, write } from './db.ts'
import { planDeSesion } from './estreno.ts'
import { log } from './log.ts'
import { proceso } from './process.ts'

import type { Actor, Config } from './config.ts'
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

/** Agentes y papeles a los que se puede delegar en la fase 1. */
export const destinos = new Set<string>([...papeles, 'utilero', 'archivista', 'oracle'])
const investigacion = new Set(['utilero', 'archivista', 'oracle'])

export const puedeDelegar = (agente: string | undefined, destino: string) =>
  agente !== 'dramaturgo' || investigacion.has(destino)

export const PLAZO_ESTANCADO = 30 * 60_000
const TOPE_AVISO = 8_000
const TOPE_AVISO_VISIBLE = 1_500
const TOPE_RESULTADO = 4_000
const CONCURRENCIA = 3

const recortar = (texto: string, tope: number) =>
  texto.length > tope ? `${texto.slice(0, tope)}\n[… recortado, ${texto.length - tope} caracteres más]` : texto

export function tituloEncargo(agente: string, prompt: string): string {
  const resumen = (prompt.split('\n').find((linea) => linea.trim()) ?? '').trim().replace(/\s+/g, ' ')

  return `${agente} · ${resumen.length > 60 ? `${resumen.slice(0, 60)}…` : resumen}`
}

// ---------- Proceso dueño de un encargo (ADR 0010): boot_id + pid + starttime, porque el pid solo se reusa ----------

const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()

function starttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')

    // Campo 22 de /proc/<pid>/stat; el nombre del proceso (campo 2) puede tener espacios, así que se cuenta desde el ")"
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

export const yo = { boot_id: bootId, pid: process.pid, starttime: starttime(process.pid) ?? '' }
export const vivo = (encargo: Pick<Encargo, 'boot_id' | 'pid' | 'starttime'>) =>
  encargo.boot_id === bootId && starttime(encargo.pid) === encargo.starttime

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

// ---------- Cola por proveedor, en el proceso (S15 contradicha: vive en globalThis) ----------

function cola(proveedor: string) {
  proceso.colas ??= new Map()
  let cupo = proceso.colas.get(proveedor)

  if (!cupo) {
    proceso.colas.set(proveedor, (cupo = { corriendo: 0, espera: [] }))
  }

  return cupo
}

async function tomarCupo(proveedor: string, limite: number, id: number) {
  const cupo = cola(proveedor)

  if (cupo.corriendo >= limite) {
    log.info('cola: en espera', { proveedor, id, corriendo: cupo.corriendo, limite, enEspera: cupo.espera.length + 1 })
    await new Promise<void>((resolve) => cupo.espera.push(resolve))
  } else {
    cupo.corriendo++
  }

  ;(proceso.cupos ??= new Map()).set(id, proveedor)
  log.info('cola: corre', { proveedor, id, corriendo: cupo.corriendo, limite, enEspera: cupo.espera.length })
}

function soltarCupo(id: number) {
  const proveedor = proceso.cupos?.get(id)

  if (!proveedor) {
    return
  }

  proceso.cupos!.delete(id)
  const cupo = cola(proveedor)
  const siguiente = cupo.espera.shift()

  if (siguiente) {
    siguiente()
  } else {
    cupo.corriendo--
  }

  log.info('cola: libera', { proveedor, id, corriendo: cupo.corriendo, enEspera: cupo.espera.length })
}

/**
 * Un encargo que cambia de actor a otro proveedor (1.8) pasa su cupo a la cola nueva. Si está llena la excede:
 * esperar un cupo dentro de `retry` podría trabarse con cambios cruzados.
 */
// Ponytail: exceso por suplencia; cola estricta si provoca 429 propios
export function moverCupo(id: number, proveedor: string, limite: number) {
  const anterior = proceso.cupos?.get(id)

  if (!anterior || anterior === proveedor) {
    return
  }

  soltarCupo(id)
  const cupo = cola(proveedor)

  cupo.corriendo++
  proceso.cupos!.set(id, proveedor)

  if (cupo.corriendo > limite) {
    log.warn('cola: exceso por suplencia', { id, de: anterior, a: proveedor, corriendo: cupo.corriendo, limite })
  } else {
    log.info('cola: cupo movido', { id, de: anterior, a: proveedor, corriendo: cupo.corriendo, limite })
  }
}

export const abiertos = () => (proceso.abiertos ??= new Map())
export const hijosNativos = () => (proceso.hijosNativos ??= new Map())

// ---------- Encargos ----------

type Ctx = Plugin.Context

interface Entrada {
  a?: string
  prompt: string
  background?: boolean
  sesion?: string
  skills?: string[]
}

function parsear(input: unknown): Entrada {
  const entrada = (input ?? {}) as Record<string, unknown>

  if (typeof entrada.prompt !== 'string' || !entrada.prompt.trim()) {
    throw new Error('delegar: falta `prompt`')
  }

  if (entrada.sesion === undefined && typeof entrada.a !== 'string') {
    throw new Error('delegar: falta `a` (o `sesion` para retomar)')
  }

  return {
    a: typeof entrada.a === 'string' ? entrada.a : undefined,
    prompt: entrada.prompt,
    background: entrada.background === true,
    sesion: typeof entrada.sesion === 'string' ? entrada.sesion : undefined,
    skills: Array.isArray(entrada.skills)
      ? entrada.skills.filter((skill): skill is string => typeof skill === 'string')
      : undefined,
  }
}

const etiquetaRef = (modelo: { providerID: string; id: string; variant?: string } | undefined) =>
  modelo ? etiqueta({ model: `${modelo.providerID}/${modelo.id}`, variant: modelo.variant }) : 'desconocido'

export function textoAviso(encargo: Encargo, ultimoActor: string, titulo: string): string {
  const cabeza = `[reparto] ${titulo} — ${encargo.estado} (${encargo.hija})`
  const suplente =
    ultimoActor.replace(/#default$/, '') !== encargo.actor.replace(/#default$/, '')
      ? `\nentró como suplente en lugar de ${encargo.actor}.`
      : ''
  const pista = `(bitacora({ id: "${encargo.hija}" }) para el resto)`

  switch (encargo.estado) {
    case 'terminado': {
      return `${cabeza}\n\n${recortar(encargo.mensaje_final ?? '', TOPE_AVISO_VISIBLE)}${suplente}\n${pista}`
    }

    case 'fallido': {
      return `${cabeza}\n\nError: ${recortar(encargo.error ?? 'la ejecución falló', 120)}. Último actor: ${ultimoActor}.${suplente}${encargo.mensaje_final ? `\nÚltimo mensaje: ${recortar(encargo.mensaje_final, TOPE_AVISO_VISIBLE)}` : ''}\n${pista}`
    }

    case 'interrumpido': {
      return `${cabeza}\n\nInterrumpido antes de completar el encargo.${suplente}\n${pista}`
    }

    case 'estancado': {
      return `${cabeza}\n\nSin actividad desde hace ${PLAZO_ESTANCADO / 60_000} min. Sigue abierto; decide si lo interrumpes.${suplente}\n${pista}`
    }

    case 'en_cola':
    case 'corriendo': {
      throw new Error(`aviso para encargo abierto: ${encargo.estado}`)
    }
  }
}

export function textoPermiso(titulo: string, action: string, resources: readonly string[], requestID: string): string {
  return `[reparto] ${titulo} — espera permiso: ${action} ${resources.join(', ')} (${requestID})\nÁbrela en chats por su título y aprueba o rechaza ahí.`
}

export function permisoPendiente(hija: string): boolean {
  return !!db().query("SELECT 1 FROM permisos WHERE hija = $hija AND estado = 'pendiente' LIMIT 1").get({ hija })
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

export function encargos(ctx: Ctx, config: Config) {
  const limite = (proveedor: string) => config.proveedores?.[proveedor]?.concurrencia ?? CONCURRENCIA

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

  async function avisar(encargo: Encargo, ultimoActor: string) {
    try {
      const hija = await ctx.session.get({ sessionID: encargo.hija })

      await ctx.session.prompt({
        sessionID: encargo.padre,
        text: textoAviso(encargo, ultimoActor, hija.title ?? encargo.hija),
        delivery: 'queue',
        metadata: { repartoAviso: true },
      })
      write(db(), 'aviso enviado', () =>
        db().query('UPDATE encargos SET aviso_pendiente = 0 WHERE id = $id').run({ id: encargo.id }),
      )
      log.info('aviso', { id: encargo.id, hija: encargo.hija, padre: encargo.padre, estado: encargo.estado })
    } catch (error) {
      log.error('aviso falló', { id: encargo.id, padre: encargo.padre, error: String(error) })
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

  /** Cierra un encargo abierto de este proceso. Solo avisa quien gana la transición. */
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
        aviso_pendiente: encargo.background,
      }

      if (!transicion(encargo, cierreActual.estado, cambios)) {
        return
      }

      soltarCupo(encargo.id)
      abiertos().delete(encargo.hija)
      const cerrado = { ...encargo, ...cambios, estado: cierreActual.estado }

      log.info('encargo cerrado', {
        id,
        hija: encargo.hija,
        a: encargo.a,
        estado: cierreActual.estado,
        error: cierreActual.error,
        actor: cierreActual.ultimoActor,
      })

      if (encargo.background) {
        await avisar(cerrado, cierreActual.ultimoActor)
      }
    } catch (error) {
      log.error('cierre falló', { id, error: String(error) })
    } finally {
      proceso.cerrando.delete(id)
    }
  }

  /** Espera el cupo, pasa a corriendo y manda el prompt. false si el encargo no llegó a correr. */
  async function correr(id: number, prompt: string, skills: string[] | undefined): Promise<boolean> {
    const inicial = leer(id)!

    await tomarCupo(inicial.actor.split('/')[0]!, limite(inicial.actor.split('/')[0]!), id)
    const encargo = leer(id)!
    const desde = Date.now()

    if (encargo.estado !== 'en_cola' || !transicion(encargo, 'corriendo', { desde })) {
      soltarCupo(id)

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
          aviso_pendiente: encargo.background,
        })
      ) {
        soltarCupo(id)
        abiertos().delete(encargo.hija)

        if (encargo.background) {
          await avisar({ ...actual, estado: 'fallido', error: `el prompt falló: ${String(error)}` }, encargo.actor)
        }
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

    if (padre.agent === 'regidor' && !planDeSesion(db(), tool.sessionID)) {
      throw new Error('regidor sin plan estrenado: usa /estreno <plan>')
    }

    let hija: string
    let agente: string
    let actor: string
    let suplencia: string | undefined

    if (args.sesion) {
      const previo = db()
        .query('SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1')
        .get({ hija: args.sesion }) as Encargo | null

      if (!previo) {
        throw new Error(`${args.sesion} no es un encargo de reparto`)
      }

      if (!puedeDelegar(padre.agent, previo.a)) {
        throw new Error('dramaturgo solo delega investigación de lectura a utilero, archivista u oracle')
      }

      const sesion = await ctx.session.get({ sessionID: args.sesion })

      hija = sesion.id
      agente = previo.a
      actor = etiquetaRef(sesion.model)
    } else {
      if (!destinos.has(args.a!) && !(actorElegido && args.a === 'critico')) {
        throw new Error(`"${args.a}" no es un agente ni un papel al que se pueda delegar (${[...destinos].join(', ')})`)
      }

      if (!actorElegido && !puedeDelegar(padre.agent, args.a!)) {
        throw new Error('dramaturgo solo delega investigación de lectura a utilero, archivista u oracle')
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

      if (elegido !== validacion.actores.get(args.a!)![0]) {
        suplencia = `el titular está de baja; entra ${etiqueta(elegido)}`
      }

      const sesion = await ctx.session.create({
        title: tituloEncargo(args.a!, args.prompt),
        agent: args.a,
        model: modelRef(elegido),
        location: { directory: padre.location.directory },
        metadata: { padre: tool.sessionID },
      })

      hija = sesion.id
      agente = args.a!
      actor = etiqueta(elegido)
    }

    const fila = {
      hija,
      padre: tool.sessionID,
      a: agente,
      actor,
      background: args.background ? 1 : 0,
      creado: Date.now(),
      ...yo,
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
      background: !!args.background,
      retoma: !!args.sesion,
      suplencia,
    })
    const nota = suplencia ? ` (${suplencia})` : ''

    if (args.background) {
      void correr(id, args.prompt, args.skills)

      return {
        content: `Encargo ${hija} lanzado en background a ${agente} (${actor})${nota}. Te llega un aviso cuando termine, falle, lo interrumpan o quede estancado; no hace falta consultarlo.`,
        metadata: { encargo: id, hija },
      }
    }

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
      if (await correr(id, args.prompt, args.skills)) {
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
        content: `Encargo ${hija} (${agente}) sigue ${encargo.estado}; te llega un aviso cuando cierre.`,
        metadata: { encargo: id, hija },
      }
    }

    write(db(), 'encargo sincrónico entregado', () =>
      db().query('UPDATE encargos SET aviso_pendiente = 0 WHERE id = $id').run({ id }),
    )
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
      const cambios = { cerrado: Date.now(), error: 'interrumpido antes de correr', aviso_pendiente: encargo.background }

      if (transicion(encargo, 'fallido', cambios)) {
        abiertos().delete(hija)

        if (encargo.background) {
          await avisar({ ...encargo, ...cambios, estado: 'fallido' }, encargo.actor)
        }
      }
    } else {
      await ctx.session.interrupt({ sessionID: hija })

      // La transición a interrumpido y el aviso los hace cerrar(), a partir de session.execution.interrupted
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

    return {
      content: [
        encargo
          ? `Encargo ${encargo.hija} (${encargo.a}, ${encargo.actor}): ${encargo.estado}${encargo.error ? ` (${encargo.error})` : ''}.`
          : `Encargo ${entrada.id} (${sesion?.agent}): ${sesion?.outcome ?? 'abierto'}.`,
        `Tool calls (${llamadas.length}):`,
        lineas.join('\n') || '(ninguna)',
        `Mensaje final:`,
        encargo?.mensaje_final ?? (sesion ? await mensajeFinal(entrada.id) : undefined) ?? '(todavía no hay)',
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
  function evento(ev: { type: string; created?: number; data?: unknown }) {
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

    if (nativo) {
      if (
        ev.type === 'session.execution.succeeded' ||
        ev.type === 'session.execution.failed' ||
        ev.type === 'session.execution.interrupted'
      ) {
        hijosNativos().delete(data!.sessionID!)
      } else if (ev.type === 'permission.asked') {
        nativo.permiso = true
      } else if (ev.type === 'permission.replied') {
        nativo.permiso = false
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
      if (nativo.avisado || nativo.permiso || ahora - nativo.actividad < PLAZO_ESTANCADO) {
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

    for (const [hija, abierto] of abiertos()) {
      if (abierto.estancado || ahora - abierto.actividad < PLAZO_ESTANCADO || permisoPendiente(hija)) {
        continue
      }

      const encargo = leer(abierto.id)

      if (encargo?.estado !== 'corriendo' || !transicion(encargo, 'estancado')) {
        continue
      }

      abierto.estancado = true
      log.warn('encargo estancado', { id: encargo.id, hija })
      await avisar({ ...encargo, estado: 'estancado' }, encargo.actor)
    }
  }

  /** Al arrancar: cierra los encargos de procesos muertos y reenvía los avisos pendientes (al menos una vez). */
  async function reconciliar() {
    const filas = db()
      .query("SELECT * FROM encargos WHERE estado IN ('en_cola', 'corriendo', 'estancado') OR aviso_pendiente = 1 ORDER BY id")
      .all() as Encargo[]

    for (const encargo of filas) {
      if (vivo(encargo)) {
        continue
      } // Es de un proceso vivo, con su cola intacta (S15)

      try {
        if (isOpen(encargo)) {
          // Desde otro proceso `wait` vuelve en el acto (S13): se mira el outcome, y solo si es posterior a `desde`
          const cierreActual = encargo.estado === 'en_cola' ? undefined : await cierre(encargo).catch(() => undefined)
          const estado = cierreActual?.estado ?? 'fallido'
          const cambios = {
            cerrado: Date.now(),
            mensaje_final: cierreActual?.mensaje ?? null,
            error: cierreActual ? (cierreActual.error ?? null) : 'perdido en reinicio',
            aviso_pendiente: 1,
          }

          if (!transicion(encargo, estado, cambios)) {
            continue
          }

          const cerrado = { ...encargo, ...cambios, estado }

          log.info('encargo reconciliado', { id: encargo.id, hija: encargo.hija, estado, error: cambios.error })
          await avisar(cerrado, cierreActual?.ultimoActor ?? encargo.actor)
        } else {
          log.info('aviso pendiente reenviado', { id: encargo.id, hija: encargo.hija, estado: encargo.estado })
          await avisar(encargo, encargo.actor)
        }
      } catch (error) {
        log.error('reconciliación falló', { id: encargo.id, error: String(error) })
      }
    }
  }

  return { delegar, interrumpir, bitacora, registrarLlamada, evento, vigilar, reconciliar }
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
