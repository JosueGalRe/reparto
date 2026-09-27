# Plan por fases: reparto

Vocabulario en [CONTEXT.md](../CONTEXT.md) y decisiones en [docs/adr/](./adr/). Este plan ordena el trabajo y define cómo se verifica cada paso; no vuelve a decidir lo que ya está en los ADRs.

Hay cuatro fases: **0** confirma supuestos sobre V2 que hoy no están verificados, **1** es el MVP, que reemplaza a OMO en el uso diario, **2** agrega los planes y **3** pasa los encargos al `subagent` nativo (ADR 0013). Una fase no empieza sin que la anterior haya pasado sus escenarios. Si un resultado de la fase 0 contradice un ADR, se actualiza ese ADR antes de seguir.

Supuestos base: OpenCode `2.0.18`, SDK `@opencode/plugin` fijado en la versión exacta instalada, runtime Bun y plugin local en `~/projects/reparto` (sin publicarlo en npm). En cada upgrade de OpenCode se hace un diff de tipos del SDK y se vuelven a correr los escenarios de las rebanadas afectadas.

Lo que el plugin recibe de V2 está acotado por los tipos: `ctx.session` es un `Pick` de `SessionApi` con `create`, `get`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait` y `context` (`plugin/dist/promise/session.d.ts:143`). No hay `import`, `skill` ni `message.list`, y el `Context` no expone el cliente HTTP completo. El plan solo cuenta con lo que está en ese `Pick`.

Tres reglas de la API que salieron de las sondas ([docs/sondas.md](./sondas.md)) y valen para todo el plan:

- Toda tool de reparto se registra con `options: { codemode: false }`; sin eso, el modelo solo la alcanza desde `execute` (S11).
- Un modelo se pasa como `Model.Ref`, un objeto `{ providerID, id, variant? }`. Un string en `agent.model` deja al agente mal formado sin dar error (S10).
- `session.create` toma la location del cuerpo (`location: { directory }`); sin ella, la sesión cae en la del servidor (S15).

---

## Fase 0: sondas

Un plugin descartable (`sondas/`) con una sonda por supuesto. Cada resultado queda en `docs/sondas.md`, con la evidencia: log, captura o fila de SQLite.

| # | Pregunta | Cómo se prueba | Si falla |
|---|---|---|---|
| S0 | ¿Se puede correr OpenCode con una config alternativa (sin OMO) sin tocar la tuya? | Variable de entorno o flag de config de V2. Verificar con `opencode` en tmux que carga solo `reparto` y `opencode-claude` | Desarrollar en otro usuario o perfil de OpenChamber |
| S1 | ¿`session.synthetic` dispara un turno? ¿Qué hacen `delivery: "steer"` y `"queue"`, con y sin `resume: true`, con la sesión libre y con la sesión ocupada? | Inyectar en una sesión libre y en una ocupada, en cada combinación, y observar si hay turno nuevo | El aviso de un encargo va como `session.prompt` |
| S2 | ¿Qué pasa si `setup` lanza un error? | Sonda que lanza en `setup` | Documentarlo. La regla sigue igual: reparto nunca lanza en `setup` |
| S3 | ¿Cómo se ve un 429 en `http.response` (status, headers, body) y en `retry` (`type`, `message`, `status`) para `openai`, `claude-code` y `kimi-code-plan-global`? ¿Se puede correlacionar un `http.response` con el `retry` siguiente por `sessionID`? ¿`decision = { retry: false }` corta el retry nativo? | Sonda que registra todo lo que no sea 2xx y cada `retry`, con su `sessionID`. Dato ya observado: con la cuota semanal agotada, OpenAI responde `The usage limit has been reached` | El clasificador arranca con los códigos documentados (`insufficient_quota` vs `rate_limit_exceeded`) y el texto observado, y se ajusta con la primera baja real. Si `retry: false` no corta el retry nativo, reparto hace `session.interrupt` antes del `switchModel` |
| S5 | ¿Un plugin de V2 puede importar `bun:sqlite`? ¿El `ctx.storage` de V2 (`storage.d.ts:3-8`) se comparte entre procesos? | `new Database(path)` en `setup`. Dos procesos escribiendo a la vez | Usar `ctx.storage` si es compartido, o una dependencia SQLite; reevaluar ADR 0010 |
| S6 | ¿El campo `skills` de `SessionPromptInput` carga los skills en la sesión? | `ctx.session.prompt` con `skills: ["programming"]` en una sesión nueva y revisar el contexto que ve el modelo | El primer prompt de la hija le pide cargar esos skills con la tool nativa |
| S7 | ¿Los permisos de V2 imponen bash por patrón de comando (`rg *`, `git status*` y `git diff*` permitidos, `*` denegado) y niegan `edit`, `write`, `patch`, `subagent` y `delegar`? ¿Resisten encadenamiento y redirección? | Agente de prueba con esas reglas intentando `sed -i`, un heredoc, `rg x; rm y`, `rg x > f`, `git diff --output=f`, `rg x \| xargs rm`, `edit` y `subagent`, y comprobando que `rg x \| head` sí pasa | Decidir en `ctx.permission.hook("evaluate")` (`permission.d.ts:6-17`), que puede cambiar `effect`: denegar `;`, `&&`, `>`, `$(` y `--output`, y en un pipe exigir que cada tramo esté en la lista de lectura (ADR 0006) |
| S8 | ¿Cómo se cambia de actor en el caso real? Tres casos: después de `session.execution.failed`; dentro del hook `retry`; y en el director, con `switchModel` dentro del hook `prompt`, afectando ese mismo turno. ¿Se puede reanudar sin duplicar el mensaje del usuario (`resume` en `SessionSyntheticInput` o en `SessionInterruptInput`)? ¿Sale el variant en la request? | Forzar cada caso y mirar qué modelo, variant y mensajes salen en la request | Crear una sesión nueva con el resumen de la anterior (se documenta como degradación) |
| S9 | ¿Cuándo está completo el catálogo? ¿La transform de reparto ve los modelos de `claude-code` si `opencode-claude` va antes en `plugins`? ¿Llegan `model.updated` y `models-dev.refreshed`? | Registrar lo que ve `ctx.model` en `setup` y después de esos eventos | Validar en diferido, al abrir la primera sesión |
| S10 | ¿Cómo se ven en la TUI y en OpenChamber los agentes registrados con `mode: "subagent"` y `hidden`? ¿`AgentEditor.default(id)` deja al director como agente por defecto? ¿Se puede modificar el `build` nativo (reparto y permisos)? | Registrar un agente, fijar el default y editar `build`. Revisar el selector de la TUI y de OpenChamber | Si `build` no se puede editar, se deja sin reparto y queda como riesgo conocido |
| S11 | ¿Una tool del plugin le llega a Opus a través del tool bridge de `opencode-claude`? | Tool `eco` llamada desde una sesión con `claude-code` | Arreglarlo en `opencode-claude` antes de la fase 1 |
| S12 | ¿El comando registrado con `ctx.command.transform(e => e.add({ name, execute }))` aparece en la TUI y en OpenChamber? | Comando de prueba | Una tool `estrenar` que llamas desde el chat |
| S13 | ¿Qué evento cierra una ejecución? Los tipos traen `session.idle` y `session.execution.{started,succeeded,failed,interrupted}`: ¿cuáles emite 2.0.16? ¿`session.wait` vuelve también con `failed` e `interrupted`? ¿Qué eventos cuentan como actividad (`session.step.*`)? | Correr una hija que termina bien, una que falla y una interrumpida, y registrar todos los eventos y lo que devuelve `wait` | Detectar el fin con `session.wait` y la actividad por el timestamp del último mensaje (`session.get`) |
| S14 | ¿`session.context` devuelve las tool calls de la hija con sus argumentos y resultados completos, también después de una compactación? | Leer el contexto de una hija con tool calls, antes y después de compactarla | `bitacora` registra las tool calls de cada encargo en SQLite con `ctx.tool.hook("execute.after")` (`tool.d.ts:38-51`) |
| S15 | ¿Cuántas veces corre `setup` por servidor (una por proceso o una por location)? ¿Cada instancia recibe los eventos de todas las locations? ¿Cuántas veces se dispara el hook `retry` por cada fallo? | Registrar cada `setup`, cada evento con su `location.directory` y cada `retry`, con dos directorios abiertos | Filtrar los eventos por `location` y actuar sobre un encargo solo tras ganar su transición de estado en SQLite (ADR 0010). Si `retry` se dispara más de una vez, el cambio de actor en sesiones que no son encargos también pasa por una transición en SQLite |

S4 (`session.import` con `parentID`) sale: `import` no está en el `Pick` que recibe el plugin. Las hijas se crean con `create` + `metadata.padre` y la UI no las agrupa (ADR 0009).

**Resultado (2026-09-25).** Las sondas corrieron contra 2.0.16; los resultados y la evidencia están en [docs/sondas.md](./sondas.md). Ninguna bloqueó la fase 1. Los cambios que dejaron están aplicados en este plan (1.2, 1.4, 1.5, 1.6, 1.8, 1.9 y riesgos) y en los ADRs 0004, 0006, 0009 y 0010. Antes de borrar `sondas/` se conservan el arnés de S0 (`run.sh` y `api.sh`) en `scripts/` y, como fixtures de `bun test`, los cuerpos de error de S3 y los contextos de S8 y S14 (`sondas/log/`).

Salida de la fase 0: `docs/sondas.md` completo, los ADRs y este plan ajustados, y un ensayo general del plan ajustado con al menos un revisor de un proveedor distinto de Anthropic (el cierre del 2026-09-25 corrió solo en Opus). `sondas/` se borra al terminar. La fase 1 no arranca sin ese ensayo.

---

## Fase 1: MVP

Objetivo: usar `reparto` en lugar de OMO en el trabajo diario. Se construye en rebanadas verticales, en orden, y cada una deja algo que se puede usar y verificar.

**Estructura del repo.** Siguiendo el ADR 0003, los módulos de dominio tienen nombre en español y la plomería en inglés:

```
src/
  index.ts          Plugin.define({ id: "reparto", setup })
  config.ts         lee y valida reparto.jsonc
  catalog.ts        lectura del catálogo de V2
  db.ts             SQLite (bajas, pendientes, encargos)
  actores.ts        resolución titular → suplentes según bajas
  bajas.ts          clasificador de errores y registro de bajas
  agentes.ts        registro de agentes y papeles en V2
  encargos.ts       delegar, bitacora, cola por proveedor, avisos
  pendientes.ts     tool pendientes
guiones/            un .md por agente y papel (inglés, ADR 0008)
schema/reparto.schema.json
```

Tests con `bun test` para la lógica pura: la config, el clasificador de errores y la resolución de actores. El resto se verifica en una sesión real.

### 1.1 Esqueleto y config

- `Plugin.define({ id: "reparto", setup })`. `setup` nunca lanza error: cualquier falla se registra y deja al plugin inactivo.
- La ruta de la config sale de `options.config` y por defecto es `~/.config/opencode/reparto.jsonc`. La tuya vive en dotfiles, como `omo.jsonc`.
- Forma: `agentes.<nombre>` y `papeles.<nombre>`, cada uno con `titular: { model, variant? }` y `suplentes: [...]`. `proveedores.<id>` lleva `concurrencia` y `plazoBaja`. Un JSON Schema chico cubre solo la estructura.
- **Escenario:** una config con estructura rota deja al plugin inactivo, OpenCode arranca y el log dice por qué.

### 1.2 Actores y validación contra el catálogo

- Cada actor se valida contra `ctx.model`: el modelo existe, tiene `enabled: true` y el variant, si está, figura en su catálogo. El catálogo del transform incluye modelos deshabilitados (S9: 55 de OpenAI contra 15 en `list`), así que no alcanza con que exista. Un actor inválido queda excluido. Un agente o papel sin actores válidos queda desactivado.
- La validación lee el catálogo dentro de `ctx.model.transform`, sin modificarlo: el callback ve todos los proveedores sin importar el orden de `plugins`, y V2 lo vuelve a correr en cada `model.updated` (S9). En `setup`, `ctx.model.list()` todavía no tiene los modelos de los plugins cargados después. El callback es sincrónico: guarda el catálogo y la revalidación corre fuera.
- Las exclusiones quedan en el log y en una lista que 1.5 inyecta al director.
- **Escenarios:**
  - `bun test`: con un catálogo de prueba, `opencode-go/kimi-k3` con `variant: "low"` queda excluido y la resolución devuelve el siguiente actor; un modelo que existe con `enabled: false` también queda excluido; un papel sin actores válidos sale como desactivado.
  - Con OpenCode real, esa misma config deja en el log una línea que nombra el actor excluido y el motivo.

### 1.3 Migración de repartos

Va antes que el resto para que las rebanadas siguientes se prueben con la config real.

- Se genera `reparto.jsonc` desde `~/dotfiles/omo/omo.jsonc`:
  - **Agentes**: sisyphus → director, explore → utilero, librarian → archivista, oracle → oracle, prometheus → dramaturgo, momus → critico, atlas → regidor. Los tres últimos se registran en la fase 2.
  - **Categorías**: quick → rapido, visual-engineering → visual, deep-low → protagonista, ultrabrain → estelar, writing → prosa.
  - `build` toma el reparto que hoy tiene sisyphus.
  - **Sin equivalente, no se migran**: `hephaestus`, `metis` (ADR 0011), `deep-high` (se funde en estelar, ADR 0007), `unspecified-low`, `unspecified-high`, `artistry` y el profile `cursor`.
  - `reasoning` pasa a `variant` crudo, verificado contra el catálogo (ADR 0002). No hay herencia: cada actor lleva el suyo o ninguno.
  - `providerConcurrency` pasa a `proveedores.<id>.concurrencia` con los mismos valores (hoy 2 para `claude-code` y `kimi-code-plan-global`). Los proveedores sin valor toman el default 3.
- Actores inválidos que se esperan, según [el reporte de reasoning y benchmarks](./referencias/reasoning-y-benchmarks.md): `opencode-go/kimi-k3` en `low`, MiniMax y MiMo en `max`, Qwen y Kimi HighSpeed en `off`, y GLM-5.2 en `xhigh`. Si el modelo tiene variants en el catálogo, se corrige al válido más cercano. Si no tiene ninguno (Kimi HighSpeed, Qwen 3.7 Plus y MiMo V2.6 Pro, según el reporte), se omite `variant` y corre el default del proveedor (ADR 0002). Cada corrección queda como comentario en `reparto.jsonc`.
- **Escenario:** al arrancar con la config migrada, el log no excluye ningún actor. Si excluye alguno, no estaba en esa lista y se corrige a mano.

### 1.4 Estado en SQLite

- La base está en `~/.local/share/reparto/reparto.db`, en modo WAL y con `PRAGMA busy_timeout`. La sesión hija sigue siendo la fuente de verdad de la ejecución (ADR 0010). Tablas:
  - `bajas`: proveedor o actor, motivo, hasta.
  - `pendientes`: sesión o plan, ítems.
  - `encargos`: una fila por ejecución de una hija. Guarda id propio, id de la hija, padre, actor, estado, mensaje final, `aviso_pendiente` y el proceso que la creó (`boot_id`, `pid` y starttime). Un índice único parcial admite una sola fila abierta por hija.
  - `bitacora`: id de la hija, id de la tool call, tool, argumentos, resultado recortado, estado y hora.
- `ctx.storage` no reemplaza a esta base: se comparte entre procesos, pero no tiene transacciones (S5).
- Las bajas se escriben con `INSERT ... ON CONFLICT` dentro de una transacción.
- Las transacciones son cortas y nunca en bucle: SQLite respeta `busy_timeout`, pero no garantiza turno, y un proceso que escribe sin pausa deja al otro esperando hasta que vence (S5). Una transición que falla con `SQLITE_BUSY` se reintenta una vez y, si vuelve a fallar, queda en el log; el encargo lo recupera la reconciliación del próximo arranque.
- **Escenario:** una baja registrada en un proceso se ve en otro proceso y sigue ahí después de un reinicio.

### 1.5 Agentes, papeles y permisos

- Se registran con `AgentEditor.update`, que crea el agente si no existe:
  - **director**: primario y agente por defecto con `AgentEditor.default`. Vale en la TUI y para las sesiones creadas sin agente; OpenChamber no lo usa y elige el agente guardado, después `plan` (S10).
  - **utilero**, **archivista**, **oracle**: subagentes de solo lectura, sin edición ni delegación y con shell abierto; solo el director tiene lista permitida de comandos.
  - **rapido**, **visual**, **protagonista**, **estelar**, **prosa**: subagentes.
  - **build**: queda nativo, con el reparto de `agentes.build`.
- Permisos:
  - **director**: sin `edit`, `write` ni `patch`; sin `subagent`; sin las tools de PTY (`pty_*`) ni ninguna otra tool con efectos que cargue otro plugin; `shell` negado con `*` y permitido solo para la lista de lectura (`rg *`, `git status*`, `git diff` y `git diff *`, `git ls-files*`, `git log*`, `git show*`, y `head *`, para que `rg x | head` pase). V2 oculta las tools negadas pero no los comandos, así que solo el guion del director lista los comandos permitidos. `git diff *` lleva el espacio para no dejar pasar `git difftool --extcmd=…`. V2 exige que cada tramo de `;`, `&&`, `|` y `$( )` esté en la lista, y oculta al modelo las tools negadas (S7). Lo que V2 no cubre lo niega un hook `ctx.permission.hook("evaluate")`: un tramo con `>`, `<` (incluye `<(`), backticks, un salto de línea, `--output`, `--ext-diff`, `--textconv`, `--pre` o `--pre-glob`. Los backticks, los saltos de línea y `<(` no se probaron en S7; se niegan por las dudas. El hook solo recibe lo que las reglas permiten, así que sirve para negar, no para permitir. Un driver de diff configurado en git se ejecutaría igual: la frontera es de conducta, no un sandbox (ADR 0006), y hoy tu gitconfig no define ninguno.
  - **build**: sin `subagent`.
  - **`delegar`** solo lo tienen el director y `build` (y el regidor en la fase 2). Papeles y subagentes no delegan: así un encargo nunca espera a otro dentro de la misma cola y la cola por proveedor no se puede trabar.
- Guiones v1: el del director lleva la tabla de ruteo de los cinco papeles (ADR 0007), el escalamiento a `estelar` y el formato del brief de un encargo. Cada papel tiene su guion corto, y utilero, archivista y oracle, el suyo.
- Al abrir una sesión del director se le inyecta la lista de exclusiones de 1.2, y los papeles desactivados no aparecen en su tabla de ruteo.
- El actor del director y de `build` lo impone el hook `prompt` con `session.switchModel`, pero solo en dos momentos: el primer turno de la sesión y el primer turno después de que empiece o termine una baja que afecte al actor resuelto. El resto del tiempo se respeta el modelo que tenga la sesión, así que si lo cambias a mano, reparto no lo revierte. `agent.model` no alcanza: el servidor no lo aplica a las sesiones primarias, y OpenChamber usa el modelo guardado (S10).
- **Escenarios:**
  - El director no tiene `edit`, `write`, `patch` ni `pty_*` entre sus tools (se ve en la lista de tools de la request).
  - Le pides "arregla este typo con sed": las reglas de V2 lo niegan, y también `rg x; rm y`.
  - `build` edita directo.
  - Le pides `rg x > f`, `git diff --output=f`, ``rg `touch f` `` y `git difftool --extcmd='touch f'`: se niegan todos y `f` no existe.
  - Abres una sesión del director en OpenChamber con otro modelo seleccionado: el primer turno sale con el titular del director.
  - Cambias a mano el modelo del director a mitad de sesión: los turnos siguientes salen con ese modelo (el caso con bajas se prueba en 1.8).
  - Con un actor inválido en la config, el director abre con un aviso que lo nombra; con un papel sin actores válidos, el papel no está en su tabla de ruteo.

### 1.6 `delegar` y `bitacora`

- `delegar({ a, prompt, background?, sesion?, skills? })`:
  - `a` es un agente o un papel. Se resuelve su actor y se crea la hija con `session.create`: agente, `model` con `variant`, `permissions` y `metadata.padre`, en la `location` de la sesión padre (vía `session.get`), no en `ctx.location`.
  - Los skills van en el primer `session.prompt` de la hija, como `skills: [{ id }]`; V2 mete su texto en ese mensaje (S6).
  - En modo sincrónico espera con `session.wait` y lee el resultado con `session.get` (`outcome`), porque `wait` vuelve igual si la hija terminó, falló o fue interrumpida (S13). Propaga el `signal` de la tool a `session.interrupt` de la hija. En background devuelve de inmediato el id de la sesión hija.
  - `sesion` retoma una hija anterior: agrega una fila nueva en `encargos` para esa hija. Si la hija ya tiene una fila abierta, `delegar` se niega con "encargo ya corriendo".
- Cola por proveedor, con `concurrencia` y default 3. La cola vive en `globalThis`, por proceso, no dentro de `setup`: `setup` corre una vez por location, y en 2.0.18 cada location importa su propia copia del módulo, pero todas comparten `globalThis` (S15). Así el tope es por proceso y no por directorio abierto. Con TUI y OpenChamber abiertos (dos procesos), el tope real es el doble.
- Estados de un encargo: `en cola`, `corriendo`, `terminado`, `fallido`, `interrumpido`, `estancado`.
  - El fin se detecta con `session.execution.succeeded`, `.failed` e `.interrupted`, y el resultado se confirma con `session.get().outcome` (S13). Terminado exige además que haya salida.
  - Si la hija falla por algo que 1.8 resuelve con un suplente, el cambio ocurre dentro del hook `retry` y la ejecución sigue: no hay evento de fin ni aviso, y el encargo sigue `corriendo` (S8). Si no queda suplente, `retry: false` lleva a `session.execution.failed` y el encargo pasa a `fallido` por el camino normal.
  - Transiciones permitidas: `en cola → corriendo | fallido`; `corriendo → terminado | fallido | interrumpido | estancado`; `estancado → corriendo | terminado | fallido | interrumpido`. Cualquier otra se rechaza. Los estados terminales no se reabren: retomar crea otra fila.
  - Hay aviso al padre para `terminado`, `fallido` (con error y último actor), `interrumpido` y `estancado`. Un solo `session.prompt({ delivery: "queue" })` envía una cabecera visible `[reparto] <título> — <estado> (<id>)`, el resultado recortado a 1500 caracteres o el motivo breve y la pista de `bitacora`. OpenChamber oculta y fusiona mensajes de usuario totalmente sintéticos, `prompt` solo acepta texto plano y la variante de dos llamadas (`synthetic` + `prompt`) produjo dos turnos del director. Con `queue`, si el padre está libre inicia un turno; si está ocupado espera al final sin desviarlo (S1).
  - La transición que cierra un encargo guarda en la misma transacción el mensaje final y `aviso_pendiente = 1`, que pasa a 0 después del `prompt`. Si el proceso muere en el medio, la reconciliación reenvía los avisos pendientes aunque el encargo esté cerrado. En ese caso límite el aviso puede llegar dos veces: la entrega es "al menos una vez".
  - Cada instancia recibe los eventos de todas las locations del proceso, y los `session.execution.*` no traen `location`. Por eso cada instancia filtra por `sessionID` contra la fila abierta de esa hija en `encargos`, y todo cambio de estado es una transición atómica (`UPDATE encargos SET estado = ? WHERE id = ? AND estado = ?`): solo avisa la instancia que obtiene `changes = 1`. No hay dueño ni claim que pueda quedar huérfano (ADR 0010, S15).
  - Cada fila guarda `desde`: el instante en que pasa a `corriendo`, escrito en la misma transición y antes de su `session.prompt`. Un `session.execution.*` cuenta para la fila solo si su `created` es posterior a `desde`, y un `session.get().outcome` solo si su `time.idle` es posterior: el `outcome` es el de la última ejecución de la sesión, no el de la fila (`schema/session.d.ts:143`). Así, un cierre de una fila anterior de la misma hija que se procesa tarde no toca la fila retomada.
  - Un encargo vive en el proceso que lo creó: sus eventos no llegan a otros procesos, y si ese proceso muere la hija queda sin `outcome` (S15).
- Sin actividad durante 30 min, el encargo queda estancado: se avisa al director y nada se mata; el director decide si lo interrumpe con `interrumpir`. Cuentan como actividad los eventos `session.step.*`, `session.tool.*`, `session.text.*` y `session.reasoning.*` de la hija, incluidos los `delta`, porque un paso largo sin tools solo emite esos (S13). `session.get` no sirve para esto: su `time.updated` no se mueve.
- Un `permission.asked` de una hija con encargo abierto cuenta como actividad y genera un solo aviso visible al padre por requestID, deduplicado con SQLite. Mientras el permiso siga pendiente, el encargo no queda estancado; `permission.replied` registra la respuesta y actividad. Bryan abre la hija por título en la lista de chats y responde allí al prompt nativo: una tool de plugin no puede pedir confirmación nativa en la sesión padre.
- `interrumpir({ id })` la tienen el director y `build`: interrumpe un encargo abierto solo si la hija tiene `metadata.padre` igual a la sesión que llama, y rechaza cualquier otro id con un mensaje claro. El cierre pasa por la misma transición atómica a `interrumpido` (un encargo `en_cola`, que no llegó a correr, pasa a `fallido`).
- `bitacora({ id, detalle? })`: por defecto, el mensaje final y las tool calls con su argumento clave; con `detalle: "completo"`, también sus resultados (recortados). Las tool calls salen de la tabla `bitacora`, que llena `ctx.tool.hook("execute.after")` para las sesiones que están en `encargos`, deduplicadas por `sessionID + messageID + id`. El mensaje final sale de `encargos`, que lo guarda al cerrar. Después de compactar, `session.context` ya no tiene ni las tools ni la respuesta (S14). Una tool cortada porque murió el proceso no llega a `execute.after` y no aparece.
- Las hijas nunca se borran.
- Reconciliación al arrancar: `setup` la lanza sin esperarla, para no bloquear el arranque. Recorre los `encargos` abiertos y los que tengan `aviso_pendiente`. Un encargo abierto cuyo proceso sigue vivo se deja, porque es de ese proceso: `setup` también corre al abrir otra location en un proceso vivo, con su cola intacta (S15). Un proceso está vivo si coinciden `boot_id`, `pid` y el starttime de `/proc/<pid>/stat`: el pid solo se reusa, incluso sin reiniciar. Si el proceso ya no existe, un encargo `corriendo` o `estancado` se resuelve con `session.get().outcome` (no con `wait`, que desde otro proceso vuelve en el acto, S13), pero solo si su `time.idle` es posterior a `desde`; si no hay `outcome` posterior, pasa a `fallido` con el motivo "perdido en reinicio". Uno `en cola` pasa a `fallido` con ese motivo. El aviso de esos cierres lo manda solo la instancia que gana la transición. Después se reenvían los avisos pendientes: ahí no hay transición que ganar, así que dos reconciliaciones simultáneas pueden duplicar un aviso, dentro de "al menos una vez".
- **Escenarios:**
  - Le pides un cambio de una línea al director: termina en un encargo a `rapido`.
  - Tres encargos en background a `utilero`: llegan tres avisos con su mensaje final, y el director sigue conversando mientras tanto.
  - Con un solo proceso abierto, seis encargos a papeles de OpenAI nunca corren más de 3 a la vez (visible en el log de la cola).
  - `bitacora` de un encargo de utilero lista los archivos que leyó.
  - Retomar un encargo con `sesion` conserva su historial y agrega una fila nueva; dos retomas simultáneas de la misma hija: una corre y la otra recibe "encargo ya corriendo".
  - `bitacora` de una hija terminada y después compactada sigue devolviendo su mensaje final y sus tool calls.
  - Interrumpir una hija a mano: el director recibe un aviso `interrumpido`.
  - El director interrumpe con `interrumpir` un encargo propio estancado: pasa a `interrumpido`.
  - `interrumpir` con el id de un encargo de otra sesión: se rechaza y el encargo sigue corriendo.
  - El encargo interrumpido con `interrumpir` genera un solo aviso `interrumpido`.
  - El utilero lista los archivos del repo sin chocar con un comando negado.
  - Con dos directorios abiertos en el mismo servidor, un encargo genera un solo aviso.
  - Con un encargo `en cola`, abrir otro directorio en el mismo servidor no lo marca perdido.
  - Cerrar la TUI a mitad de un encargo lanzado desde ella: el service de fondo sigue, y el aviso llega al volver a abrirla.
  - Con dos procesos abiertos (TUI y OpenChamber), un encargo lanzado en uno no genera avisos en el otro.
  - Matar el servidor con un encargo en background corriendo y volver a arrancarlo: el encargo pasa a `fallido` ("perdido en reinicio") y el director recibe un solo aviso.
  - Retomar una hija terminada y matar el servidor antes de que salga el prompt de la retomada: al arrancar, la fila nueva pasa a `fallido` ("perdido en reinicio"); el `succeeded` de la ejecución anterior no la cierra como terminada.
  - El evento de cierre de la ejecución anterior llega después de que la retomada pasó a `corriendo`: la fila retomada no cambia de estado.
  - Matar el servidor entre el commit del cierre y el `synthetic`, con dos procesos reconciliando a la vez: el aviso llega al menos una vez (puede llegar dos).

### 1.7 `pendientes`

- Una tool para leer y reescribir la lista de la sesión, guardada en SQLite.
- **Escenario:** el director crea una lista, la actualiza y la lee de nuevo después de una compactación.

### 1.8 Suplentes y bajas

- Clasificador de errores (S3). Parte del `error.type` que V2 ya pone en el `retry` (`provider.quota`, `provider.rate-limit`, `provider.internal`, `provider.auth`) y lee el cuerpo del último error de la misma sesión: el de `http.response`, o el de `experimental.ws.receive` para `openai`, que va por WebSocket. Solo se guarda el de las requests con `kind: "primary"`: las de título, compactación y `generate` comparten `sessionID` (`session.d.ts:52-78`). El `retry` lo consume y lo borra, y un cambio de actor también lo borra. Si no hay cuerpo que corresponda, vale la clasificación de V2 sin corregir.
  - **Cuota**: `provider.quota`, más un `provider.rate-limit` con `code: "claude_session_limit"` en el cuerpo (el límite de suscripción de `claude-code`, que V2 reintentaría a los 15 min). Baja del proveedor hasta el reset del cuerpo (`resets_at` en OpenAI y `claude-code`) o de los headers, o hasta `plazoBaja`.
  - **Límite de velocidad**: el resto de `provider.rate-limit`. Se deja el reintento nativo, que ya respeta `retry-after`; sin baja.
  - **5xx o timeout**: `provider.internal`. Se deja el reintento nativo del mismo actor hasta 3 fallos seguidos de ese actor (configurable), contados por reparto: `attempt` es el número del próximo intento de la ejecución, no de fallos del actor (S3). Después entra el suplente.
  - **Auth**: `provider.auth`. Entra el suplente y se avisa.
- El cambio de actor se hace dentro del hook `retry`: `session.switchModel` al suplente y `decision = { retry: true, delay: 0 }`. El reintento sale con el suplente en el mismo turno, sin prompt nuevo y sin reenviar el mensaje del usuario (S8). La sesión avisa quién entró. Si no queda suplente, `decision = { retry: false }` y la ejecución termina en `failed`.
- Si el cambio es un encargo y el suplente es de otro proveedor, el cupo pasa de la cola del proveedor viejo a la del nuevo. Si la del nuevo está llena, el encargo la excede igual y queda en el log: esperar un cupo dentro de `retry` podría trabarse con cambios cruzados. `// ponytail: exceso por suplencia; cola estricta si provoca 429 propios`.
- El titular vuelve en las sesiones nuevas, y en el director al empezar tu siguiente turno: el hook `prompt` hace `switchModel`, que afecta a ese mismo turno (S8). Una sesión de papel conserva su actor hasta terminar. Qué actor impuso reparto en cada sesión primaria, y con qué estado de bajas, se guarda en `ctx.storage` y no en memoria, para que una recarga del plugin o un reinicio no lo tome como primer turno (1.5).
- **Escenarios:**
  - Con una baja de `openai` insertada en SQLite, un encargo a `protagonista` corre con su suplente y la sesión lo avisa.
  - Con una request forzada a fallar por cuota, en una sesión viva, entra el suplente sin que tengas que reescribir el mensaje, y el padre no recibe un aviso `fallido`.
  - Con todos los actores de un papel de baja, el encargo termina en `fallido` y el padre recibe ese aviso.
  - Titular y primer suplente fallan por cuota seguidos: el encargo termina con el segundo suplente, en la misma ejecución y sin aviso intermedio.
  - Con la cola de `kimi-code-plan-global` llena y una baja nueva de `openai`, un encargo que pasa de OpenAI a Kimi corre igual y el log registra el exceso.
  - `bun test`: un error de una request `kind: "title"` intercalado antes del `retry` no cambia la clasificación, y el cuerpo del actor anterior no se reusa después de un cambio.
  - Un 429 de velocidad no deja ninguna fila en `bajas`.
  - Un 429 de `claude-code` con `claude_session_limit` deja una baja de `claude-code` hasta su `resets_at`, y el turno sigue con el suplente sin esperar los 15 min del reintento nativo.
  - Cuando la baja vence, el siguiente turno del director vuelve a Opus.
  - Cambiaste a mano el modelo del director y después empieza una baja que afecta a su titular: el siguiente turno sale con el primer suplente disponible.
  - Reinicias OpenCode a mitad de una sesión del director en la que cambiaste el modelo a mano: el siguiente turno conserva tu modelo.

### 1.9 Corte

- Se agrega `reparto` a `plugins` en `opencode.json` como plugin nativo, después de `opencode-claude`. Para la validación el orden no importa (S9), pero así los `setup` ven el catálogo completo.
- Sale solo la línea de OMO de `options.plugins` de `opencode-v1-compat`. El shim se queda, porque carga `ponytail`, `opencode-pty`, `opencode-direnv`, `envsitter-guard`, `opencode-working-memory` y `rtk`; lo nativo es reparto, no todo el setup. `omo.jsonc` queda en dotfiles como vía de vuelta.
- En Plannotator, `planningAgents` cambia "Sisyphus - ultraworker" y "Prometheus - Plan Builder" por `director` (y `dramaturgo` en la fase 2); `plan` se queda.
- Antes de sacar OMO se portan a `~/dotfiles/agents/skills/` los skills suyos que se usan, con el aviso SUL-1.0 (ADR 0001). Sin OMO, V2 no los carga. La lista y los conteos están en [referencias/skills-de-omo.md](./referencias/skills-de-omo.md). Los guiones de reparto solo nombran skills que existan después del corte.
- **Escenario:** una semana de uso diario sin volver a OMO. Si hay que volver, se anota el motivo.

---

## Fase 2: planes

Arranca solo después de un corte estable.

### 2.1 Dramaturgo

- Agente primario. Te entrevista antes de escribir y escribe `.reparto/planes/<slug>.md` con un formato fijo: tareas con id, criterio de aceptación y verificación. Solo puede escribir en `.reparto/planes/*`.
- **Escenario:** si intenta escribir fuera de `.reparto/planes/`, se le niega.

### 2.2 Crítico y ensayo general

- Se registra **critico**: subagente de solo lectura, con su guion. El guion fija el formato del veredicto que `ensayar` lee: `aprobado`, u objeciones que citan sección y defecto, más notas (ADR 0011).
- Una tool `ensayar(plan)` en manos del dramaturgo:
  - Calcula la versión (hash del archivo) y guarda una instantánea del contenido en la tabla `versiones` (plan, hash, contenido).
  - Elige actores para crítico y oracle en proveedores distintos entre sí y del dramaturgo (ADR 0011).
  - Los corre en paralelo como encargos nuevos en cada ronda, nunca con `sesion` (ADR 0011). Cada revisor recibe el texto de la instantánea, no la ruta del archivo, para que los dos revisen exactamente la misma versión.
  - Devuelve un veredicto estructurado por revisor.
  - Lleva la cuenta de rondas; al cerrar o en la ronda 5, te muestra el plan con lo que quedó.
- Al terminar la ronda 1, las objeciones de los dos revisores forman el **acta**: cada una con su causa y la condición que la cierra; el dramaturgo puede fusionar duplicadas. Desde la ronda 2, cada revisor recibe el plan, el diff contra la instantánea de la ronda anterior y el acta, verifica el cierre de cada entrada y busca regresiones de los arreglos. Una objeción nueva entra al acta solo si dice por qué la ronda 1 no pudo encontrarla (ADR 0011); si no, `ensayar` la registra como nota.
- Tablas nuevas en SQLite: `versiones` (plan, hash, contenido), `ensayos` (plan, ronda, hash, revisor, actor, veredicto) y `acta` (plan, id, objeción, condición de cierre, ronda de entrada, estado). El diff se calcula entre instantáneas.
- Es una tool y no un guion porque la elección de proveedores, la versión y el conteo de rondas tienen que ser deterministas.
- **Escenarios:**
  - Un plan con una tarea sin verificación: el crítico la objeta citando la sección, el dramaturgo la corrige y la ronda 2 cierra.
  - Con `openai` de baja, crítico y oracle igual quedan en proveedores distintos, o el cierre aparece marcado como "con proveedores repetidos".
  - En la ronda 2, un revisor objeta una sección que el diff no tocó sin decir por qué la ronda 1 no pudo verlo: queda como nota y no bloquea el cierre.
  - Un reinicio a mitad de una ronda: `ensayar` vuelve a lanzar esa ronda con encargos nuevos sobre la misma instantánea.

### 2.3 Estreno y regidor

- Se registra **regidor**: primario, con su guion y los mismos permisos y tools que el director, incluido `delegar` (ADR 0012).
- Tu OK en el chat estrena el plan. `estrenos` guarda plan, hash y fecha, y solo acepta un hash que tenga los dos veredictos `aprobado` en `ensayos`. Si decides estrenar con objeciones abiertas (ronda 5 sin cierre), queda registrado como `estreno con objeciones`, con la lista.
- El comando `/estreno <plan>` (S12) convierte la sesión actual si aún no tiene mensajes; de lo contrario abre otra sesión del regidor con el plan. Siembra sus pendientes desde las tareas, atados a la versión del plan.

**Notas de revisión (diferidas):**
- Regidor interrumpido que se reanuda por avisos de encargos (#5).
- Ensayar simultáneamente la misma ronda desde dos sesiones del dramaturgo (#6).
- Registrar el actor efectivo después de una suplencia.
- Medir cambios de progreso, no solo cambios de la lista, en el guard de continuación.
- Continuación: si el regidor queda libre con tareas del plan sin terminar, reparto le pide seguir. Aplica solo en sesiones del regidor, y no cuando está esperando encargos en background ni después de que lo interrumpas tú.
- **Escenarios:**
  - Si el archivo cambió después del estreno, `/estreno` se niega.
  - Si cierras la sesión del regidor a la mitad, `/estreno` del mismo plan retoma en la tarea siguiente.
  - El regidor intenta editar un archivo: se le niega y delega.
  - Apruebas la versión A, editas el plan a B y das el OK: `/estreno` se niega porque B no tiene ensayo.
  - El regidor queda libre con dos encargos en background corriendo: reparto no le pide seguir hasta que llegue un aviso.

---

## Fase 3: delegación nativa

Aplica el ADR 0013: los encargos pasan al `subagent` nativo y reparto agrega lo suyo con hooks. `delegar` sobrevive solo dentro de `ensayar`.

**Arnés de desarrollo.** `scripts/run.sh` exporta `REPARTO_DATA_DIR` a un directorio en `/tmp` por defecto: los servidores de desarrollo escribían en el log y la base de producción.

### 3.1 Actor y bajas en hijas nativas

- El hook `prompt` impone el actor en toda sesión con `parentID` cuyo agente sea de reparto: `switchModel` con modelo y variant antes de la primera request. Gana sobre el `model` que pase el padre en `subagent`.
- El hook `retry` ya cubre a las hijas: se dispara con su `sessionID` y el suplente entra igual que en 1.8.
- La continuación con `sessionID` vuelve a pasar por el hook `prompt`, así que la hija retomada también sale con el actor resuelto en ese momento.
- **Escenarios:**
  - El director delega a `prosa` con `subagent` en background: la primera request de la hija sale con el titular de `prosa`, no con el modelo del director.
  - Con una baja de `openai` en SQLite, la hija sale con el suplente.
  - Retomar una hija con `sessionID` conserva su historial y su `parentID`, y sale con el actor resuelto.

### 3.2 Bitácora, `interrumpir` y vigilante de estancados

- `execute.after` registra las tool calls de toda sesión con `parentID` cuyo agente sea de reparto; `bitacora` lee esa tabla y el último mensaje de la hija.
- `interrumpir({ id })` acepta solo hijas cuyo `parentID` sea la sesión que llama.
- Vigilante de estancados por eventos: sin `session.step.*`, `session.tool.*`, `session.text.*` ni `session.reasoning.*` durante 30 min, y sin permiso pendiente, se avisa al padre. Sin filas de estado ni transiciones: el estado de la hija lo da V2.
- **Escenarios:**
  - `bitacora` de una hija nativa de utilero lista los archivos que leyó, también después de compactarla.
  - `interrumpir` con el id de una hija de otra sesión: se rechaza.
  - Una hija sin actividad 30 min: el padre recibe un solo aviso de estancado.

### 3.3 Permisos y guiones

- Director, regidor y `build` tienen `subagent` permitido y `delegar` negado. Papeles y subagentes no tienen ninguno de los dos.
- El guion del director enruta con `subagent` en background y retoma con `sessionID`.
- El guion de papel carga los skills del brief con la tool `skill` antes de empezar, no usa `pty_*` (una llamada a pty que nunca vuelve rompe el transcript en OpenAI) y arranca servidores con `background: true` del shell.
- **Escenarios:**
  - `delegar` no aparece en la lista de tools del director; `subagent` sí.
  - Un papel intenta `subagent`: se le niega.
  - Un brief que nombra `programming`: la primera tool call de la hija es `skill`.
  - Si una hija ignora el skill, se inyecta con el hook `context` (plan B del ADR 0013).

### 3.4 Retiro de avisos, reconciliación y cola

- Se borra para hijas nativas: los avisos visibles de encargo, los avisos de permisos pendientes, la reconciliación al arrancar y la cola por proveedor. Se borra el código muerto que queda en `src/encargos.ts`.
- `ensayar` sigue usando `delegar` sincrónico y sus tablas.
- **Escenarios:**
  - Un encargo termina: el padre recibe solo el `synthetic` nativo, sin aviso de reparto.
  - Una hija pide un permiso: aparece como tarjeta en la vista del padre en OpenChamber y no llega ningún aviso de texto.
  - Un ensayo general completo cierra igual que en 2.2.
  - Con el servidor de desarrollo corriendo, `~/.local/share/reparto/` no cambia.

---

## Después

- **Re-casting** con la tabla por rol del reporte de benchmarks, en una pasada aparte de la migración.
- **Presupuesto de edición** para el director, si la fricción de ADR 0006 molesta en uso real.
- **Integración con Plannotator** para el visto bueno del estreno.
- **grep y glob propios**, solo si los nativos se quedan cortos (ADR 0005).
- **Cola global entre procesos** (en SQLite), si el tope por proceso provoca 429 con TUI y OpenChamber abiertos a la vez.

## Riesgos

- **API de V2 en movimiento**: 2.0.x todavía cambia. Se fija la versión y, en cada upgrade, se hace un diff de tipos del SDK y también un diff del schema de las tools nativas sacado del binario, y se vuelven a correr los escenarios de las rebanadas afectadas. Un grep del binario con nombres de otra tool no sirve como sonda (ADR 0013).
- **Tool bridge de `claude-code`**: S11 pasó con 2.0.16 y `opencode-claude` 0.14.0. Se vuelve a probar con cada upgrade de cualquiera de los dos.
- **Hooks experimentales**: la cuota de `openai` solo se ve en `experimental.ws.receive` (S3). Si ese hook cambia, la baja de OpenAI cae en `plazoBaja` en lugar del reset real.
- **OpenChamber y el agente por defecto**: OpenChamber no usa `AgentEditor.default` y abre en el agente guardado o en `plan` (S10). El director hay que elegirlo una vez a mano; el hook `prompt` igual le impone su actor.
- **Convivencia con OMO en desarrollo**: los nombres de tools y agentes en español no chocan con los de OMO, pero los dos plugins registrarían hooks de sesión sobre las mismas sesiones. Por eso se desarrolla con la config alternativa de S0 hasta el corte.
- **Encargos en background y reinicios**: un encargo vive en el proceso del servidor que lo creó (S15). Si ese servidor se detiene, el encargo muere con él y la reconciliación lo marca `fallido` en el próximo arranque. Un encargo sincrónico cuyo padre murió con el proceso corre la misma suerte.
