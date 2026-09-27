import { agentesPropios, esActor, etiqueta, modelRef, resolver } from './actores.ts'
import { conShellDeLectura, motivoNegado, papeles, ruteo } from './agentes.ts'
import { bajasVigentes, deBaja, suplencias } from './bajas.ts'
import { db } from './db.ts'
import { planDeSesion } from './estreno.ts'
import { log } from './log.ts'
import { hijasNativas, proceso } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { Config } from './config.ts'
import type { continuacion } from './continuacion.ts'
import type { encargos } from './encargos.ts'
import type { ContextoHija, EvaluacionSubagent } from './hooks-types.ts'
import type { Plugin } from '@opencode/plugin'

const debug = !!process.env.REPARTO_DEBUG

/** Primarios cuyo actor impone reparto en el hook `prompt`: el servidor no aplica `agent.model` (S10). */
const primarios = new Set(['director', 'dramaturgo', 'regidor', 'build'])
const hijos = new Set(['utilero', 'archivista', 'oracle', 'critico', ...papeles])

export async function imponerHija(ctx: ContextoHija, sessionID: string) {
  const sesion = await ctx.session.get({ sessionID })

  if (!sesion.parentID || !hijos.has(sesion.agent ?? '')) {
    return false
  }

  const desde = Date.now()
  const agente = sesion.agent ?? ''
  const actor = proceso.validacion && resolver(proceso.validacion, agente, deBaja(bajasVigentes(db())))

  if (!actor) {
    throw new Error(`hija ${sessionID} (${agente}) sin actor disponible`)
  }

  if (!sesion.model || !esActor(actor, sesion.model)) {
    await ctx.session.switchModel({ sessionID, model: modelRef(actor) })
    log.info('actor impuesto', { sessionID, agente, actor: etiqueta(actor), antes: sesion.model ?? null })
  }

  hijasNativas().set(sessionID, { padre: sesion.parentID, desde, actividad: Date.now(), avisado: false, permisos: new Set() })

  return true
}

export function evaluarSubagent(input: EvaluacionSubagent) {
  if (input.action !== 'subagent' || input.effect !== 'allow') {
    return
  }

  if (input.agent === 'regidor' && !planDeSesion(db(), input.sessionID)) {
    input.effect = 'deny'
    input.message = 'regidor sin plan estrenado: usa /estreno <plan>'

    return
  }

  const destino = input.resources[0]

  if (!destino || (!hijos.has(destino) && !agentesPropios.has(destino))) {
    return
  }

  const bajas = bajasVigentes(db())

  if (proceso.validacion && resolver(proceso.validacion, destino, deBaja(bajas))) {
    return
  }

  input.effect = 'deny'
  input.message = `reparto: ${destino} sin actor disponible${proceso.validacion ? '' : ' (validación pendiente)'}. Bajas: ${bajas.map((baja) => `${baja.id} hasta ${new Date(baja.hasta).toISOString()}`).join(', ') || 'ninguna'}`
}

