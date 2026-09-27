import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { db, write } from './db.ts'
import { cerrado } from './ensayo.ts'
import { formatear, leerPendientes } from './pendientes.ts'

import type { EntradaActa, Veredicto } from './ensayo.ts'
import type { Item } from './pendientes.ts'
import type { Plugin } from '@opencode/plugin'
import type { Database } from 'bun:sqlite'

interface Ensayo { readonly ronda: number; readonly hash: string; readonly revisor: string; readonly veredicto: string }
export interface Estreno {
  readonly plan: string
  readonly hash: string
  readonly fecha: number
  readonly tipo: 'normal' | 'con_objeciones'
  readonly objeciones: string
}
export interface ReferenciaPlan { readonly plan: string; readonly hash: string }

export const clavePlan = ({ plan, hash }: ReferenciaPlan) => `${plan}\u0000${hash}`

export function planDeSesion(database: Database, sesion: string): ReferenciaPlan | undefined {
  return database
    .query(`SELECT s.plan, s.hash FROM sesiones_regidor s JOIN estrenos e ON e.plan = s.plan AND e.hash = s.hash
    WHERE s.sesion = $sesion`)
    .get({ sesion }) as ReferenciaPlan | undefined
}

export function ligarSesion(database: Database, sesion: string, ref: ReferenciaPlan) {
  const result = write(database, 'ligar sesión al estreno', () =>
    database.query('INSERT INTO sesiones_regidor (sesion, plan, hash) VALUES ($sesion, $plan, $hash)').run({ sesion, ...ref }),
  )

  if (!result) {throw new Error('estreno: no se pudo ligar la sesión al plan')}
}

