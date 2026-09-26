# Sondas de la fase 0

Corridas el 2026-09-25 contra OpenCode `2.0.16` (`opencode v2.0.16`, `ctx.app = { name: "cli", version: "2.0.16", channel: "latest" }`), con el SDK `@opencode/plugin@2.0.15` como referencia de tipos. Horas en UTC.

Montaje: un plugin descartable en `sondas/plugin/index.ts` (sin dependencias: `Plugin.define` es la identidad), cargado junto a `opencode-claude` en un servidor propio (`opencode serve --port 4297`) con la config alternativa de S0. Cada sonda deja una línea JSON en `sondas/log/sondas.jsonl`; las acciones se disparan con el comando `/sonda <acción>` del plugin, llamado por API (`opencode api … session.command`) o desde la TUI en tmux. Los 429, 503 y 401 de Kimi y `claude-code` son **simulados**: el hook `http.response` reemplaza la `Response` (el campo es mutable) por un cuerpo con la forma de cada proveedor. El 429 de OpenAI es real: la cuota semanal está agotada hasta el 2026-09-26 16:30 UTC.

Las pruebas con modelo usaron `kimi-code-plan-global/k3#low`, `claude-code/haiku` y una llamada a `claude-code/claude-opus-5-5#low`.

## Resumen

| # | Resultado | Cambia |
|---|---|---|
| S0 | Sí: `OPENCODE_CONFIG_DIR` + quitar las variables de OpenChamber + servidor propio | — |
| S1 | Sesión libre: hay turno salvo con `resume: false`. Ocupada: `steer` entra en el siguiente paso y `queue` al final, sin ejecución nueva | Plan 1.6 |
| S2 | El plugin queda `failed` con el error en `plugin.list`; los demás arrancan | — |
| S3 | V2 ya clasifica (`provider.quota`, `.rate-limit`, `.internal`, `.auth`). OpenAI va por WebSocket y `http.response` no lo ve. El límite de `claude-code` llega como `rate-limit`. `retry: false` corta el reintento | ADR 0004, plan 1.8 |
| S5 | `bun:sqlite` funciona. `ctx.storage` es compartido pero sin transacciones. Las transiciones atómicas aguantan entre procesos | ADR 0010, plan 1.4 |
| S6 | Sí, con `skills: [{ id }]`: el texto del skill viaja en el mensaje | Plan 1.6 |
| S7 | V2 evalúa cada tramo de `;`, `&&`, `\|` y `$( )`, y oculta las tools negadas. La redirección y `--output` pasan; se cierran en `evaluate` | ADR 0006, plan 1.5 |
| S8 | Lo mejor es `switchModel` dentro de `retry` + `{ retry: true, delay: 0 }`. También sirven `synthetic` tras `failed` y `switchModel` en `prompt`. El variant sale en la request | ADR 0004, plan 1.8 |
| S9 | En `setup` falta lo que registran plugins posteriores; el `model.transform` ve el catálogo completo y se repite en cada `model.updated` | Plan 1.2, 1.9 |
| S10 | Selector: solo primarios; `@`: subagentes no ocultos. `default` vale en la TUI y el servidor, no en OpenChamber. `build` se edita. `agent.model` solo lo aplican la TUI y el `subagent` nativo | Plan 1.5, 1.8, riesgos |
| S11 | Sí, con `haiku` y con `claude-opus-5-5` | — |
| S12 | Sí en la TUI y en `command.list`, que es lo que usa OpenChamber | — |
| S13 | `session.execution.{started,succeeded,failed,interrupted}`, sin `location`. `wait` vuelve igual en los tres; `session.get().outcome` los distingue | ADR 0009, plan 1.6 |
| S14 | Completo antes de compactar; después solo queda el resumen | Plan 1.4, 1.6 |
| S15 | Un `setup` por location y por proceso. Todas las instancias reciben todos los eventos del proceso; los hooks corren solo en la de la sesión, una vez por fallo. Los eventos no cruzan procesos, y una hija cuyo proceso muere queda sin `outcome` | Plan 1.6, riesgos |

---

## S0: config alternativa

**Pregunta.** ¿Se puede correr OpenCode con una config que cargue solo `sondas` y `opencode-claude`, sin tocar `~/.config/opencode/opencode.json` ni dotfiles?

**Resultado.** Sí. V2 reemplaza el directorio de config global por `OPENCODE_CONFIG_DIR` (`Pn.replace(Gg(process.env.OPENCODE_CONFIG_DIR ? {config: …} : {}))` en el binario). Hacen falta tres cosas más:

- Quitar las variables que exporta OpenChamber en cualquier shell hijo: `OPENCODE_CONFIG` apunta a `~/.config/openchamber/opencode.managed.json`, que agrega su propio plugin, y `OPENCODE_PORT`/`OPENCODE_SERVER_PASSWORD` apuntan a su servidor en `:4096`.
- Levantar un servidor propio (`serve --port 4297`). El servidor diario es el `opencode serve --port 4096` de OpenChamber, y `opencode` sin `--server` levanta el service de fondo; cualquiera de los dos cargaría OMO.
- `OPENCODE_CONFIG_PROJECT_DISABLE=1`, y correr en un directorio fuera de `$HOME` (`/tmp/reparto-sondas/a`), porque V2 carga `.opencode/` de cada ancestro y `~/.opencode` es de V1.

Datos, credenciales y base de sesiones siguen siendo los reales (`~/.local/share/opencode/opencode.db`): las sesiones de prueba quedan en tu historial, con títulos que empiezan por `sonda`.

**Evidencia.**

```
$ sondas/run.sh debug paths
config     /home/josuegalre/projects/reparto/sondas/config
db         /home/josuegalre/.local/share/opencode/opencode.db
$ sondas/api.sh plugin.list | jq -c '.data[] | select(.source.type!="builtin")'
{"id":"opencode-claude","source":{"type":"local","path":"/home/josuegalre/projects/opencode-claude/server.js"},"state":{"status":"active"}}
{"id":"sondas","source":{"type":"local","path":"/home/josuegalre/projects/reparto/sondas/plugin/index.ts"},"state":{"status":"active"}}
```

La TUI (`run.sh --server http://127.0.0.1:4297 /tmp/reparto-sondas/a`, ventana tmux `sondas:tui`) abre con `Sonda-Director · Space Bunny Free OpenCode Go`.

**Consecuencia.** El desarrollo de la fase 1 usa este mismo arnés (`run.sh` + `api.sh`), cambiando `sondas/plugin` por `reparto`. Al borrar `sondas/` hay que guardar esos dos scripts en el repo (por ejemplo en `scripts/`).

---

## S1: `session.synthetic`

**Pregunta.** ¿Dispara un turno? ¿Qué hacen `delivery: "steer" | "queue"`, con y sin `resume`, con la sesión libre y ocupada?

**Resultado.**

- El `delivery` por defecto es `steer`.
- **Sesión libre**: sin `resume` o con `resume: true` hay turno; con `resume: false`, no. Da igual el `delivery`.
- **Sesión ocupada**: no se abre una ejecución nueva; el mensaje entra en la que corre. `steer` se entrega en el siguiente límite de paso, así que el modelo lo lee a mitad del trabajo y puede cambiar de rumbo (en la prueba dejó de llamar a `eco` después de la primera llamada). `queue` se entrega cuando la ejecución iba a terminar, como un paso más. `resume: false` no cambia nada con la sesión ocupada.

**Evidencia.** Sesión libre, un caso por sesión nueva (`log/s1.tsv`):

| delivery | resume | ejecuciones |
|---|---|---|
| — | — | 1 |
| steer | — | 1 |
| queue | — | 1 |
| — / steer / queue | true | 1 |
| — / steer / queue | false | 0 |

Sesión ocupada con tres llamadas a `eco` pedidas en serie (`ses_f26c0b799…` con `steer`, `ses_f26c01623…` con `queue`):

```
steer: 15:46:43.537 inbox.enqueued · 15:46:44.330 eco(uno) · 15:46:44.357 step.ended + inbox.delivered · (no llama más a eco) · 15:46:48.928 execution.succeeded
queue: 15:47:24.899 inbox.enqueued · eco(dos) · eco(tres) · 15:47:41.530 step.ended + inbox.delivered · 15:47:48.158 execution.succeeded
```

**Consecuencia.** El aviso de un encargo va con `session.synthetic({ delivery: "queue" })`, sin `resume`: dispara un turno si el padre está libre y, si está ocupado, espera al final sin desviar el trabajo. Hay que pasar `queue` explícitamente, porque el default es `steer`. Plan 1.6 actualizado.

---

## S2: `setup` que lanza

**Pregunta.** ¿Qué pasa si `setup` lanza un error?

**Resultado.** El plugin queda en `state.status: "failed"`, con el error y el stack en `plugin.list`, y el servidor sigue. Los plugins de antes y de después arrancan normal (`sondas.lanza` iba entre `sondas` y `opencode-claude`). En la TUI no se ve nada.

**Evidencia.**

```
{"id":"sondas","state":{"status":"active"}}
{"id":"sondas.lanza","state":{"status":"failed","error":"Error: SONDA S2: setup lanza a propósito\n    at setup (…/sondas/lanza/index.ts:8:15)\n …"}}
{"id":"opencode-claude","state":{"status":"active"}}
```

**Consecuencia.** Ninguna. La regla de que `setup` nunca lanza sigue, porque un plugin `failed` no deja ni siquiera el aviso al director.

---

## S3: 429 y `retry`

