import type { Database } from "bun:sqlite";
import type { Validacion } from "./actores.ts";

/** Estado compartido por todas las instancias del proceso. */
export interface Proceso {
  validacion?: Validacion;
  /** Lo último que se logueó de la validación, para no repetirlo en cada location ni en cada model.updated. */
  firma: string;
  db?: Database;
}

// En 2.0.18 cada location importa su propia copia del módulo, pero todas comparten globalThis (sondas.md, S15).
// ponytail: el singleton sobrevive a un reload del módulo, y si guarda funciones mezcla código viejo con nuevo.
// En producción no pasa: el plugin no cambia sin reiniciar el servidor. En desarrollo, reiniciar el servidor y no
// confiar en el reload.
const key = Symbol.for("reparto.proceso");
const global = globalThis as { [key]?: Proceso };
export const proceso: Proceso = (global[key] ??= { firma: "" });