export function tareas(contenido: string): Item[] {
  const titulos = [...contenido.matchAll(/^### (T\d+):\s*(.+)$/gm)]

  if (!titulos.length || titulos.some((m, i) => m[1] !== `T${i + 1}`))
    {throw new Error('estreno: el plan necesita tareas T1…Tn en orden')}
  return titulos.map((m) => ({ texto: `${m[1]}: ${m[2]}`, estado: 'pendiente' }))
}

/** Check the current hash, both reviewers and the acta before any write. */
export function evaluarEstreno(
  database: Database,
  plan: string,
  hash: string,
  conObjeciones: boolean,
): { tipo: Estreno['tipo']; abiertas: EntradaActa[] } {
  const estrenado = database.query('SELECT * FROM estrenos WHERE plan = $plan').get({ plan }) as Estreno | null

  if (estrenado) {
    if (estrenado.hash !== hash)
      {throw new Error('estreno: el archivo cambió después del estreno; el plan estrenado es inmutable')}
    return { tipo: estrenado.tipo, abiertas: JSON.parse(estrenado.objeciones) as EntradaActa[] }
  }

  const ultima = database.query('SELECT max(ronda) AS ronda FROM ensayos WHERE plan = $plan').get({ plan }) as {
    ronda: number | null
  }

  if (ultima.ronda === null) {throw new Error('estreno: el plan no tiene ensayo general')}
  const filas = database
    .query('SELECT ronda, hash, revisor, veredicto FROM ensayos WHERE plan = $plan AND ronda = $ronda ORDER BY revisor')
    .all({ plan, ronda: ultima.ronda }) as Ensayo[]

  if (filas.some((fila) => fila.hash !== hash))
    {throw new Error('estreno: el archivo cambió después de la versión ensayada; ensaya el hash actual')}
  if (
    filas.length !== 2 ||
    filas.some((fila) => fila.veredicto === 'pendiente') ||
    new Set(filas.map((fila) => fila.revisor)).size !== 2
  )
    {throw new Error('estreno: ronda incompleta; faltan los dos revisores')}
  const acta = database.query('SELECT * FROM acta WHERE plan = $plan ORDER BY id').all({ plan }) as EntradaActa[]
  const veredictos = filas.map((fila) => JSON.parse(fila.veredicto) as Veredicto)

  if (
    cerrado(
      veredictos,
      acta,
      filas.map((fila) => fila.hash),
    )
  )
    {return { tipo: 'normal', abiertas: [] }}
  if (conObjeciones && ultima.ronda === 5)
    {return { tipo: 'con_objeciones', abiertas: acta.filter((entrada) => entrada.estado === 'abierto') }}
  throw new Error(
    conObjeciones
      ? 'estreno: con-objeciones requiere 5 rondas completas sin cierre'
      : 'estreno: los dos revisores deben aprobar el mismo hash; quedan objeciones',
  )
}

export function registrarEstreno(
  database: Database,
  referencia: ReferenciaPlan,
  contenido: string,
  conObjeciones: boolean,
  sesion?: string,
): { estreno: Estreno; items: Item[]; activa?: string; nueva?: boolean } {
  const { plan, hash } = referencia
  const tasks = tareas(contenido)
  const resultado = write(database, 'estrenar plan', () => {
    let aprobado: ReturnType<typeof evaluarEstreno>

    try {
      aprobado = evaluarEstreno(database, plan, hash, conObjeciones)
    } catch (error) {
      if (error instanceof Error) {return error}
      throw error
    }

    const fecha = Date.now()

    database
      .query(
        'INSERT OR IGNORE INTO estrenos (plan, hash, fecha, tipo, objeciones) VALUES ($plan, $hash, $fecha, $tipo, $objeciones)',
      )
      .run({ plan, hash, fecha, tipo: aprobado.tipo, objeciones: JSON.stringify(aprobado.abiertas) })
    const clave = clavePlan(referencia)

    database
      .query('INSERT OR IGNORE INTO pendientes (clave, items, actualizado) VALUES ($clave, $items, $actualizado)')
      .run({ clave, items: JSON.stringify(tasks), actualizado: fecha })
    const items = leerPendientes(database, clave)
    const activa =
      sesion && items.some((item) => item.estado !== 'hecho')
        ? (database
            .query(`SELECT s.sesion FROM sesiones_regidor s JOIN estrenos e ON e.plan = s.plan AND e.hash = s.hash
        WHERE s.plan = $plan AND s.hash = $hash ORDER BY s.rowid DESC LIMIT 1`)
            .get({ plan, hash }) as { sesion: string } | null)
        : null

    if (sesion && !activa)
      {database
        .query('INSERT INTO sesiones_regidor (sesion, plan, hash) VALUES ($sesion, $plan, $hash)')
        .run({ sesion, plan, hash })}
    return {
      estreno: database.query('SELECT * FROM estrenos WHERE plan = $plan').get({ plan }) as Estreno,
      items,
      ...(sesion ? { activa: activa?.sesion ?? sesion, nueva: !activa } : {}),
    }
  })

  if (resultado instanceof Error) {throw resultado}
  if (!resultado) {throw new Error('estreno: no se pudo guardar en SQLite')}
  return resultado
}

export function estreno(ctx: Plugin.Context) {
  return async (input: { sessionID: string; prompt: { text: string } }) => {
    const tokens = input.prompt.text
      .trim()
      .replace(/^\/estreno\s+/, '')
      .split(/\s+/)
    const [nombre, modificador, extra] = tokens

    if (!nombre || extra || (modificador && modificador !== 'con-objeciones'))
      {throw new Error('uso: /estreno .reparto/planes/<plan>.md [con-objeciones]')}
    const sesion = await ctx.session.get({ sessionID: input.sessionID })
    const raiz = resolve(sesion.location.directory, '.reparto/planes')
    const ruta = resolve(sesion.location.directory, nombre)
    const relativa = relative(raiz, ruta)

    if (isAbsolute(nombre) || !relativa || relativa.startsWith('..') || isAbsolute(relativa) || !ruta.endsWith('.md'))
      {throw new Error('estreno: el plan debe estar bajo .reparto/planes/ y ser .md')}
    if ((await realpath(ruta)) !== ruta) {throw new Error('estreno: no se permiten symlinks')}
    const contenido = await Bun.file(ruta).text()
    const ref = { plan: await realpath(ruta), hash: createHash('sha256').update(contenido).digest('hex') }
    const vacia = (await ctx.session.context({ sessionID: input.sessionID })).length === 0
    const reserva = vacia ? input.sessionID : `reserva:${crypto.randomUUID()}`
    const resultado = registrarEstreno(db(), ref, contenido, modificador === 'con-objeciones', reserva)

    if (!resultado.nueva) {
      let activa = resultado.activa

      for (let i = 0; activa?.startsWith('reserva:') && i < 50; i++) {
        await Bun.sleep(100)
        activa = (
          db()
            .query('SELECT sesion FROM sesiones_regidor WHERE plan = $plan AND hash = $hash ORDER BY rowid DESC LIMIT 1')
            .get(ref) as { sesion: string } | null
        )?.sesion
      }

      if (!activa || activa.startsWith('reserva:')) {throw new Error('estreno: reserva del regidor aún pendiente; reintenta')}
      await ctx.session.prompt({
        sessionID: input.sessionID,
        text: `[reparto] el regidor ya está en la sesión ${activa}. Ábrela para continuar.`,
        delivery: 'queue',
        metadata: { repartoAviso: true },
      })

      return
    }

    let nueva: Awaited<ReturnType<typeof ctx.session.create>> | undefined

    if (!vacia) {
      try {
        nueva = await ctx.session.create({
          title: `regidor · ${nombre.split('/').at(-1)?.replace(/\.md$/, '')}`,
          agent: 'regidor',
          location: { directory: sesion.location.directory },
        })
      } catch (error) {
        write(db(), 'liberar reserva fallida', () =>
          db().query('DELETE FROM sesiones_regidor WHERE sesion = $reserva').run({ reserva }),
        )
        throw error
      }

      const sesionNueva = nueva.id

      if (
        !write(db(), 'ligar reserva al regidor', () =>
          db()
            .query('UPDATE sesiones_regidor SET sesion = $sesion WHERE sesion = $reserva')
            .run({ sesion: sesionNueva, reserva }),
        )
      )
        {throw new Error('estreno: no se pudo ligar la sesión al plan')}
    }

    const { estreno: registro, items } = resultado
    const texto = `Plan estrenado: ${nombre}\nHash: ${ref.hash}\nTipo: ${registro.tipo}${registro.tipo === 'con_objeciones' ? `\nObjeciones abiertas: ${registro.objeciones}` : ''}\n\n${contenido}\n\nPendientes del plan:\n${formatear(items)}\n\nContinúa desde la primera tarea sin terminar. Delega cada cambio y verifica cada tarea.`
    const sesionRegidor = nueva?.id ?? input.sessionID

    try {
      if (!nueva) {await ctx.session.switchAgent({ sessionID: input.sessionID, agent: 'regidor' })}
      await ctx.session.prompt({ sessionID: sesionRegidor, text: texto, delivery: 'queue', metadata: { repartoInicio: true } })
    } catch (error) {
      write(db(), 'liberar reserva fallida', () =>
        db()
          .query('DELETE FROM sesiones_regidor WHERE sesion = $sesion AND plan = $plan AND hash = $hash')
          .run({ sesion: sesionRegidor, ...ref }),
      )
      throw error
    }

    if (nueva)
      {await ctx.session.prompt({
        sessionID: input.sessionID,
        text: `[reparto] estreno ${nombre} (${registro.tipo}). Abre en chats «${nueva.title}» (${nueva.id}) para seguir con el regidor.`,
        delivery: 'queue',
        metadata: { repartoAviso: true },
      })}
  }
}
