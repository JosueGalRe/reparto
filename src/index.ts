import { Plugin } from '@opencode/plugin'

import { agentesPropios, esActor, etiqueta, modelRef, publicar, resolver, validar } from './actores.ts'
import { conShellDeLectura, motivoNegado, papeles, registrar, ruteo } from './agentes.ts'
import { bajasVigentes, deBaja, suplencias } from './bajas.ts'
import { readCatalog } from './catalog.ts'
import { configPath, loadConfig } from './config.ts'
import { continuacion } from './continuacion.ts'
import { db, ensureSchema } from './db.ts'
import { encargos } from './encargos.ts'
import { ensayo } from './ensayo.ts'
import { clavePlan, estreno, planDeSesion } from './estreno.ts'
import { log } from './log.ts'
import { escribirPendientes, estados, formatear, leerPendientes, parsearItems } from './pendientes.ts'
import { hijasNativas, proceso } from './process.ts'

import type { PermissionEvaluation } from '@opencode/plugin/promise/permission'

// Id de esta copia del módulo: en 2.0.18 cada location importa la suya (sondas.md, S15).
const modulo = crypto.randomUUID().slice(0, 8)
const debug = !!process.env.REPARTO_DEBUG

/** Primarios cuyo actor impone reparto en el hook `prompt`: el servidor no aplica `agent.model` (S10). */
const primarios = new Set(['director', 'dramaturgo', 'regidor', 'build'])
const hijos = new Set(['utilero', 'archivista', 'oracle', 'critico', ...papeles])

export async function imponerHija(ctx: Plugin.Context, sessionID: string) {
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

export function evaluarSubagent(input: PermissionEvaluation) {
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

export default Plugin.define({
  id: 'reparto',
  // Setup nunca lanza: un plugin `failed` no deja ni el aviso al director (S2)
  setup: async (ctx) => {
    try {
      const path = configPath(ctx.options)
      const loaded = await loadConfig(path)

      if ('error' in loaded) {
        log.error('inactivo: config inválida', { location: ctx.location.directory, error: loaded.error })

        return
      }

      const { config } = loaded

      ensureSchema(db())
      log.info('activo', { location: ctx.location.directory, config: path, version: ctx.app.version, modulo })
      const bajas = bajasVigentes(db())

      if (bajas.length) {
        log.info('bajas vigentes', { location: ctx.location.directory, bajas })
      }

      // El transform ve el catálogo completo, sin importar el orden de `plugins`, y se repite en cada
      // Model.updated (S9). El callback es sincrónico: guarda el catálogo y la validación corre fuera.
      await ctx.model.transform((editor) => {
        const catalog = readCatalog(editor)

        setTimeout(async () => {
          try {
            const listado = await ctx.agent.list()
            const agentes = listado.data.map((agent) => String(agent.id))

            publicar(validar(config, catalog, agentes))
          } catch (error) {
            log.error('validación de actores falló', { error: String(error) })
          }
        }, 0)
      })

      await ctx.agent.transform(registrar)
      await ctx.command.transform((editor) =>
        editor.add({
          name: 'estreno',
          description: 'Estrena un plan aprobado: /estreno .reparto/planes/<plan>.md [con-objeciones]',
          execute: estreno(ctx),
        }),
      )
      const continuar = continuacion(ctx)

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

          const previo = (await ctx.storage.get(clave)) as { actor?: string } | undefined

          if (previo?.actor === etiqueta(actor)) {
            return
          }

          await ctx.session.switchModel({ sessionID: input.sessionID, model: modelRef(actor) })
          await ctx.storage.set(clave, { actor: etiqueta(actor) })
          log.info('actor impuesto', {
            sessionID: input.sessionID,
            agente,
            actor: etiqueta(actor),
            motivo: previo ? `cambió el actor resuelto (antes ${previo.actor})` : 'primer turno',
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

      const gestor = encargos(ctx)
      const ensayar = ensayo(ctx, gestor)

      // Codemode: false, o el modelo solo las alcanza desde `execute` (S11)
      await ctx.tool.transform((editor) => {
        editor.add({
          name: 'bitacora',
          description:
            'Show what an encargo did: its tool calls with their key argument, and its final message. `detalle: "completo"` adds the (trimmed) results. Works after the child was compacted.',
          input: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Child session id of the encargo.' },
              detalle: { type: 'string', enum: ['completo'] },
            },
            required: ['id'],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: (input) => gestor.bitacora(input),
        })
        editor.add({
          name: 'ensayar',
          description:
            'Run one synchronous round of the ensayo general on a plan under .reparto/planes/. Fresh parallel critico and oracle encargos; returns verdicts and the acta.',
          input: {
            type: 'object',
            properties: { plan: { type: 'string', description: 'Relative plan path under .reparto/planes/.' } },
            required: ['plan'],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: (input, tool) => {
            if (!input || typeof input !== 'object' || !('plan' in input) || typeof input.plan !== 'string') {
              throw new Error('ensayar: falta plan')
            }

            return ensayar({ plan: input.plan }, tool)
          },
        })
        editor.add({
          name: 'interrumpir',
          description:
            'Interrupt one of your own open encargos (for example a stale one). Only encargos this session launched can be interrupted. ' +
            'Native children receive their completion through the native subagent tool.',
          input: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Child session id of the encargo.' } },
            required: ['id'],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: (input, tool) => gestor.interrumpir(input, tool),
        })
        editor.add({
          name: 'pendientes',
          description:
            "Read or rewrite this session's work list. Without `items` it returns the list; with `items` it replaces the whole list and returns it. " +
            'Survives compaction. Keep one item `en_curso` at a time and mark items `hecho` as soon as they are done.',
          input: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { texto: { type: 'string' }, estado: { type: 'string', enum: [...estados] } },
                  required: ['texto'],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (input, tool) => {
            const items = parsearItems(input)
            const sesion = await ctx.session.get({ sessionID: tool.sessionID })
            const ref = sesion.agent === 'regidor' ? planDeSesion(db(), tool.sessionID) : undefined
            const clave = ref ? clavePlan(ref) : tool.sessionID

            if (items && ref) {
              const original = leerPendientes(db(), clave)

              if (items.length !== original.length || items.some((item, indice) => item.texto !== original[indice]?.texto)) {
                throw new Error('pendientes: las tareas estrenadas no se pueden agregar, borrar ni renombrar')
              }
            }

            if (items && !escribirPendientes(db(), clave, items)) {
              throw new Error('pendientes: no se pudo guardar (SQLite); ver el log de reparto')
            }

            return { content: formatear(items ?? leerPendientes(db(), clave)) }
          },
        })
      })
      // Session.context pierde las tool calls al compactar (S14): la bitácora se llena acá
      await ctx.tool.hook('execute.after', (llamada) =>
        gestor.registrarLlamada(
          llamada.status === 'completed' ? { ...llamada, result: llamada.result } : { ...llamada, error: llamada.error },
        ),
      )

      const stop = new AbortController()

      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: stop.signal })) {
            await gestor.evento(ev)
            void continuar.evento(ev)
          }
        } catch (error) {
          if (!stop.signal.aborted) {
            log.error('suscripción a eventos terminó', { location: ctx.location.directory, error: String(error) })
          }
        }
      })()

      const vigilante = setInterval(() => void gestor.vigilar(), 60_000)

      return () => {
        stop.abort()
        clearInterval(vigilante)
      }
    } catch (error) {
      log.error('inactivo: setup falló', { location: ctx.location.directory, error: String(error) })
    }
  },
})