**Pregunta.** ¿Cómo se ve un 429 en `http.response` y en `retry` para `openai`, `claude-code` y `kimi-code-plan-global`? ¿Se puede correlacionar por `sessionID`? ¿`{ retry: false }` corta el reintento nativo?

**Resultado.**

1. **V2 ya clasifica el error.** `retry.error` trae `type`, `message` y `status`:

   | Respuesta | `error.type` | `decision` por defecto |
   |---|---|---|
   | 429 `insufficient_quota` / OpenAI `usage_limit_reached` | `provider.quota` | `{ retry: false }` |
   | 429 `rate_limit_exceeded` con `retry-after: 2` | `provider.rate-limit` | `{ retry: true, delay: 2000 }`, después 4217 y 7502 (backoff) |
   | 429 de `claude-code` (`rate_limit_error`, `code: "claude_session_limit"`, `Retry-After: 7200`) | `provider.rate-limit` | `{ retry: true, delay: 900000 }` |
   | 503 | `provider.internal` | `{ retry: true, delay: 2311 }` |
   | 401 | `provider.auth` | `{ retry: false }` |

   `attempt` vale 2 en el primer `retry`: es el número del intento que se haría. El hook se dispara una vez por fallo y la ejecución emite `session.retry.scheduled` con el mismo `attempt`.

2. **OpenAI no pasa por HTTP.** El proveedor `openai` (plan de ChatGPT) usa `wss://chatgpt.com/backend-api/codex/responses`. Ni `http.request` ni `http.response` se disparan; el error llega como un frame en `experimental.ws.receive`, con el reset y los headers adentro.

3. **El límite de `claude-code` llega como velocidad.** El proxy de `opencode-claude` responde a un límite de suscripción con 429 `rate_limit_error` (`src/failure.ts:63-85`), V2 lo clasifica como `provider.rate-limit` y lo reintenta a los 15 min (el `Retry-After` de 7200 s queda recortado a 900 s). Para reparto es una cuota: la distingue el `code: "claude_session_limit"` y el `resets_at` del cuerpo.

4. **Correlación.** En la misma instancia, `http.response` (o `ws.receive`) llega justo antes del `retry` de la misma sesión, con 1-2 ms de diferencia. Alcanza con guardar el último error por `sessionID`.

5. **`{ retry: false }` corta el reintento**: la ejecución pasa directo a `session.execution.failed` con el mismo error.

Los cuerpos de Kimi y `claude-code` son simulados: la forma de `claude-code` es la exacta del proxy, pero la de un 429 real de Kimi sigue sin observarse.

**Evidencia.** OpenAI real (`ses_f26cc8b99…`, 15:35:07):

```
ws.handshake  url=wss://chatgpt.com/backend-api/codex/responses  model={gpt-5.5, openai, variant: low}
s3.ws.receive frame={"type":"error","error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"prolite","resets_at":1790440200,"resets_in_seconds":89692},"status_code":429,"headers":{"X-Codex-Primary-Used-Percent":"100","X-Codex-Primary-Window-Minutes":"10080","X-Codex-Primary-Reset-At":"1790440201",…}}
s3.retry      attempt=2 error={"type":"provider.quota","message":"The usage limit has been reached"} decision={"retry":false}
```

`resets_at: 1790440200` es el 2026-09-26 16:30 UTC (10:30 AM en El Salvador). `claude-code` simulado (`ses_f26c850be…`, 15:38:25):

```
s3.http.error status=429 headers={"retry-after":"7200","x-claude-rate-limit-reset":"2026-09-25T17:38:25.347Z"} body={"error":{"message":"You've hit your limit · limit resets in 2h","type":"rate_limit_error","code":"claude_session_limit",…}}
s3.retry      error={"type":"provider.rate-limit","message":"You've hit your limit · limit resets in 2h","status":429} decision={"retry":true,"delay":900000}
```

Con `retry: false` forzado sobre un 429 de velocidad (`ses_f26c9f16b…`, 15:38:09): `s3.retry decision={"retry":true,"delay":2000} cortar=true` y 13 ms después `session.execution.failed {"type":"provider.rate-limit",…}`.

**Consecuencia.** El clasificador de 1.8 parte del `error.type` de V2 y solo corrige dos cosas: un `provider.rate-limit` cuyo cuerpo trae `claude_session_limit` o un reset lejano es cuota, y para OpenAI el reset sale de `experimental.ws.receive` (`resets_at`), no de los headers HTTP. El hook `ws.receive` es experimental: queda en riesgos. ADR 0004 y plan 1.8 actualizados.

---

## S5: `bun:sqlite` y `ctx.storage`

**Pregunta.** ¿Un plugin de V2 puede importar `bun:sqlite`? ¿`ctx.storage` se comparte entre procesos?

**Resultado.**

