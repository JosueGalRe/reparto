import { Agent, Plugin } from '@opencode/plugin'

import { publicar, validar } from './actores.ts'
import { bajasVigentes } from './bajas.ts'
import { readCatalog } from './catalog.ts'
import { configPath, loadConfig } from './config.ts'
import { db, ensureSchema } from './db.ts'
import { ensayo, revisores } from './ensayo.ts'
import { registrarHooks } from './hooks.ts'
import { log } from './log.ts'
import { registrarTools } from './tools.ts'

// Id de esta copia del módulo: en 2.0.18 cada location importa la suya (sondas.md, S15).
const modulo = crypto.randomUUID().slice(0, 8)

export default Plugin.define({
  id: 'reparto',
  // Setup nunca lanza: un plugin `failed` no deja ni el aviso en el log (S2)
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

      // Los agentes viven en la config de V2 (ADR 0014), que no tiene `name`: acá solo van los nombres visibles.
      await ctx.agent.transform((editor) => {
        editor.update('build', (agent) => {
          agent.name = Agent.Name.make('Solista')
        })
        editor.update('plan', (agent) => {
          agent.name = Agent.Name.make('Dramaturgo')
        })
      })
      await registrarHooks(ctx, config)
      await registrarTools(ctx, ensayo(ctx, revisores(ctx)))
    } catch (error) {
      log.error('inactivo: setup falló', { location: ctx.location.directory, error: String(error) })
    }
  },
})
