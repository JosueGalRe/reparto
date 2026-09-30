import { createHash } from 'node:crypto'

import { etiqueta, modelRef } from './actores.ts'
import { bajasVigentes, deBaja } from './bajas.ts'
import { db, write } from './db.ts'
import { log } from './log.ts'
import { proceso } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { Validacion } from './actores.ts'
import type { Actor } from './config.ts'
import type { Plugin } from '@opencode/plugin'
import type { Database } from 'bun:sqlite'

interface Objecion {
  readonly seccion: string
  readonly defecto: string
  readonly causa: string
  readonly cierre: string
  readonly justificacion?: string
}
export interface Veredicto {
  readonly veredicto: 'APROBADO' | 'OBJECIONES'
  readonly objeciones: readonly Objecion[]
  readonly notas: readonly string[]
  readonly cierres: Readonly<Record<number, 'cerrado' | 'abierto'>>
}
export interface EntradaActa {
  readonly plan: string
  readonly id: number
  readonly objecion: string
  readonly causa: string
  readonly condicion_cierre: string
  readonly ronda_entrada: number
  readonly estado: 'abierto' | 'cerrado'
}
interface Ensayo {
  readonly plan: string
  readonly ronda: number
  readonly hash: string
  readonly revisor: string
  readonly actor: string
  readonly veredicto: string
}
type Revisor = 'critico' | 'tiresias'
interface Llamada {
  readonly sessionID: string
  readonly signal: AbortSignal
}
export type Revisar = (
  revisor: Revisor,
  prompt: string,
  tool: Llamada,
  actor: Actor,
) => Promise<{ hija: string; actor: string; mensaje: string }>

type Sesion = Awaited<ReturnType<Plugin.Context['session']['get']>>
type Mensaje = Awaited<ReturnType<Plugin.Context['session']['context']>>[number]

export interface ContextoRevisores {
  readonly session: {
    get: (entrada: { sessionID: string }) => Promise<Pick<Sesion, 'model' | 'outcome' | 'location'>>
    create: (entrada: Parameters<Plugin.Context['session']['create']>[0]) => Promise<{ id: string }>
    context: (entrada: { sessionID: string }) => Promise<
      readonly (
        | {
            readonly type: 'assistant'
            readonly content: readonly (
              | { readonly type: 'text'; readonly text: string }
              | { readonly type: 'reasoning' | 'tool' }
            )[]
          }
        | { readonly type: Exclude<Mensaje['type'], 'assistant'> }
      )[]
    >
    prompt: (entrada: Parameters<Plugin.Context['session']['prompt']>[0]) => Promise<unknown>
    wait: (entrada: Parameters<Plugin.Context['session']['wait']>[0]) => Promise<void>
    interrupt: (entrada: Parameters<Plugin.Context['session']['interrupt']>[0]) => Promise<unknown>
  }
}

