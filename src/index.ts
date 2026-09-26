import { Plugin } from "@opencode/plugin";
import { etiqueta, modelRef, publicar, resolver, validar } from "./actores.ts";
import { conShellDeLectura, motivoNegado, registrar, ruteo } from "./agentes.ts";
import { bajasVigentes } from "./bajas.ts";
import { readCatalog } from "./catalog.ts";
import { configPath, loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";
import { proceso } from "./process.ts";

// Id de esta copia del módulo: en 2.0.18 cada location importa la suya (sondas.md, S15).
const modulo = crypto.randomUUID().slice(0, 8);
const debug = !!process.env.REPARTO_DEBUG;

/** Primarios cuyo actor impone reparto en el hook `prompt`: el servidor no aplica `agent.model` (S10). */
const primarios = new Set(["director", "build"]);

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

      await ctx.agent.transform(registrar);

      // Primer turno de cada sesión primaria: sale con el actor resuelto. Después se respeta el modelo que tenga
      // la sesión, así que un cambio a mano no se revierte. 1.8 agrega el cambio por inicio o fin de una baja.
      await ctx.session.hook("prompt", async (input) => {
        try {
          const sesion = await ctx.session.get({ sessionID: input.sessionID });
          const agente = sesion.agent ?? "director";
          if (!primarios.has(agente)) return;
          const clave = `impuesto/${input.sessionID}/${agente}`;
          if (await ctx.storage.get(clave)) return;
          const actor = proceso.validacion && resolver(proceso.validacion, agente);
          if (!actor) return log.warn("sin actor para imponer", { sessionID: input.sessionID, agente });
          await ctx.session.switchModel({ sessionID: input.sessionID, model: modelRef(actor) });
          await ctx.storage.set(clave, { actor: etiqueta(actor) });
          log.info("actor impuesto", { sessionID: input.sessionID, agente, actor: etiqueta(actor), antes: sesion.model ?? null });
        } catch (error) {
          log.error("hook prompt falló", { sessionID: input.sessionID, error: String(error) });
        }
      });

      await ctx.session.hook("context", (input) => {
        if (debug) log.info("debug: tools de la request", { sessionID: input.sessionID, agent: input.agent, tools: Object.keys(input.tools).sort() });
        if (input.agent === "director") input.system.push({ type: "text", text: ruteo(proceso.validacion) });
      });

      // Solo corre cuando las reglas ya dieron allow (S7): sirve para negar, no para permitir.
      await ctx.permission.hook("evaluate", (input) => {
        if (input.action !== "shell" || input.effect !== "allow" || !conShellDeLectura.has(String(input.agent))) return;
        for (const tramo of input.resources) {
          const motivo = motivoNegado(tramo);
          if (!motivo) continue;
          input.effect = "deny";
          input.message = `reparto: ${motivo} negada en el shell de solo lectura. Para cambiar archivos, delega.`;
          log.info("shell negado", { sessionID: input.sessionID, agent: input.agent, tramo, motivo });
          return;
        }
      });

      if (debug)
        await ctx.session.hook("model.request", (input) => {
          log.info("debug: model.request", { sessionID: input.sessionID, agent: input.agent, kind: input.kind, model: input.model });
        });
    } catch (error) {
      log.error("inactivo: setup falló", { location: ctx.location.directory, error: String(error) });
    }
  },
});
