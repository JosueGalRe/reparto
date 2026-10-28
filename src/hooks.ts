import { type Plugin, Skill } from '@opencode/plugin'

import { esActor, etiqueta, modelRef, resolver, validacionLista } from './actores.ts'
import { bajasVigentes, deBaja, suplencias } from './bajas.ts'
import { db } from './db.ts'
import { elegirRevisores, ensayoTerminado } from './ensayo.ts'
import { log } from './log.ts'
import { proceso } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { Config } from './config.ts'
import type { ContextoHija, ContextoPrimaria, EvaluacionSubagent, LlamadaTool } from './hooks-types.ts'
import type { SessionPrompt } from '@opencode/plugin/promise/session'

const debug = !!process.env.REPARTO_DEBUG

/** ¿Tiene reparto en la config? `hasOwn`: un agente llamado `constructor` no hereda el prototipo. */
const conReparto = (config: Config, agente: string) => Object.hasOwn(config.agentes ?? {}, agente)

const pedidos = (): NonNullable<typeof proceso.pedidos> => (proceso.pedidos ??= new Map())

/**
 * `subagent` con `model` explícito a un agente con reparto: se anota para que la hija lo conserve, como la primaria
 * conserva el que eligió el cliente. V2 crea la hija con ese modelo pero no deja rastro de que fue pedido.
 */
export function anotarPedido(llamada: LlamadaTool, config: Config) {
  const entrada = llamada.input

  if (llamada.tool !== 'subagent' || !esRegistro(entrada) || typeof entrada.agent !== 'string') {
    return
  }

  // V2 borra un `model: ""` en su propio execute.before, que puede correr después de este.
  if (typeof entrada.model !== 'string' || !entrada.model || !conReparto(config, entrada.agent)) {
    return
  }

  const [model = '', variant] = entrada.model.split('#', 2)

  pedidos().set(llamada.id, {
    padre: llamada.sessionID,
    agente: entrada.agent,
    actor: variant ? { model, variant } : { model },
  })
}

// Ponytail: dos `subagent` en paralelo al mismo agente, uno pedido y otro heredando ese mismo modelo, pueden cruzarse.
function tomarPedido(padre: string, agente: string, modelo: Parameters<typeof esActor>[1]) {
  for (const [id, pedido] of pedidos()) {
    if (pedido.padre === padre && pedido.agente === agente && esActor(pedido.actor, modelo)) {
      pedidos().delete(id)

      return true
    }
  }

  return false
}

/**
 * Hija nativa de un agente con reparto: corre con su actor, nunca con el modelo heredado del padre. Si el `subagent`
 * pidió un modelo, lo conserva en todos sus turnos; una falla de ese modelo cae igual en los suplentes del agente.
 */
export async function imponerHija(ctx: ContextoHija, config: Config, sessionID: string) {
  const sesion = await ctx.session.get({ sessionID })
  const agente = sesion.agent ?? ''

  if (!sesion.parentID || !conReparto(config, agente)) {
    return false
  }

  const clave = `elegido/${sessionID}`

  if (sesion.model && tomarPedido(sesion.parentID, agente, sesion.model)) {
    await ctx.storage.set(clave, true)
    log.info('modelo pedido respetado', { sessionID, agente, modelo: sesion.model })

    return true
  }

  if ((await ctx.storage.get(clave)) !== undefined) {
    return true
  }

  const validacion = await validacionLista()
  const actor = validacion && resolver(validacion, agente, deBaja(bajasVigentes(db())))

  if (!actor) {
    throw new Error(`hija ${sessionID} (${agente}) sin actor disponible`)
  }

  if (!sesion.model || !esActor(actor, sesion.model)) {
    await ctx.session.switchModel({ sessionID, model: modelRef(actor) })
    log.info('actor impuesto', { sessionID, agente, actor: etiqueta(actor), antes: sesion.model ?? null })
  }

  return true
}

/**
 * Sesión primaria con reparto. El modelo que el cliente eligió para el primer mensaje (en `session.create` o con
 * `switchModel`) se respeta. Si llega sin modelo, se impone el actor resuelto, y de ahí en más también en el primer
 * turno después de que empiece o termine una baja que lo cambie. Lo impuesto va en ctx.storage para que una recarga o
 * un reinicio no lo tomen como primer turno.
 */
export async function imponerPrimaria(ctx: ContextoPrimaria, config: Config, sessionID: string) {
  const sesion = await ctx.session.get({ sessionID })
  const agente = sesion.agent ?? 'build'

  // Hijas sin reparto heredan el modelo del padre; los revisores del ensayo ya nacen con su actor.
  if (sesion.parentID || sesion.metadata?.padre || !conReparto(config, agente)) {
    return
  }

  const clave = `impuesto/${sessionID}/${agente}`
  const previo = await ctx.storage.get(clave)

  if (previo === undefined && sesion.model) {
    return
  }

  const validacion = await validacionLista()
  const actor = validacion && resolver(validacion, agente, deBaja(bajasVigentes(db())))

  if (!actor) {
    return log.warn('sin actor para imponer', { sessionID, agente })
  }

  const actorPrevio = esRegistro(previo) ? previo.actor : undefined

  if (typeof actorPrevio === 'string' && actorPrevio === etiqueta(actor)) {
    return
  }

  await ctx.session.switchModel({ sessionID, model: modelRef(actor) })
  await ctx.storage.set(clave, { actor: etiqueta(actor) })
  log.info('actor impuesto', {
    sessionID,
    agente,
    actor: etiqueta(actor),
    motivo: previo ? `cambió el actor resuelto (antes ${actorPrevio})` : 'primer turno sin modelo',
    antes: sesion.model ?? null,
  })
}

