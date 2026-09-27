import type { Validacion } from './actores.ts'
import type { ErrorCrudo } from './bajas.ts'
import type { Database } from 'bun:sqlite'

/** Estado compartido por todas las instancias del proceso. */
export interface Proceso {
  validacion?: Validacion
  /** Lo último que se logueó de la validación, para no repetirlo en cada location ni en cada model.updated. */
  firma: string
  db?: Database
  /** Hijas con un encargo abierto en este proceso. */
  abiertos?: Map<string, { id: number }>
  /** Hijas nativas activas; el evento de ejecución cierra su vigilancia. */
  hijosNativos?: Map<string, { padre: string; desde: number; actividad: number; avisado: boolean; permisos: Set<string> }>
  /** Encargos que alguna instancia está cerrando, para no pedir su outcome dos veces. */
  cerrando?: Set<number>
  /** Último error `primary` por sesión (http.response o ws.receive), hasta que lo consume el `retry`. */
  errores?: Map<string, ErrorCrudo>
  /** Fallos 5xx seguidos del actor actual, por sesión. */
  fallos?: Map<string, { actor: string; n: number }>
}

// En 2.0.18 cada location importa su propia copia del módulo, pero todas comparten globalThis (sondas.md, S15).
// Ponytail: el singleton sobrevive a un reload del módulo, y si guarda funciones mezcla código viejo con nuevo.
// El estado sobrevive a hot reloads. El servidor diario carga el worktree estable, que solo cambia al publicar;
// Después de publicar, reiniciar el servidor si algo se comporta raro.
const key = Symbol.for('reparto.proceso')
const global = globalThis as { [key]?: Proceso }

global[key] ??= { firma: '' }
export const proceso: Proceso = global[key]