- `bun:sqlite` funciona dentro del plugin, en modo WAL.
- `ctx.storage` es un almacén clave-valor global: lo comparten los procesos y las locations. La instancia de `a` del segundo proceso leyó lo que había escrito la de `b` del primero. Solo tiene `get`, `set`, `remove` y `scan`, sin transacciones ni comparar-y-escribir, así que no sirve para las transiciones del ADR 0010.
- La transición atómica `UPDATE … WHERE id = ? AND estado = ?` aguanta dos procesos compitiendo: en tres corridas, cada uno de los 2000 ids tuvo un solo ganador.
- `busy_timeout` se respeta (un proceso esperó 5011 ms antes de fallar), pero SQLite no garantiza turno. Un proceso que escribe 2000 transacciones seguidas sin pausa deja al otro sin entrar hasta que vence el timeout (`SQLITE_BUSY` en el primer `UPDATE`). Con 1 ms entre escrituras, el problema desaparece.

**Evidencia.**

```
16:04:48.835 pid=18538 s5.sqlite  ok=true filas=2400
16:04:48.837 pid=18538 s5.storage previo={"pid":17329,"inst":"w5v7om","dir":"/tmp/reparto-sondas/b"}
carrera cruzada (p2 recorre los ids al revés):
  {"quien":"p2","gane":1046} {"quien":"p1","gane":954}   → [{"ganador":"p1","c":954},{"ganador":"p2","c":1046}]
  {"quien":"p2","gane":1043} {"quien":"p1","gane":957}
  {"quien":"p1","gane":1020} {"quien":"p2","gane":980}
sin pausa: {"quien":"p1","i":0,"code":"SQLITE_BUSY","errno":5,"msg":"database is locked","ms":5011}
```

**Consecuencia.** ADR 0010 se mantiene, con dos notas: `ctx.storage` existe pero no reemplaza a SQLite, y las transacciones de reparto tienen que ser cortas, sin bucles de escritura. Una transición que falla con `SQLITE_BUSY` se reintenta una vez antes de darla por perdida.

---

## S6: `skills` en `session.prompt`

**Pregunta.** ¿El campo `skills` de `SessionPromptInput` carga los skills?

**Resultado.** Sí. El campo es `skills: [{ id }]`, no una lista de strings. V2 mete el texto completo del skill (`<skill_content name="tdd">…`) dentro del mensaje de usuario, y el modelo lo vio. Con la config alternativa, V2 igual carga los skills del usuario (`~/.agents/skills` y demás): `skill.list` devolvió 66. No existe un skill `programming`; la prueba usó `tdd`.

**Evidencia.** `ses_f26bd7c38…`: el mensaje guardado trae `"skills":[{"id":"tdd","name":"tdd","text":"<skill_content name=\"tdd\">\n# Skill: tdd\n\n# Test-Driven Development…"}]`, y la respuesta del modelo, sin llamar tools, fue `# Skill: tdd`.

**Consecuencia.** `delegar` pasa `skills: [{ id }]` en el primer `session.prompt` de la hija. Plan 1.6 actualizado.

---

## S7: permisos de solo lectura

**Pregunta.** ¿Los permisos de V2 imponen bash por patrón y niegan `edit`, `write`, `patch`, `subagent` y `delegar`? ¿Resisten encadenamiento y redirección?

Reglas del agente de prueba `sonda-lector`, agregadas al final de las del default: `shell *` deny; `rg *`, `git status*` y `git diff*` allow; `edit`, `write`, `patch`, `subagent` y `delegar` deny.

**Resultado.**

- Las tools negadas con `*` desaparecen de la lista que ve el modelo: `eco, glob, grep, question, read, shell, skill, webfetch, websearch, execute`.
- V2 parte el comando en tramos y cada tramo tiene que estar permitido. `rg x | rg cambio` pasa con `resources: ["rg x …", "rg cambio"]`. `rg x | head -1`, `sed -i`, el heredoc, `rg x; rm y`, `rg -l x | xargs rm`, `rg x && touch`, `rg x $(touch …)` y `git status; touch …` fallan con `permission.rejected`. `tee` también, por no estar en la lista.
- **La redirección y `--output` pasan**: la redirección queda dentro del tramo, así que `rg x > f` coincide con `rg *`. Los dos archivos se crearon.
- El hook `evaluate` solo corre cuando las reglas dan `allow`: los comandos negados nunca llegan a él. Poner `effect = "deny"` ahí funciona, y el modelo recibe el `message` del hook.
- Desde `execute` (Code Mode) no se llega ni a `shell` ni a `edit`/`write`: `search()` no los devuelve.

**Evidencia.** Ronda 1 (`ses_f26bc3a8e…`) y ronda 2 con el hook (`ses_f26b95e84…`):