export async function registrarHooks(
  ctx: Plugin.Context,
  config: Config,
  continuar: ReturnType<typeof continuacion>,
  gestor: Pick<ReturnType<typeof encargos>, 'registrarLlamada'>,
) {
  // Sesiones primarias: el actor resuelto se impone en el primer turno y en el primer turno después de que
  // Empiece o termine una baja que lo cambie. El resto del tiempo se respeta el modelo de la sesión, así que un
  // Cambio a mano no se revierte. Lo impuesto va en ctx.storage para que una recarga o un reinicio no lo tomen
  // Como primer turno.
  await ctx.session.hook('prompt', async (input) => {
    try {
      if (input.metadata?.repartoAviso === true) {
        return
      }

      if (await imponerHija(ctx, input.sessionID)) {
        return
      }

      const sesion = await ctx.session.get({ sessionID: input.sessionID })
      const agente = sesion.agent ?? 'director'

      if (!primarios.has(agente)) {
        return
      }

      const clave = `impuesto/${input.sessionID}/${agente}`
      const actor = proceso.validacion && resolver(proceso.validacion, agente, deBaja(bajasVigentes(db())))

      if (!actor) {
        return log.warn('sin actor para imponer', { sessionID: input.sessionID, agente })
      }

      const previo = await ctx.storage.get(clave)
      const actorPrevio = esRegistro(previo) ? previo.actor : undefined

      if (typeof actorPrevio === 'string' && actorPrevio === etiqueta(actor)) {
        return
      }

      await ctx.session.switchModel({ sessionID: input.sessionID, model: modelRef(actor) })
      await ctx.storage.set(clave, { actor: etiqueta(actor) })
      log.info('actor impuesto', {
        sessionID: input.sessionID,
        agente,
        actor: etiqueta(actor),
        motivo: previo ? `cambió el actor resuelto (antes ${actorPrevio})` : 'primer turno',
        antes: sesion.model ?? null,
      })
    } catch (error) {
      log.error('hook prompt falló', { sessionID: input.sessionID, error: String(error) })
      throw error
    }
  })
  await ctx.session.hook('prompt', (input) => continuar.prompt(input))

  await ctx.session.hook('context', (input) => {
    if (debug) {
      log.info('debug: tools de la request', {
        sessionID: input.sessionID,
        agent: input.agent,
        tools: Object.keys(input.tools).toSorted(),
      })
    }

    if (input.agent === 'director' || input.agent === 'regidor') {
      input.system.push({ type: 'text', text: ruteo(proceso.validacion) })
    }
  })

  // Solo corre cuando las reglas ya dieron allow (S7): sirve para negar, no para permitir.
  await ctx.permission.hook('evaluate', (input) => {
    evaluarSubagent(input)

    if (input.action !== 'shell' || input.effect !== 'allow' || !conShellDeLectura.has(String(input.agent))) {
      return
    }

    for (const tramo of input.resources) {
      const motivo = motivoNegado(tramo)

      if (!motivo) {
        continue
      }

      input.effect = 'deny'
      input.message = `reparto: ${motivo} negada en el shell de solo lectura. Para cambiar archivos, delega.`
      log.info('shell negado', { sessionID: input.sessionID, agent: input.agent, tramo, motivo })

      return
    }
  })

  if (debug) {
    await ctx.session.hook('model.request', (input) => {
      log.info('debug: model.request', {
        sessionID: input.sessionID,
        agent: input.agent,
        kind: input.kind,
        model: input.model,
      })
    })
  }

  const suplente = suplencias(ctx, config)

  // El cuerpo del error corrige la clasificación de V2 y trae el reset (S3). Solo requests `primary`.
  await ctx.session.hook('http.response', async (respuesta) => {
    if (respuesta.kind !== 'primary' || respuesta.response.ok) {
      return
    }

    const cuerpo = await respuesta.response
      .clone()
      .text()
      .catch(() => '')

    suplente.guardar(
      respuesta.sessionID,
      respuesta.kind,
      respuesta.model,
      cuerpo,
      Object.fromEntries(respuesta.response.headers),
    )
  })
  // Openai va por WebSocket: su error llega como un frame (S3). Hook experimental: si cambia, la baja cae en plazoBaja.
  await ctx.session.hook('experimental.ws.receive', (mensaje) => {
    if (mensaje.kind !== 'primary' || !mensaje.frame.includes('"error"')) {
      return
    }

    if (mensaje.frame.startsWith('{"type":"error"')) {
      suplente.guardar(mensaje.sessionID, mensaje.kind, mensaje.model, mensaje.frame, {})
    }
  })
  await ctx.session.hook('retry', async (reintento) => {
    try {
      await suplente.retry(reintento)
    } catch (error) {
      log.error('hook retry falló', { sessionID: reintento.sessionID, error: String(error) })
    }
  })

  // Session.context pierde las tool calls al compactar (S14): la bitácora se llena acá
  await ctx.tool.hook('execute.after', (llamada) =>
    gestor.registrarLlamada(
      llamada.status === 'completed' ? { ...llamada, result: llamada.result } : { ...llamada, error: llamada.error },
    ),
  )
}
