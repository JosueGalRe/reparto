import type { Catalog } from "./catalog.ts";
import type { Actor, Config } from "./config.ts";
import { log } from "./log.ts";
import { proceso } from "./process.ts";

/** Agentes que registra reparto; el resto de `agentes` tiene que existir en V2 (nativos como `build`). */
export const agentesPropios = new Set(["director", "utilero", "archivista", "oracle", "dramaturgo", "critico", "regidor"]);

export interface Exclusion {
  nombre: string;
  tipo: "agente" | "papel";
  actor: string;
  motivo: string;
}

export interface Validacion {
  /** Actores válidos por agente o papel, en orden: titular y después suplentes. */
  actores: Map<string, Actor[]>;
  exclusiones: Exclusion[];
  desactivados: string[];
  /** Agentes de la config que no son de reparto y no existen en V2. */
  desconocidos: string[];
}

export const etiqueta = (actor: Actor) => (actor.variant ? `${actor.model}#${actor.variant}` : actor.model);

export function motivoInvalido(actor: Actor, catalog: Catalog): string | undefined {
  const modelo = catalog.get(actor.model);
  if (!modelo) return "el modelo no está en el catálogo";
  if (!modelo.enabled) return "el modelo está deshabilitado (enabled: false)";
  if (actor.variant !== undefined && !modelo.variants.includes(actor.variant))
    return `el variant "${actor.variant}" no está en el catálogo (${modelo.variants.length ? `hay: ${modelo.variants.join(", ")}` : "el modelo no tiene variants"})`;
}

export function validar(config: Config, catalog: Catalog, agentesV2?: readonly string[]): Validacion {
  const resultado: Validacion = { actores: new Map(), exclusiones: [], desactivados: [], desconocidos: [] };
  for (const [tipo, repartos] of [["agente", config.agentes], ["papel", config.papeles]] as const) {
    for (const [nombre, reparto] of Object.entries(repartos ?? {})) {
      if (tipo === "agente" && agentesV2 && !agentesPropios.has(nombre) && !agentesV2.includes(nombre))
        resultado.desconocidos.push(nombre);
      const validos: Actor[] = [];
      for (const actor of [reparto.titular, ...(reparto.suplentes ?? [])]) {
        const motivo = motivoInvalido(actor, catalog);
        if (motivo) resultado.exclusiones.push({ nombre, tipo, actor: etiqueta(actor), motivo });
        else validos.push(actor);
      }
      if (validos.length) resultado.actores.set(nombre, validos);
      else resultado.desactivados.push(nombre);
    }
  }
  return resultado;
}

/** Primer actor válido. 1.8 agrega las bajas. */
export const resolver = (validacion: Validacion, nombre: string): Actor | undefined => validacion.actores.get(nombre)?.[0];

// Todas las instancias del proceso (una por location) validan la misma config contra el mismo catálogo.
export function publicar(nueva: Validacion) {
  proceso.validacion = nueva;
  const firma = JSON.stringify([nueva.exclusiones, nueva.desactivados, nueva.desconocidos, [...nueva.actores]]);
  // V2 repite el transform en cada model.updated (~5 min, S9) y en cada location: solo se loguea lo que cambió
  if (firma === proceso.firma) return;
  proceso.firma = firma;
  for (const exclusion of nueva.exclusiones) log.warn("actor excluido", { ...exclusion });
  for (const nombre of nueva.desactivados) log.warn("desactivado: sin actores válidos", { nombre });
  for (const nombre of nueva.desconocidos) log.warn("agente inexistente en V2", { nombre });
  log.info("actores validados", {
    titulares: Object.fromEntries([...nueva.actores].map(([nombre, actores]) => [nombre, etiqueta(actores[0]!)])),
  });
}