```
rg x /tmp/reparto-sondas/a | head -1                     => permission.rejected "Permission denied: shell"
rg x /tmp/reparto-sondas/a; rm /tmp/reparto-sondas/a/y.txt => permission.rejected
rg x … > /tmp/reparto-sondas/a/redir.txt                 => completed (ronda 1, archivo creado)
git diff --output=/tmp/reparto-sondas/a/gitout.txt       => completed (ronda 1, archivo creado)
s7.evaluate resources=["rg x /tmp/reparto-sondas/a","rg cambio"] effect=allow
rg x … > …/redir.txt                                     => permission.rejected "sondas: redirección o --output negada en el hook" (ronda 2)
execute: search({query:"shell"}) → {"items":[]}
```

**Consecuencia.** No hace falta reimplementar el análisis de pipes: V2 lo hace. reparto agrega un hook `evaluate` que, para el director y el regidor, niega los tramos de `shell` que contengan `>`, `<`, `--output` o las opciones de `rg` que ejecutan programas (`--pre`, `--pre-glob`; estas no se probaron). `rg x | head` pasa solo si `head *` está en la lista de lectura. ADR 0006 y plan 1.5 actualizados.

---

## S8: cambio de actor

**Pregunta.** ¿Cómo se cambia de actor después de `session.execution.failed`, dentro del hook `retry` y en el hook `prompt` del mismo turno? ¿Se puede reanudar sin duplicar el mensaje del usuario? ¿Sale el variant en la request?

**Resultado.**

| Caso | Cómo | Resultado |
|---|---|---|
| Dentro de `retry` | `switchModel` + `decision = { retry: true, delay: 0 }` | El reintento sale con el suplente, en el mismo mensaje del asistente, sin mensaje nuevo. |
| Después de `failed` | `switchModel` + `synthetic` (con `resume` por defecto) | Turno nuevo con el suplente; queda un mensaje `synthetic` visible, pero no se duplica el del usuario. |
| Después de `failed` | `switchModel` + `interrupt({ resume: true })` | No hace nada: `{"interrupted": false}` y ningún turno. |
| En `prompt` | `switchModel` dentro del hook | Ese mismo turno sale con el modelo nuevo. |

El variant sale en la request: Kimi lo manda como `reasoning_effort` en el cuerpo, OpenAI como `reasoning.effort` en el frame `response.create`, y `claude-code` en el header `x-opencode-claude-effort`, que en base64 es `{"modelId":"haiku","effort":"low"}`.

**Evidencia.**

```
retry  (ses_f26c70f65…): s3.retry provider.quota decision={retry:false} → s8.retry.switch.ok claude-code/haiku#low
                         → model.request {haiku, claude-code, low} → session.execution.succeeded (un solo mensaje de usuario)
failed (ses_f26c58453…): contexto = user, assistant[], idle, model-switched, synthetic "Retry: …", assistant "OK", idle
interrupt (ses_f26c4d9cb…): accion.interrumpir r={"interrupted":false}; sin execution.started posterior
prompt (ses_f26c49114…): s8.prompt → s8.prompt.switch.ok → model.request {haiku, claude-code, low}
kimi:   http.request cuerpo={"model":"k3",…,"reasoning_effort":"low"}
openai: ws.send frame={"type":"response.create","model":"gpt-5.5",…,"reasoning":{"effort":"low","summary":"auto"}}
```

**Consecuencia.** El reemplazo se hace dentro del hook `retry`: sin prompt nuevo, sin reenviar el mensaje del usuario y sin que la ejecución llegue a `failed`. El camino con `synthetic` queda como reserva, para cuando el suplente se decida después del fallo. El `interrupt` con `resume` no sirve. ADR 0004 y plan 1.8 actualizados.

---

## S9: catálogo

**Pregunta.** ¿Cuándo está completo el catálogo? ¿El plugin ve los modelos de `claude-code` si `opencode-claude` va antes? ¿Llegan `model.updated` y `models-dev.refreshed`?

**Resultado.**

- `ctx.model.list()` en `setup` solo ve lo que registraron los plugins cargados antes. Con `sondas` antes de `opencode-claude`, faltaba `claude-code`; con `opencode-claude` antes, estaban sus 8 modelos.
- El callback de `ctx.model.transform` siempre ve el catálogo completo, sin importar el orden, y además incluye candidatos deshabilitados (`openai`: 55 en el transform contra 15 en `list`).
- El transform se vuelve a correr en cada `model.updated`: al activarse el plugin y después cada ~5 min, junto con `models-dev.refreshed`.

**Evidencia.**

```
orden sondas → lanza → opencode-claude:
15:56:58.148 s9.setup.model.list porProveedor={"opencode-go":32,"opencode":7,"openai":15,"kimi-code-plan-global":4,"google":38,"moonshotai":4}
15:56:59.292 s9.transform        porProveedor={…,"openai":55,"claude-code":8} claude=["fable","opus","sonnet","haiku","claude-fable-5-1","claude-opus-5-5","claude-opus-4-8","claude-sonnet-4-6"]
15:41:53.889 s9.transform · 15:41:53.896 model.updated · 15:41:54.645 s9.transform · 15:41:54.652 model.updated + models-dev.refreshed
15:46:53.919 s9.transform · … · 15:46:55.447 models-dev.refreshed
```

