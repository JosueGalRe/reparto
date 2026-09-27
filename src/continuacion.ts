import { db, write } from './db.ts'
import { hijosNativos } from './encargos.ts'
import { clavePlan, planDeSesion, type ReferenciaPlan } from './estreno.ts'
import { log } from './log.ts'
import { type Item, leerPendientes } from './pendientes.ts'

import type { Plugin } from '@opencode/plugin'
import type { Database } from 'bun:sqlite'

interface Estado {
  readonly firma: string | null
  readonly intentos: number
  readonly interrumpido: number
  readonly detenido: number
}
export interface Decision {
  readonly tipo: 'terminado' | 'esperar' | 'interrumpido' | 'continuar' | 'detener'
  readonly intentos?: number
}

export function decidirContinuacion(items: readonly Item[], background: number, estado: Estado): Decision {
  const pendientes = items.filter((item) => item.estado !== 'hecho')

  if (!pendientes.length) {
    return { tipo: 'terminado' }
  }

  if (estado.interrumpido || estado.detenido) {
    return { tipo: 'interrumpido' }
  }

  if (background) {
    return { tipo: 'esperar' }
  }

  const firma = JSON.stringify(items)
  // Ponytail: two successive auto-prompts without any pending-list change stop the loop; Bryan's next message resets it.
  const intentos = estado.firma === firma ? estado.intentos : 0

  return intentos >= 2 ? { tipo: 'detener' } : { tipo: 'continuar', intentos: intentos + 1 }
}

export function decisionGuardada(
  database: Database,
  sesion: string,
  ref: ReferenciaPlan,
  eventId: string,
  background = 0,
): { decision: Decision; items: Item[] } | undefined {
  const clave = clavePlan(ref)

  return write(database, 'continuación del regidor', () => {
    if (
      database.query('INSERT OR IGNORE INTO continuacion_eventos (event_id) VALUES ($eventId)').run({ eventId }).changes !== 1
    ) {
      return undefined
    }

    database.query('INSERT OR IGNORE INTO continuaciones (sesion, clave) VALUES ($sesion, $clave)').run({ sesion, clave })
    const estado = database
      .query('SELECT firma, intentos, interrumpido, detenido FROM continuaciones WHERE sesion = $sesion')
      .get({ sesion }) as Estado
    const items = leerPendientes(database, clave)
    const decision = decidirContinuacion(items, background, estado)

    if (decision.tipo === 'continuar') {
      database
        .query('UPDATE continuaciones SET firma = $firma, intentos = $intentos WHERE sesion = $sesion')
        .run({ sesion, firma: JSON.stringify(items), intentos: decision.intentos ?? 0 })
    }

    if (decision.tipo === 'detener') {
      database.query('UPDATE continuaciones SET detenido = 1 WHERE sesion = $sesion').run({ sesion })
    }

    return { decision, items }
  })
}

export function continuacion(ctx: Plugin.Context) {
  async function prompt(input: { sessionID: string; metadata?: Record<string, unknown> }) {
    if (input.metadata?.repartoAviso || input.metadata?.repartoContinuacion || input.metadata?.repartoInicio) {
      return
    }

    const sesion = await ctx.session.get({ sessionID: input.sessionID })

    if (sesion.agent !== 'regidor' || !planDeSesion(db(), input.sessionID)) {
      return
    }

    write(db(), 'regidor retomado por Bryan', () =>
      db()
        .query('UPDATE continuaciones SET interrumpido = 0, detenido = 0, intentos = 0, firma = NULL WHERE sesion = $sesion')
        .run({ sesion: input.sessionID }),
    )
  }

  async function evento(ev: { id: string; type: string; data?: unknown }) {
    if (ev.type !== 'session.execution.succeeded' && ev.type !== 'session.execution.interrupted') {
      return
    }

    const { sessionID } = (ev.data as { sessionID?: string } | undefined) ?? {}

    if (!sessionID) {
      return
    }

    try {
      const sesion = await ctx.session.get({ sessionID })
      const ref = planDeSesion(db(), sessionID)

      if (sesion.agent !== 'regidor' || !ref) {
        return
      }

      if (ev.type === 'session.execution.interrupted') {
        write(db(), 'regidor interrumpido', () => {
          db()
            .query('INSERT OR IGNORE INTO continuaciones (sesion, clave) VALUES ($sesion, $clave)')
            .run({ sesion: sessionID, clave: clavePlan(ref) })
          db().query('UPDATE continuaciones SET interrumpido = 1 WHERE sesion = $sesion').run({ sesion: sessionID })
        })

        return
      }

      const background = [...hijosNativos().values()].filter((hija) => hija.padre === sessionID).length
      const actual = decisionGuardada(db(), sessionID, ref, ev.id, background)

      if (!actual) {
        return
      }

      const { decision, items } = actual

      if (decision.tipo !== 'continuar' && decision.tipo !== 'detener') {
        return
      }

      const pendientes = items.filter((item) => item.estado !== 'hecho').map((item) => item.texto.split(':')[0])
      const text =
        decision.tipo === 'detener'
          ? `[reparto] el regidor no avanzó tras 2 continuaciones; Bryan debe decidir. Quedan ${pendientes.length} tareas (${pendientes.join(', ')}).`
          : `[reparto] continúa el plan: quedan ${pendientes.length} tareas (${pendientes.join(', ')}).`

      await ctx.session.prompt({ sessionID, text, delivery: 'queue', metadata: { repartoContinuacion: true } })
    } catch (error) {
      log.error('continuación del regidor falló', { sessionID, error: String(error) })
    }
  }

  return { prompt, evento }
}
