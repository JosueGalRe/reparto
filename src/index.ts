import { Plugin } from "@opencode/plugin";
import { configPath, loadConfig } from "./config.ts";
import { log } from "./log.ts";

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
      log.info("activo", { location: ctx.location.directory, config: path, version: ctx.app.version });
    } catch (error) {
      log.error("inactivo: setup falló", { location: ctx.location.directory, error: String(error) });
    }
  },
});
