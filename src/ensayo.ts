import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { etiqueta } from './actores.ts'
import { bajasVigentes, deBaja } from './bajas.ts'
import { db, write } from './db.ts'
import { proceso } from './process.ts'

import type { Validacion } from './actores.ts'
import type { Actor } from './config.ts'
import type { Encargo } from './encargos.ts'
import type { Database } from 'bun:sqlite'

export interface Objecion {
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

  if (cabecera === 'VEREDICTO: OBJECIONES' && !objeciones.length) {
    throw new Error('veredicto inválido: OBJECIONES sin objeción válida')
  }

  return { veredicto: cabecera === 'VEREDICTO: APROBADO' ? 'APROBADO' : 'OBJECIONES', objeciones, notas, cierres }
}

const proveedor = (actor: Actor) => actor.model.split('/')[0]

export function elegirRevisores(
  validacion: Validacion,
  dramaturgo: string | undefined,
  fuera: (actor: Actor) => boolean,
): { critico: Actor; oracle: Actor; repetidos: boolean } | undefined {
  const criticos = (validacion.actores.get('critico') ?? []).filter((actor) => !fuera(actor))
  const oracles = (validacion.actores.get('oracle') ?? []).filter((actor) => !fuera(actor))
  const pares = criticos.flatMap((critico) => oracles.map((oracle) => ({ critico, oracle })))
  const distinto = pares.find(
    ({ critico, oracle }) =>
      proveedor(critico) !== dramaturgo && proveedor(oracle) !== dramaturgo && proveedor(critico) !== proveedor(oracle),
  )
  const elegido = distinto ?? pares.find(({ critico, oracle }) => proveedor(critico) !== proveedor(oracle)) ?? pares[0]

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

export function ensayo(
  ctx: {
    session: {
      get: (entrada: {
        sessionID: string
      }) => Promise<{ agent?: string; model?: { providerID: string }; location: { directory: string } }>
    }
  },
  encargos: {
    delegar: (
      entrada: { a: string; prompt: string },
      tool: { sessionID: string; signal: AbortSignal },
      actor: Actor,
    ) => Promise<string>
  },
) {
  return async (input: { plan: string }, tool: { sessionID: string; signal: AbortSignal }) => {
    const padre = await ctx.session.get({ sessionID: tool.sessionID })

    if (padre.agent !== 'dramaturgo') {
      throw new Error('ensayar: solo el dramaturgo puede ensayar')
    }

    const raiz = resolve(padre.location.directory, '.reparto/planes')
    const ruta = resolve(padre.location.directory, input.plan)
    const relativa = relative(raiz, ruta)

    if (isAbsolute(input.plan) || relativa.startsWith('..') || isAbsolute(relativa) || !relativa || !ruta.endsWith('.md')) {
      throw new Error('ensayar: el plan debe estar bajo .reparto/planes/ y ser .md')
    }

    const real = await realpath(ruta)

    if (real !== ruta) {
      throw new Error('ensayar: no se permiten symlinks')
    }

    const contenido = await Bun.file(ruta).text()
    const hash = createHash('sha256').update(contenido).digest('hex')
    const plan = real
    const nombre = relative(padre.location.directory, ruta)
    const database = db()
    const anterior = database
      .query<Ensayo, { plan: string }>('SELECT * FROM ensayos WHERE plan = $plan ORDER BY ronda DESC LIMIT 1')
      .get({ plan })

    if (anterior?.veredicto !== 'pendiente') {
      if (anterior) {
        const filas = database
          .query<Ensayo, { plan: string; ronda: number }>('SELECT * FROM ensayos WHERE plan = $plan AND ronda = $ronda')
          .all({ plan, ronda: anterior.ronda })
        const acta = database.query<EntradaActa, { plan: string }>('SELECT * FROM acta WHERE plan = $plan').all({ plan })

        if (
          filas.length === 2 &&
          filas.every((fila) => fila.veredicto !== 'pendiente') &&
          cerrado(
            filas.map((fila) => JSON.parse(fila.veredicto) as Veredicto),
            acta,
            filas.map((fila) => fila.hash),
          ) &&
          anterior.hash === hash
        ) {
          return { content: JSON.stringify({ plan: nombre, ronda: anterior.ronda, cerrado: true, acta }) }
        }
      }

      if (anterior && anterior.ronda >= 5) {
        return {
          content: JSON.stringify({ plan: nombre, ronda: 5, cerrado: false, decision: 'Bryan debe decidir: máximo 5 rondas' }),
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
      throw new Error('ensayar: crítico u oracle sin actores disponibles')
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
    const acta = database
      .query<EntradaActa, { plan: string }>('SELECT * FROM acta WHERE plan = $plan ORDER BY id')
      .all({ plan })

    if (
      !write(database, 'iniciar ensayo', () => {
        database
          .query('INSERT OR IGNORE INTO versiones (plan, hash, contenido) VALUES ($plan, $hash, $contenido)')
          .run({ plan, hash: hashRonda, contenido: version.contenido })

        for (const [revisor, actor] of [
          ['critico', actores.critico],
          ['oracle', actores.oracle],
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
        : `Closure round ${ronda}. Diff from previous snapshot:\n${diferencia(previo?.contenido ?? '', version.contenido)}\n\nActa:\n${JSON.stringify(acta)}`
    const prompt = `${contexto}\n\nPlan snapshot (review this exact text):\n${version.contenido}\n\nOutput format: VEREDICTO: APROBADO or VEREDICTO: OBJECIONES; OBJECION: section | concrete defect | cause | closing condition (and round-1 justification for new closure-round objections); ACTA: numeric-id | cerrado/abierto for each acta entry; NOTA: observation.`
    const resultados = await Promise.allSettled(
      (['critico', 'oracle'] as const).map(async (revisor) => {
        const hija = await encargos.delegar({ a: revisor, prompt }, tool, actores[revisor])
        const fila = database
          .query<Encargo, { hija: string }>('SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1')
          .get({ hija })

        if (fila?.estado !== 'terminado' || !fila.mensaje_final) {
          throw new Error(`${revisor}: encargo no terminó (${fila?.estado})`)
        }

        return { revisor, actor: fila.actor, veredicto: parsearVeredicto(fila.mensaje_final), hija: fila.hija }
      }),
    )

    if (resultados.some((resultado) => resultado.status === 'rejected')) {
      throw new Error(
        `ensayar: ronda ${ronda} incompleta; reintenta con encargos nuevos: ${resultados
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
        plan: nombre,
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