export function leerVeredicto(texto: string): Veredicto {
  const datos: unknown = JSON.parse(texto)

  if (!esRegistro(datos)) {
    throw new Error('veredicto guardado: se esperaba un objeto')
  }

  if (datos.veredicto !== 'APROBADO' && datos.veredicto !== 'OBJECIONES') {
    throw new Error('veredicto guardado: veredicto tiene que ser APROBADO u OBJECIONES')
  }

  if (!Array.isArray(datos.objeciones)) {
    throw new Error('veredicto guardado: objeciones tiene que ser una lista')
  }

  const objeciones = datos.objeciones.map((objecion: unknown, indice): Objecion => {
    if (
      !esRegistro(objecion) ||
      typeof objecion.seccion !== 'string' ||
      typeof objecion.defecto !== 'string' ||
      typeof objecion.causa !== 'string' ||
      typeof objecion.cierre !== 'string' ||
      (objecion.justificacion !== undefined && typeof objecion.justificacion !== 'string')
    ) {
      throw new Error(
        `veredicto guardado: objeciones[${indice}] requiere seccion, defecto, causa y cierre de texto; justificacion es texto opcional`,
      )
    }

    return {
      seccion: objecion.seccion,
      defecto: objecion.defecto,
      causa: objecion.causa,
      cierre: objecion.cierre,
      ...(objecion.justificacion !== undefined ? { justificacion: objecion.justificacion } : {}),
    }
  })

  if (!Array.isArray(datos.notas)) {
    throw new Error('veredicto guardado: notas tiene que ser una lista')
  }

  const notas = datos.notas.map((nota: unknown, indice) => {
    if (typeof nota !== 'string') {
      throw new Error(`veredicto guardado: notas[${indice}] tiene que ser texto`)
    }

    return nota
  })

  if (!esRegistro(datos.cierres)) {
    throw new Error('veredicto guardado: cierres tiene que ser un objeto')
  }

  const cierres: Record<number, 'cerrado' | 'abierto'> = {}

  for (const [id, estado] of Object.entries(datos.cierres)) {
    if (!id.trim() || !Number.isFinite(Number(id)) || (estado !== 'cerrado' && estado !== 'abierto')) {
      throw new Error(`veredicto guardado: cierres[${id}] requiere un id numérico y estado cerrado o abierto`)
    }

    cierres[Number(id)] = estado
  }

  return { veredicto: datos.veredicto, objeciones, notas, cierres }
}

export function parsearVeredicto(texto: string): Veredicto {
  const lineas = texto
    .trim()
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter(Boolean)
  const cabecera = lineas.find((linea) => linea.startsWith('VEREDICTO:'))

  if (cabecera !== 'VEREDICTO: APROBADO' && cabecera !== 'VEREDICTO: OBJECIONES') {
    throw new Error('veredicto inválido: falta VEREDICTO: APROBADO | OBJECIONES')
  }

  const objeciones: Objecion[] = []
  const notas: string[] = []
  const cierres: Record<number, 'cerrado' | 'abierto'> = {}

  for (const linea of lineas) {
    if (linea.startsWith('OBJECION')) {
      if (!linea.startsWith('OBJECION:')) {
        throw new Error(`veredicto inválido: ${linea}`)
      }

      const campos = linea
        .slice(9)
        .split('|')
        .map((campo) => campo.trim())

      if (campos.length < 4 || campos.length > 5 || campos.slice(0, 4).some((campo) => !campo)) {
        throw new Error(`veredicto inválido: ${linea}`)
      }

      const [seccion, defecto, causa, cierre, justificacion] = campos

      if (seccion && defecto && causa && cierre) {
        objeciones.push({ seccion, defecto, causa, cierre, ...(justificacion ? { justificacion } : {}) })
      }
    } else if (linea.startsWith('NOTA:')) {
      notas.push(linea.slice(5).trim())
    } else if (linea.startsWith('ACTA')) {
      const match = /^ACTA:\s*(\d+)\s*\|\s*(cerrado|abierto)$/.exec(linea)

      if (match) {
        cierres[Number(match[1])] = match[2] === 'cerrado' ? 'cerrado' : 'abierto'
      } else {
        throw new Error(`veredicto inválido: ${linea}`)
      }
    }
  }

  if (cabecera === 'VEREDICTO: OBJECIONES' && !objeciones.length && !Object.values(cierres).includes('abierto')) {
    throw new Error('veredicto inválido: OBJECIONES sin objeción válida ni acta abierta')
  }

  return { veredicto: cabecera === 'VEREDICTO: APROBADO' ? 'APROBADO' : 'OBJECIONES', objeciones, notas, cierres }
}

const proveedor = (actor: Actor) => actor.model.split('/')[0]

