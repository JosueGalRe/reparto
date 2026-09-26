# Estado de reparto en SQLite

Las bajas, los pendientes y el estado propio de cada encargo se guardan en una base SQLite propia, en el directorio de datos del usuario. Se usa `bun:sqlite`, así que no agrega dependencias, y la base corre en modo WAL. Puede haber varios procesos de OpenCode a la vez (OpenChamber y la TUI): con archivos JSON, dos procesos que registran una baja al mismo tiempo se pisan, y SQLite resuelve esa concurrencia con transacciones. De un encargo se guarda solo lo que V2 no tiene: el padre, el actor, el proceso que lo creó y el estado de reparto (por ejemplo `estancado`). La sesión hija sigue siendo la fuente de verdad de la ejecución.

## Consequences

La fase 0 confirmó que un plugin de V2 puede importar `bun:sqlite` (sonda S5). V2 ofrece `ctx.storage`, que se comparte entre procesos, pero solo tiene `get`, `set`, `remove` y `scan`, sin transacciones, así que no sirve para las transiciones de más abajo.

Las transacciones de reparto tienen que ser cortas: SQLite respeta `busy_timeout`, pero no garantiza turno, y un proceso que escribe en bucle deja al otro esperando hasta que vence.

Varias instancias pueden observar el mismo encargo: todas las instancias de un proceso, una por location, reciben los eventos de todas las locations (sonda S15). Ninguna es su dueña: cada cambio de estado es una transición atómica (`UPDATE encargos SET estado = ? WHERE id = ? AND estado = ?`), y solo avisa la instancia que obtiene `changes = 1`. Así, si una instancia muere, no deja un claim huérfano.