export function evaluarSubagent(input: EvaluacionSubagent, config: Config) {
  const destino = input.resources[0]

  if (input.action !== 'subagent' || input.effect !== 'allow' || !destino || !conReparto(config, destino)) {
    return
  }

  // Con un modelo pedido, la hija no depende de los actores del agente.
  if ([...pedidos().values()].some((pedido) => pedido.padre === input.sessionID && pedido.agente === destino)) {
    return
  }

  const bajas = bajasVigentes(db())

  if (proceso.validacion && resolver(proceso.validacion, destino, deBaja(bajas))) {
    return
  }

  input.effect = 'deny'
  input.message = `reparto: ${destino} sin actor disponible${proceso.validacion ? '' : ' (validación pendiente)'}. Bajas: ${bajas.map((baja) => `${baja.id} hasta ${new Date(baja.hasta).toISOString()}`).join(', ') || 'ninguna'}`
}

/**
 * Plannotator recibe el plan con `submit_plan`: sin un ensayo terminado en la sesión, se rechaza (ADR 0014).
 * Devuelve el motivo del rechazo, o undefined si la llamada pasa.
 */
export function envioSinEnsayo(tool: string, sessionID: string): string | undefined {
  if (tool !== 'submit_plan') {
    return
  }

  try {
    if (ensayoTerminado(db(), sessionID)) {
      return
    }
  } catch (error) {
    log.error('gate de submit_plan: ensayo ilegible', { sessionID, error: String(error) })
  }

  // Sin revisores disponibles no hay ensayo posible: el plan pasa y la revisión queda solo en manos de Bryan.
  if (!proceso.validacion || !elegirRevisores(proceso.validacion, undefined, deBaja(bajasVigentes(db())))) {
    log.warn('submit_plan sin ensayo: no hay revisores disponibles', { sessionID })

    return
  }

  // Ponytail: no compara el texto enviado con el ensayado; basta con que la sesión tenga un ensayo terminado.
  return 'reparto: run `ensayar` with the full plan until a round closes (or round 5 is reached) before calling `submit_plan`.'
}

export function adjuntarSkill(prompt: SessionPrompt['prompt'], disponibles: readonly { readonly id: string }[]) {
  const texto = prompt.text.trimStart()

  if (!texto.startsWith('/')) {
    return
  }

  const id = texto.slice(1).split(/\s/, 1)[0]
  const skill = disponibles.find((entry) => entry.id === id)

  if (!skill || prompt.skills?.some((entry) => entry.id === skill.id)) {
    return
  }

  prompt.skills ??= []
  prompt.skills.push({ id: Skill.ID.make(skill.id) })
}

export async function registrarHooks(ctx: Plugin.Context, config: Config) {
  await ctx.session.hook('prompt', async (input) => {
    try {
      if (input.prompt.text.trimStart().startsWith('/')) {
        const disponibles = await ctx.skill.list()

        adjuntarSkill(input.prompt, disponibles.data)
      }
    } catch (error) {
      log.error('hook prompt skill falló', { sessionID: input.sessionID, error: String(error) })
    }
  })

  await ctx.session.hook('prompt', async (input) => {
    try {
      if (!(await imponerHija(ctx, config, input.sessionID))) {
        await imponerPrimaria(ctx, config, input.sessionID)
      }
    } catch (error) {
      log.error('hook prompt falló', { sessionID: input.sessionID, error: String(error) })
      throw error
    }
  })

  // `ensayar` solo le sirve al Compositor: el resto no la ve.
  await ctx.session.hook('context', (input) => {
    if (input.agent !== 'plan') {
      delete input.tools.ensayar
    }
  })

  // `execute.before` corre antes de que el `subagent` cree la hija, y `execute.after` cuando ya pidió su primer prompt.
  await ctx.tool.hook('execute.before', (llamada) => anotarPedido(llamada, config))
  await ctx.tool.hook('execute.after', (llamada) => void pedidos().delete(llamada.id))
  // Solo corre cuando las reglas ya dieron allow (S7): sirve para negar, no para permitir.
  await ctx.permission.hook('evaluate', (input) => evaluarSubagent(input, config))
  // `submit_plan` es tool de plugin y no pide permiso, así que `evaluate` no la ve: el gate va antes de ejecutarla.
  await ctx.tool.hook('execute.before', (llamada) => {
    const motivo = envioSinEnsayo(llamada.tool, llamada.sessionID)

    if (motivo) {
      log.info('submit_plan rechazado', { sessionID: llamada.sessionID })
      throw new Error(motivo)
    }
  })

  if (debug) {
    await ctx.session.hook('context', (input) => {
      log.info('debug: tools de la request', {
        sessionID: input.sessionID,
        agent: input.agent,
        tools: Object.keys(input.tools).toSorted(),
      })
    })
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
}