El catálogo real dio además `opencode-go/kimi-k3` con un solo variant (`max`) y `kimi-code-plan-global/k3` con `low`, `high` y `max`.

**Consecuencia.** La validación de actores lee el catálogo dentro de `ctx.model.transform`, sin tocarlo, y se recalcula cada vez que el transform vuelve a correr. El orden en `plugins` deja de importar para esto. Plan 1.2 y 1.9 actualizados.

---

## S10: agentes en la TUI y OpenChamber

**Pregunta.** ¿Cómo se ven los agentes con `mode: "subagent"` y `hidden`? ¿`AgentEditor.default(id)` deja al director por defecto? ¿Se puede editar `build`?

**Resultado.**

- `AgentEditor.update(id, …)` crea el agente si no existe.
- **TUI**: el selector (`/agents`, `shift+tab`) muestra solo primarios (`sonda-director`, `build`, `plan`, `sonda-lector`). `@` ofrece `sonda-sub` y no `sonda-oculto`.
- **OpenChamber** (leído en su código, `@openchamber/web@2.0.1`; no se abrió contra el servidor de sondas para no tocar tu instancia): oculta los `hidden`, el selector muestra solo primarios y `@` usa los visibles que no son primarios. Coincide con la TUI.
- **`default`**: la TUI abre en `Sonda-Director`, y una sesión creada por API sin `agent` corre con `sonda-director`. **OpenChamber no lo usa**: elige el agente guardado, si no `plan` y si no el primer primario visible (`qee` en su bundle).
- **`build`** se puede editar: descripción, permisos (`subagent: deny` quedó al final de la lista) y `model`.
- **`agent.model` no lo aplica el servidor.** Una sesión con `agent: "build"`, creada o cambiada con `switchAgent`, corrió con el modelo por defecto (`opencode-go/space-bunny-free`). Lo aplican la TUI, que al elegir el agente hace el `switchModel` desde el cliente, y el `subagent` nativo (`C ?? B.model ?? S.model` en el binario). OpenChamber usa el modelo guardado o el del compositor.
- `Model.Ref` es un objeto `{ providerID, id, variant? }`. Asignar un string a `agent.model` no da error, pero deja al agente mal formado: `agent.get build` respondió `HTTP 400`.

**Evidencia.**

```
TUI /agents: ● sonda-director · build · plan · sonda-lector        TUI @sond: @sonda-sub
agent.get build → {"description":"The default agent. … [sondas]", …, {"action":"subagent","resource":"*","effect":"deny"}]}
session.create sin agent → model.request agent="sonda-director"
session.create agent=build (con agent.model = k3#low) → model.request model={"id":"space-bunny-free","providerID":"opencode-go"}
TUI → /agents → build: "Build · Kimi K3 Kimi For Coding (kimi.ai) · low" → model.request {k3, kimi-code-plan-global, low}
OpenChamber: const a=t.filter(l=>!l.hidden&&(l.mode==="primary"||l.mode==="all"));return{agent:(a.find(l=>l.name===e)??a.find(l=>l.name==="plan")??a[0])?.name,model:s??o,…}
```

**Consecuencia.** El actor de las sesiones primarias (director y `build`) lo impone reparto en el hook `prompt`, con `switchModel` cuando el modelo de la sesión no es el que resuelve. No alcanza con `agent.model`. En OpenChamber, el director hay que elegirlo una vez a mano. Plan 1.5, 1.8 y riesgos actualizados.

---

## S11: tool bridge de `claude-code`

**Pregunta.** ¿Una tool del plugin le llega a Opus a través del tool bridge de `opencode-claude`?

**Resultado.** Sí. `eco` (registrada con `options: { codemode: false }`) se llamó desde `claude-code/haiku#low` y desde `claude-code/claude-opus-5-5#low`, y los dos devolvieron el resultado.

**Evidencia.** `ses_f26abd247…` y `ses_f26abd0ec…`: `s11.eco input={"texto":"puente"}`, tool part `eco {"texto":"puente"} -> ECO:puente` y texto final `ECO:puente`.

**Consecuencia.** Se levanta el riesgo del tool bridge. Queda una regla que no estaba escrita: las tools de reparto se registran con `options: { codemode: false }`, porque sin eso solo se alcanzan desde `execute` (dato del shim V1, confirmado acá). Plan actualizado.

---

## S12: comando del plugin

**Pregunta.** ¿El comando registrado con `ctx.command.transform(e => e.add({ name, execute }))` aparece en la TUI y en OpenChamber?

