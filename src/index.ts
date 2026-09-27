import { Plugin } from '@opencode/plugin'

import { publicar, validar } from './actores.ts'
import { registrar } from './agentes.ts'
import { bajasVigentes } from './bajas.ts'
import { readCatalog } from './catalog.ts'
import { configPath, loadConfig } from './config.ts'
import { continuacion } from './continuacion.ts'
import { db, ensureSchema } from './db.ts'
import { encargos } from './encargos.ts'
import { ensayo } from './ensayo.ts'
import { estreno } from './estreno.ts'
import { registrarHooks } from './hooks.ts'
import { log } from './log.ts'
import { registrarTools } from './tools.ts'

// Id de esta copia del módulo: en 2.0.18 cada location importa la suya (sondas.md, S15).
const modulo = crypto.randomUUID().slice(0, 8)

export function suscribir(
  ctx: Pick<Plugin.Context, 'event'> & { readonly location: { readonly directory: string } },
  gestor: Pick<ReturnType<typeof encargos>, 'evento' | 'vigilar'>,
  continuar: Pick<ReturnType<typeof continuacion>, 'evento'>,
) {
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
      const gestor = encargos(ctx)
      const ensayar = ensayo(ctx, gestor)

      await registrarHooks(ctx, config, continuar, gestor)
      await registrarTools(ctx, gestor, ensayar)

      return suscribir(ctx, gestor, continuar)
    } catch (error) {
      log.error('inactivo: setup falló', { location: ctx.location.directory, error: String(error) })
    }
  },
})
