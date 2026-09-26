import { Plugin } from "@opencode/plugin";
import { publicar, validar } from "./actores.ts";
import { bajasVigentes } from "./bajas.ts";
import { readCatalog } from "./catalog.ts";
import { configPath, loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";

// Id de esta copia del módulo: S15 dice que se comparte entre las locations de un proceso.
const modulo = crypto.randomUUID().slice(0, 8);

export default Plugin.define({
  id: "reparto",
  // setup nunca lanza: un plugin `failed` no deja ni el aviso al director (S2)
  setup: async (ctx) => {
    try {
      const path = configPath(ctx.options);
      const loaded = await loadConfig(path);
      if ("error" in loaded) {
        log.error("inactivo: config inválida", { location: ctx.location.directory, error: loaded.error });
        return;
      }
      const { config } = loaded;
      log.info("activo", { location: ctx.location.directory, config: path, version: ctx.app.version, modulo });
      const bajas = bajasVigentes(db());
      if (bajas.length) log.info("bajas vigentes", { location: ctx.location.directory, bajas });

      // El transform ve el catálogo completo, sin importar el orden de `plugins`, y se repite en cada
      // model.updated (S9). El callback es sincrónico: guarda el catálogo y la validación corre fuera.
      await ctx.model.transform((editor) => {
        const catalog = readCatalog(editor);
        setTimeout(async () => {
          try {
            const agentes = (await ctx.agent.list()).data.map((agent) => String(agent.id));
            publicar(validar(config, catalog, agentes));
          } catch (error) {
            log.error("validación de actores falló", { error: String(error) });
          }
        });
      });
    } catch (error) {
      log.error("inactivo: setup falló", { location: ctx.location.directory, error: String(error) });
    }
  },
});