**Resultado.** Sí en la TUI: `/son` sugiere `/sonda  Sondas de la fase 0 de reparto`, y al ejecutarlo corre el `execute` del plugin con `{ sessionID, prompt: { text }, delivery: "steer" }`. Si no había sesión, la TUI crea una. En `command.list` figura `{"name":"sonda","description":"Sondas de la fase 0 de reparto"}`, y OpenChamber arma su lista con `command.list` (`listCommands` en su servidor); no se abrió OpenChamber contra el servidor de sondas.

**Consecuencia.** `/estreno` va como comando, y la tool `estrenar` sale del plan.

---

## S13: fin de una ejecución

**Pregunta.** ¿Qué eventos emite 2.0.16 al cerrar una ejecución? ¿`session.wait` vuelve con `failed` e `interrupted`? ¿Qué cuenta como actividad?

**Resultado.**

- 2.0.16 emite `session.execution.started`, `.succeeded`, `.failed` (con `error`) e `.interrupted` (con `reason`). No emite `session.idle` ni `session.status`.
- **Los `session.execution.*` no traen `location`** (0 de 56). Los demás eventos de sesión sí.
- `session.wait` vuelve sin valor en los tres casos, así que no dice cómo terminó. **Solo espera en el proceso que ejecuta la sesión**: llamado desde otro servidor vuelve en 0 ms.
- `session.get` trae `outcome` (`succeeded`, `failed`, `interrupted`, o `null` mientras corre) y `time.idle`. `time.updated` no se mueve con la actividad.
- Actividad: `session.step.started/ended`, `session.tool.called/success/failed`, `session.text.*` y `session.reasoning.*` (incluidos los `delta`) y `session.usage.updated`. Un paso largo sin tools solo emite `delta` entre `text.started` y `text.ended`.

**Evidencia.** Hijas creadas con `create` + `prompt` y un `wait` en paralelo (`log/s13.sids`):

```
succeeded ses_f26bf3216…: execution.started 15:48:18.064 … 3× (step.started, tool.called, tool.success, step.ended) … execution.succeeded 15:48:40.926 · s13.wait.ok ms=22892
failed    ses_f26bf2da5… (openai sin cuota): step.failed + execution.failed 15:48:20.349 · s13.wait.ok ms=1180
interrupted ses_f26bf2943…: step.failed + execution.interrupted {"reason":"user"} 15:48:30.212 · s13.wait.ok ms=9922
session.get → "outcome":"succeeded" / "failed" / "interrupted", "time":{"created":…,"updated":…,"idle":…}
grep session.execution | grep -c '"loc"' → 0 de 56
```

**Consecuencia.** El fin se detecta con los `session.execution.*`, filtrando por `sessionID` (no hay `location`). El resultado sale de `session.get().outcome`. `wait` sirve solo en modo sincrónico, dentro del mismo proceso, y siempre seguido de `session.get`. La actividad para marcar un encargo estancado se toma de los eventos de paso, tool, texto y razonamiento, incluidos los `delta`. El fallback del plan, que miraba el timestamp de `session.get`, no funciona. ADR 0009 y plan 1.6 actualizados.

---

## S14: `session.context` como bitácora

**Pregunta.** ¿`session.context` devuelve las tool calls de la hija con argumentos y resultados completos, también después de una compactación?

**Resultado.** Antes de compactar, sí: cada parte `tool` trae `state.input` y `state.content` completos. **Después de compactar, no**: `session.context` devuelve solo el mensaje `compaction` (con `summary`) y el `idle`. Las tool calls ya no se pueden leer. `execute.after` sí las vio todas, también en la hija.

**Evidencia.** `ses_f26bf3216…`:

```
antes:   eco {"texto":"alfa"} → ECO:alfa · eco {"texto":"beta"} → ECO:beta · read {"path":"/tmp/reparto-sondas/a/nota.txt"} → …
compact: session.compaction.started 15:49:24.037 → session.compaction.ended 15:49:33.111
después: [{"type":"compaction","summary":"## Objective\n- Run two `eco` tool calls …"},{"type":"idle"}]
tool.after ×3 sessionID=ses_f26bf3216… agent=sonda-sub (eco, eco, read)
```

**Consecuencia.** `bitacora` se arma desde el principio con un registro propio en SQLite, alimentado por `ctx.tool.hook("execute.after")`. Deja de ser el plan B. Plan 1.4 (tabla nueva) y 1.6 actualizados.

---

## S15: procesos, locations y hooks

**Pregunta.** ¿Cuántas veces corre `setup` por servidor? ¿Cada instancia recibe los eventos de todas las locations? ¿Cuántas veces se dispara `retry` por fallo?

**Resultado.**

