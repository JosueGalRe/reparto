import type { Database } from "bun:sqlite";
import type { Validacion } from "./actores.ts";
import type { ErrorCrudo } from "./bajas.ts";

/** Estado compartido por todas las instancias del proceso. */
export interface Proceso {
  validacion?: Validacion;
  /** Lo último que se logueó de la validación, para no repetirlo en cada location ni en cada model.updated. */
  firma: string;
  db?: Database;
  /** Cola por proveedor: encargos corriendo y los que esperan cupo. */
  colas?: Map<string, { corriendo: number; espera: (() => void)[] }>;
  /** Qué proveedor ocupa cada encargo que tiene cupo. */
  cupos?: Map<number, string>;
  /** Hijas con un encargo abierto en este proceso, con su última actividad. */
  abiertos?: Map<string, { id: number; actividad: number; estancado?: boolean }>;
  /** Hijas nativas activas; el evento de ejecución cierra su vigilancia. */
  hijosNativos?: Map<string, { padre: string; actividad: number; avisado: boolean; permiso: boolean }>;
  /** Encargos que alguna instancia está cerrando, para no pedir su outcome dos veces. */
  cerrando?: Set<number>;
  /** Último error `primary` por sesión (http.response o ws.receive), hasta que lo consume el `retry`. */
  errores?: Map<string, ErrorCrudo>;
  /** Fallos 5xx seguidos del actor actual, por sesión. */
  fallos?: Map<string, { actor: string; n: number }>;
}

// En 2.0.18 cada location importa su propia copia del módulo, pero todas comparten globalThis (sondas.md, S15).
// ponytail: el singleton sobrevive a un reload del módulo, y si guarda funciones mezcla código viejo con nuevo.
// El estado sobrevive a hot reloads. El servidor diario carga el worktree estable, que solo cambia al publicar;
// después de publicar, reiniciar el servidor si algo se comporta raro.
const key = Symbol.for("reparto.proceso");
const global = globalThis as { [key]?: Proceso };
export const proceso: Proceso = (global[key] ??= { firma: "" });