export function elegirRevisores(
  validacion: Validacion,
  dramaturgo: string | undefined,
  fuera: (actor: Actor) => boolean,
): { critico: Actor; tiresias: Actor; repetidos: boolean } | undefined {
  const criticos = (validacion.actores.get('critico') ?? []).filter((actor) => !fuera(actor))
  const tiresiasDisponibles = (validacion.actores.get('tiresias') ?? []).filter((actor) => !fuera(actor))
  const pares = criticos.flatMap((critico) => tiresiasDisponibles.map((tiresias) => ({ critico, tiresias })))
  const distinto = pares.find(
    ({ critico, tiresias }) =>
      proveedor(critico) !== dramaturgo && proveedor(tiresias) !== dramaturgo && proveedor(critico) !== proveedor(tiresias),
  )
  const elegido = distinto ?? pares.find(({ critico, tiresias }) => proveedor(critico) !== proveedor(tiresias)) ?? pares[0]

  return elegido && { ...elegido, repetidos: !distinto }
}

export function actualizarActa(
  database: Database,
  plan: string,
  ronda: number,
  revisiones: readonly Veredicto[],
): EntradaActa[] {
  const previo = database
    .query<EntradaActa, { plan: string }>('SELECT * FROM acta WHERE plan = $plan ORDER BY id')
    .all({ plan })
  const alta = database.query(`INSERT INTO acta (plan, id, objecion, causa, condicion_cierre, ronda_entrada, estado)
    VALUES ($plan, $id, $objecion, $causa, $condicion_cierre, $ronda_entrada, 'abierto')`)
  let id = (previo.at(-1)?.id ?? 0) + 1

  for (const revision of revisiones) {
    for (const objecion of revision.objeciones) {
      if (ronda > 1 && !objecion.justificacion) {
        continue
      }

      // Ponytail: no automatic duplicate merging; the dramaturgo can reconcile duplicates after reviewing the acta.
      alta.run({
        plan,
        id: id++,
        objecion: `${objecion.seccion}: ${objecion.defecto}`,
        causa: objecion.causa,
        condicion_cierre: objecion.cierre,
        ronda_entrada: ronda,
      })
    }
  }

  if (ronda > 1) {
    for (const entrada of previo) {
      const estado = revisiones.every((revision) => revision.cierres[entrada.id] === 'cerrado') ? 'cerrado' : 'abierto'

      database.query('UPDATE acta SET estado = $estado WHERE plan = $plan AND id = $id').run({ estado, plan, id: entrada.id })
    }
  }

  return database.query<EntradaActa, { plan: string }>('SELECT * FROM acta WHERE plan = $plan ORDER BY id').all({ plan })
}

export function cerrado(revisiones: readonly Veredicto[], acta: readonly EntradaActa[], hashes: readonly string[]): boolean {
  return (
    revisiones.length === 2 &&
    hashes.length === 2 &&
    hashes[0] === hashes[1] &&
    revisiones.every((revision) => revision.veredicto === 'APROBADO' && revision.objeciones.length === 0) &&
    acta.every((entrada) => entrada.estado === 'cerrado')
  )
}

export function admitir(veredicto: Veredicto, ronda: number, acta: readonly EntradaActa[]): Veredicto {
  const aceptadas = ronda === 1 ? veredicto.objeciones : veredicto.objeciones.filter((objecion) => !!objecion.justificacion)

  return {
    ...veredicto,
    notas: [
      ...veredicto.notas,
      ...(ronda > 1
        ? veredicto.objeciones
            .filter((objecion) => !objecion.justificacion)
            .map((objecion) => `${objecion.seccion}: ${objecion.defecto}`)
        : []),
    ],
    objeciones: aceptadas,
    veredicto:
      aceptadas.length || (ronda > 1 && acta.some((entrada) => veredicto.cierres[entrada.id] !== 'cerrado'))
        ? 'OBJECIONES'
        : 'APROBADO',
  }
}

