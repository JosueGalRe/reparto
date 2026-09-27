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

/** `provider/model` → Model.Ref de V2. Un string en su lugar deja al agente mal formado sin error (S10). */
export function modelRef(actor: Actor) {
  const i = actor.model.indexOf("/");
  return { providerID: actor.model.slice(0, i), id: actor.model.slice(i + 1), ...(actor.variant ? { variant: actor.variant } : {}) };
}

/** Primer actor válido que no esté fuera (de baja). */
export const resolver = (validacion: Validacion, nombre: string, fuera: (actor: Actor) => boolean = () => false): Actor | undefined =>
  validacion.actores.get(nombre)?.find((actor) => !fuera(actor));

type Ref = { providerID: string; id: string; variant?: string };

/** ¿La sesión corre con este actor? V2 reporta `default` como variant cuando no se pidió ninguno. */
export const esActor = (actor: Actor, modelo: Ref) =>
  actor.model === `${modelo.providerID}/${modelo.id}` && (actor.variant ?? "default") === (modelo.variant ?? "default");

/** Suplente: el primer actor después del actual que no esté fuera. Si el actual no es de la lista, el primero disponible. */
export function siguiente(validacion: Validacion, nombre: string, actual: Ref, fuera: (actor: Actor) => boolean): Actor | undefined {
  const lista = validacion.actores.get(nombre) ?? [];
  return lista.slice(lista.findIndex((actor) => esActor(actor, actual)) + 1).find((actor) => !fuera(actor) && !esActor(actor, actual));
}

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