- `setup` corre **una vez por location y por proceso**. Abrir `/tmp/reparto-sondas/b` en el mismo servidor levantó una segunda instancia (`w5v7om`); el segundo servidor, otra (`4bqk8n`, pid 18538). El módulo del plugin se comparte entre locations y recargas del mismo proceso: el estado a nivel de módulo sobrevive a una recarga por cambio de config, pero no a una por cambio del archivo del plugin.
- **Cada instancia recibe los eventos de todas las locations del proceso**: las instancias de `a` y de `b` vieron cada evento de una sesión de `b`.
- **Los hooks** (`retry`, `http.*`, `prompt`, `context`, `model.request`) **corren solo en la instancia de la location de la sesión**, una vez por fallo.
- **Los eventos no cruzan procesos**: el segundo servidor no recibió ningún evento de una sesión que corría en el primero.
- **Si muere el proceso que ejecuta una hija**, la hija queda con `outcome: null`, sin `time.idle` y con la respuesta a medias. Reiniciar ese servidor no la recupera, y `wait` desde otro proceso vuelve en el acto.
- `session.create` toma la location del cuerpo (`location: { directory }`). El header `x-opencode-directory` no la cambia: sin cuerpo, la sesión cae en la location del servidor.

**Evidencia.**

```
16:02:58.751 pid=17329 inst=w5v7om setup dir=/tmp/reparto-sondas/b      (a seguía en su instancia)
16:04:47.846 pid=18538 inst=4bqk8n setup dir=/tmp/reparto-sondas/a      (segundo servidor, :4298)
sesión de b ses_f26b0d491…: q4ttsg (a) y w5v7om (b) reciben inbox.*, execution.started, retry.scheduled…
                            solo w5v7om: http.request ×2, model.request ×2, s3.http.error, s3.retry ×1, s8.prompt
sesión del proceso 1 ses_f26c9f16b…: pid 17329 ×2 instancias; pid 18538: 0 eventos
proceso muerto ses_f26a3c0d7…: {"outcome":null,"time":{"created":1790353096505,"updated":1790353096683}}; contexto = user, assistant[reasoning,text]; esperar → ms=0
```

**Consecuencia.** Hay que cambiar tres cosas del plan:

- El filtro "por la `location` de sus encargos" no sirve para `session.execution.*`. Cada instancia filtra por `sessionID` contra la tabla `encargos` y avisa solo si gana la transición. Como todas las instancias del proceso reciben el evento, la transición atómica es la que evita el aviso doble.
- Un encargo vive en el proceso que lo creó. Si ese proceso muere, el encargo muere con él, y nadie más recibe sus eventos. `encargos` guarda el `pid`, y la reconciliación marca `fallido` ("perdido en reinicio") todo encargo sin `outcome` cuyo proceso ya no existe.
- El escenario de 1.6 "cerrar una [de TUI u OpenChamber] no impide que la otra avise" partía de una premisa falsa. Se reescribió: cerrar un cliente (la TUI) no detiene el servidor ni el encargo; detener el servidor que lo ejecuta sí.

Plan 1.4, 1.6 y riesgos actualizados.

---

## Lo que quedó sin probar

- Un 429 real de Kimi y uno real de `claude-code`: solo se simularon sus formas. El clasificador se ajusta con la primera baja real, como ya decía el plan.
- OpenChamber contra el servidor de sondas (S10, S12): se leyó su código en lugar de apuntarlo a otro servidor, para no tocar tu instancia diaria.
- `rg --pre` y `--pre-glob`: se agregan a la regla del hook sin haberlos probado.
- Compactación automática por límite de contexto: se probó solo `session.compact` por API.

---

## Revalidación 2.0.18

El 2026-09-26, al arrancar la fase 1, el binario ya era `opencode v2.0.18` (también el servidor diario de OpenChamber). `sondas/` se había borrado antes de notar el upgrade, así que las sondas no se volvieron a correr. En su lugar:

- **Diff de tipos 2.0.16 → 2.0.18** (`npm pack` de `@opencode/plugin`, `@opencode/schema` y `@opencode/client`). Todo es aditivo:
  - `schema`: `session.shell.started` y `session.shell.ended` ganan un `signal` opcional.
  - `plugin`: solo cambia `tui/context.d.ts` (`model.current()` de la TUI).
  - `client`: `server.pair` y `server.connect`.
  - Nada toca `session.execution.*`, `retry`, `permission.evaluate`, `model.transform`, `synthetic`, `http.response` ni el `ctx.session` del plugin.
- reparto fija el SDK en `2.0.18` exacto.
- Cada sonda se da por confirmada en 2.0.18 cuando la confirma un escenario de una rebanada contra el servidor real. Si un escenario la contradice, se para.

| Sonda | Confirmada en 2.0.18 por |
|---|---|
| S1 | — |
| S3 | — |
| S7 | — |
| S8 | — |
| S9 | — |
| S10 | — |
| S13 | — |
| S14 | — |
| S15 | — |