function diferencia(anterior: string, actual: string): string {
  const lineasAnteriores = anterior.split('\n')
  const lineasActuales = actual.split('\n')
  let inicio = 0

  while (
    inicio < Math.min(lineasAnteriores.length, lineasActuales.length) &&
    lineasAnteriores[inicio] === lineasActuales[inicio]
  ) {
    inicio++
  }

  let fin = 0

  while (
    fin < Math.min(lineasAnteriores.length - inicio, lineasActuales.length - inicio) &&
    lineasAnteriores[lineasAnteriores.length - 1 - fin] === lineasActuales[lineasActuales.length - 1 - fin]
  ) {
    fin++
  }

  return (
    [
      ...lineasAnteriores.slice(inicio, lineasAnteriores.length - fin).map((linea) => `- ${linea}`),
      ...lineasActuales.slice(inicio, lineasActuales.length - fin).map((linea) => `+ ${linea}`),
    ].join('\n') || '(sin cambios)'
  )
}

const leerActa = (database: Database, plan: string) =>
  database.query<EntradaActa, { plan: string }>('SELECT * FROM acta WHERE plan = $plan ORDER BY id').all({ plan })

/** ¿Cerró esta ronda? Ambas revisiones terminadas y aprobadas sobre el mismo hash, con el acta cerrada. */
function cierreGuardado(database: Database, plan: string, ronda: number): boolean {
  const filas = database
    .query<Ensayo, { plan: string; ronda: number }>('SELECT * FROM ensayos WHERE plan = $plan AND ronda = $ronda')
    .all({ plan, ronda })

  return (
    filas.length === 2 &&
    filas.every((fila) => fila.veredicto !== 'pendiente') &&
    cerrado(
      filas.map((fila) => leerVeredicto(fila.veredicto)),
      leerActa(database, plan),
      filas.map((fila) => fila.hash),
    )
  )
}

/** Lo que exige el gate de `submit_plan`: la última ronda de la sesión cerró, o llegó a la 5 y decide Bryan. */
export function ensayoTerminado(database: Database, plan: string): boolean {
  const ultima = database
    .query<Ensayo, { plan: string }>('SELECT * FROM ensayos WHERE plan = $plan ORDER BY ronda DESC LIMIT 1')
    .get({ plan })

  return !!ultima && ultima.veredicto !== 'pendiente' && (ultima.ronda >= 5 || cierreGuardado(database, plan, ultima.ronda))
}

async function mensajeFinal(ctx: ContextoRevisores, hija: string): Promise<string | undefined> {
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

/**
 * Cada revisor es una sesión propia con el actor elegido, ligada al Dramaturgo por `metadata.padre` y sin
 * `parentID`: así el hook de hijas no le cambia el actor. Si el titular cae a mitad, el `retry` sigue la lista.
 * Sin `parentID`, un pedido de permiso no le aparece a nadie y la ronda se cuelga: por eso `external_directory`,
 * el único `ask` de los revisores, va negado en la sesión. Revisan un texto que viene en el prompt.
 */
export function revisores(ctx: ContextoRevisores): Revisar {
  return async (revisor, prompt, tool, actorElegido) => {
    const padre = await ctx.session.get({ sessionID: tool.sessionID })
    const { id: hija } = await ctx.session.create({
      title: `${revisor} · ensayo`,
      agent: revisor,
      model: modelRef(actorElegido),
      location: { directory: padre.location.directory },
      metadata: { padre: tool.sessionID },
      permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' }],
    })
    const interrumpir = () =>
      void ctx.session
        .interrupt({ sessionID: hija })
        .catch((error) => log.error('interrupt falló', { hija, error: String(error) }))

    log.info('revisor creado', { hija, padre: tool.sessionID, revisor, actor: etiqueta(actorElegido) })
    tool.signal.addEventListener('abort', interrumpir, { once: true })

    try {
      await ctx.session.prompt({ sessionID: hija, text: prompt })
      await ctx.session.wait({ sessionID: hija })
    } finally {
      tool.signal.removeEventListener('abort', interrumpir)
    }

    const sesion = await ctx.session.get({ sessionID: hija })

    if (sesion.outcome !== 'succeeded') {
      throw new Error(`${revisor}: ${hija} terminó ${sesion.outcome ?? 'sin outcome'}`)
    }

    const mensaje = await mensajeFinal(ctx, hija)

    if (!mensaje) {
      throw new Error(`${revisor}: ${hija} terminó sin salida`)
    }

    const actor = sesion.model
      ? etiqueta({ model: `${sesion.model.providerID}/${sesion.model.id}`, variant: sesion.model.variant })
      : etiqueta(actorElegido)

    return { hija, actor, mensaje }
  }
}

export function ensayo(
  ctx: {
    session: {
      get: (entrada: { sessionID: string }) => Promise<{ agent?: string; model?: { providerID: string } }>
    }
  },
  revisar: Revisar,
) {
  return async (input: { plan: string }, tool: Llamada) => {
    const padre = await ctx.session.get({ sessionID: tool.sessionID })

    if (padre.agent !== 'plan') {
      throw new Error('ensayar: solo el Dramaturgo (plan) puede ensayar')
    }

    const contenido = input.plan

    if (!contenido.trim()) {
      throw new Error('ensayar: el plan está vacío')
    }

    const hash = createHash('sha256').update(contenido).digest('hex')
    // Ponytail: un plan por sesión. Un segundo plan en la misma sesión hereda el acta del primero; si pasa seguido,
    // La clave pasa a ser sesión + título del plan.
    const plan = tool.sessionID
    const database = db()
    const anterior = database
      .query<Ensayo, { plan: string }>('SELECT * FROM ensayos WHERE plan = $plan ORDER BY ronda DESC LIMIT 1')
      .get({ plan })

    if (anterior?.veredicto !== 'pendiente') {
      if (anterior && anterior.hash === hash && cierreGuardado(database, plan, anterior.ronda)) {
        return { content: JSON.stringify({ ronda: anterior.ronda, cerrado: true, acta: leerActa(database, plan) }) }
      }

      if (anterior && anterior.ronda >= 5) {
        return {
          content: JSON.stringify({ ronda: 5, cerrado: false, decision: 'Bryan debe decidir: máximo 5 rondas' }),
        }
      }
    }

    const ronda = anterior?.veredicto === 'pendiente' ? anterior.ronda : (anterior?.ronda ?? 0) + 1
    const version =
      anterior?.veredicto === 'pendiente'
        ? database
            .query<{ contenido: string }, { plan: string; hash: string }>(
              'SELECT contenido FROM versiones WHERE plan = $plan AND hash = $hash',
            )
            .get({ plan, hash: anterior.hash })
        : { contenido }

    if (!version) {
      throw new Error('ensayar: instantánea pendiente ausente')
    }

    const hashRonda = anterior?.veredicto === 'pendiente' ? anterior.hash : hash
    const validacion = proceso.validacion

    if (!validacion) {
      throw new Error('ensayar: actores aún no validados')
    }

    const actores = elegirRevisores(validacion, padre.model?.providerID, deBaja(bajasVigentes(database)))

    if (!actores) {
      throw new Error('ensayar: crítico o tiresias sin actores disponibles')
    }

    const prevHash = database
      .query<{ hash: string }, { plan: string; ronda: number }>(
        'SELECT hash FROM ensayos WHERE plan = $plan AND ronda = $ronda LIMIT 1',
      )
      .get({ plan, ronda: ronda - 1 })
    const previo =
      prevHash &&
      database
        .query<{ contenido: string }, { plan: string; hash: string }>(
          'SELECT contenido FROM versiones WHERE plan = $plan AND hash = $hash',
        )
        .get({ plan, hash: prevHash.hash })
    const acta = leerActa(database, plan)

    if (
      !write(database, 'iniciar ensayo', () => {
        database
          .query('INSERT OR IGNORE INTO versiones (plan, hash, contenido) VALUES ($plan, $hash, $contenido)')
          .run({ plan, hash: hashRonda, contenido: version.contenido })

        for (const [revisor, actor] of [
          ['critico', actores.critico],
          ['tiresias', actores.tiresias],
        ] as const) {
          database
            .query(`INSERT INTO ensayos (plan, ronda, hash, revisor, actor, veredicto) VALUES ($plan, $ronda, $hash, $revisor, $actor, 'pendiente')
          ON CONFLICT (plan, ronda, revisor) DO UPDATE SET veredicto = 'pendiente', actor = excluded.actor`)
            .run({ plan, ronda, hash: hashRonda, revisor, actor: etiqueta(actor) })
        }

        return true
      })
    ) {
      throw new Error('ensayar: no se pudo iniciar ronda')
    }

    const contexto =
      ronda === 1
        ? 'Round 1: discovery.'
        : `Closure round ${ronda}. Diff from previous snapshot:\n${diferencia(previo?.contenido ?? '', version.contenido)}\n\nActa:\n${JSON.stringify(acta)}\n\nReview only the diff, the acta and regressions caused by fixes. Report every acta entry as ACTA: <numeric id> | cerrado or ACTA: <numeric id> | abierto. For each NEW objection, append a fifth field: <why round 1 could not have found it>. A new issue is admissible only if caused by a fix, previously unverifiable evidence, or a concrete data-loss/security risk. If you cannot justify it, make it a NOTA instead. Approve only when every acta entry is closed and no admissible objection remains.`
    const prompt = `${contexto}\n\nPlan snapshot (review this exact text):\n${version.contenido}\n\nReturn one line per field, no Markdown fences. First line: VEREDICTO: APROBADO or VEREDICTO: OBJECIONES. Every blocking objection: OBJECION: <section> | <concrete defect> | <cause> | <closing condition>. Optional notes: NOTA: <observation>. Use OBJECIONES if an acta entry is open or an admissible objection remains; otherwise use APROBADO.`
    const resultados = await Promise.allSettled(
      (['critico', 'tiresias'] as const).map(async (revisor) => {
        const { hija, actor, mensaje } = await revisar(revisor, prompt, tool, actores[revisor])

        return { revisor, actor, veredicto: parsearVeredicto(mensaje), hija }
      }),
    )

    if (resultados.some((resultado) => resultado.status === 'rejected')) {
      throw new Error(
        `ensayar: ronda ${ronda} incompleta; reintenta con revisores nuevos: ${resultados
          .filter((resultado) => resultado.status === 'rejected')
          .map((resultado) => String(resultado.reason))
          .join('; ')}`,
      )
    }

    const revisiones = resultados.filter((resultado) => resultado.status === 'fulfilled').map((resultado) => resultado.value)
    // An objection without round-1 justification is only a note and cannot block closure.
    const efectivos = revisiones.map((revision) => ({ ...revision, veredicto: admitir(revision.veredicto, ronda, acta) }))
    const final = write(database, 'cerrar ensayo', () => {
      const lista = actualizarActa(
        database,
        plan,
        ronda,
        efectivos.map((revision) => revision.veredicto),
      )

      for (const revision of efectivos) {
        database
          .query(
            'UPDATE ensayos SET veredicto = $veredicto, actor = $actor WHERE plan = $plan AND ronda = $ronda AND revisor = $revisor',
          )
          .run({ plan, ronda, revisor: revision.revisor, actor: revision.actor, veredicto: JSON.stringify(revision.veredicto) })
      }

      return lista
    })

    if (!final) {
      throw new Error('ensayar: no se pudo guardar la ronda')
    }

    const cierre = cerrado(
      efectivos.map((revision) => revision.veredicto),
      final,
      [hashRonda, hashRonda],
    )

    return {
      content: JSON.stringify({
        ronda,
        hash: hashRonda,
        revisores: efectivos,
        acta: final,
        cerrado: cierre,
        proveedores: actores.repetidos ? 'proveedores repetidos' : 'distintos',
        ...(ronda === 5 && !cierre ? { decision: 'Bryan debe decidir' } : {}),
      }),
    }
  }
}
