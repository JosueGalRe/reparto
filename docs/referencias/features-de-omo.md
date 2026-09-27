# Features de OMO que usas

Datos de 2026-09-24. Fuentes:

- `~/.local/share/opencode/opencode.db`, tablas `session_v2` y `session_message`, últimos 60 días: 1,058 prompts tuyos y ~15k mensajes de asistente.
- `/tmp/oh-my-opencode.log`: solo cubre del 23 al 25 de septiembre. Sus conteos sirven para ver qué hooks se disparan, no cuánto se usan.
- `~/dotfiles/omo/omo.jsonc` y `packages/omo-opencode/src/tools/`.

Los conteos incluyen esta sesión.

## Núcleo: lo usas mucho

| Feature                                                           | Evidencia (60 días)                                                                                                | Nota                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sisyphus como orquestador principal                               | 49 de ~80 sesiones top-level; 9,435 mensajes                                                                       | Es casi tu única puerta de entrada                                                                                                                                          |
| Subagentes de consulta: `oracle`, `momus`, `explore`, `librarian` | Sesiones hijas: explore 51, oracle 48, momus 37, librarian 15 (+5 top-level)                                       | oracle, momus y librarian van casi siempre en background                                                                                                                    |
| `task` / delegación con `subagent_type`                           | 245 llamadas: oracle 47, explore 49, momus 37, librarian 21, metis 4                                               |                                                                                                                                                                             |
| Background tasks + notificaciones                                 | `background_output` 136, `background_cancel` 7; log `[background-agent]` 2,671                                     | Las notificaciones `[BACKGROUND TASK RESULT READY]` son de aquí                                                                                                             |
| Categorías → Sisyphus-Junior                                      | 47 sesiones hijas de SJ; `deep` 14, `unspecified-high` 14, `visual-engineering` 13, `quick` 7, `writing` 2         | `ultrabrain`, `artistry` y `unspecified-low`: 0 usos                                                                                                                        |
| Hashline edit (`edit` con LINE#ID)                                | 2,638 llamadas                                                                                                     | La tool más usada después de bash/read                                                                                                                                      |
| `grep` / `glob` propios de OMO                                    | 920 / 281                                                                                                          | Reemplazan a los nativos                                                                                                                                                    |
| Fallback de modelos por cuota                                     | log `[runtime-fallback]` 1,837, `[model-fallback]` 100                                                             | Hoy lo necesitaste con el semanal de OpenAI                                                                                                                                 |
| Continuación: todo enforcer + boulder                             | `[todo-continuation-enforcer]` 4,639, `[atlas]` 5,381; 9 `BOULDER CONTINUATION` y 6 `TODO CONTINUATION` inyectados |                                                                                                                                                                             |
| Preservar agente/modelo en compactación                           | `[compaction-context-injector]` 2,959; 7 "restore checkpointed session agent configuration"                        |                                                                                                                                                                             |
| Skill loader                                                      | `skill` 149                                                                                                        | Casi todo son skills tuyos (`openchamber-change-discipline`, `programming`, `ui-api-decoupling`…). De OMO solo: `git-master` 18, `ulw-plan` 4, `frontend` 3, `start-work` 2 |

## Uso ocasional

| Feature                                             | Evidencia (60 días)                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Flujo de planes: Prometheus → `/start-work` → Atlas | Prometheus: 680 mensajes, 2 sesiones top-level; Atlas: 304 mensajes; `start-work` mencionado 2 veces; 1 plan en `~/.omo/plans`        |
| `multimodal-looker` / `look_at`                     | 27 sesiones hijas + 6 top-level; `look_at` 33                                                                                         |
| `lsp_diagnostics`                                   | 142 (el resto de las tools LSP: 3)                                                                                                    |
| `interactive_bash` (tmux)                           | 48                                                                                                                                    |
| Tools de sesión (`session_list/read/search/info`)   | 45                                                                                                                                    |
| Keyword `ulw` / `ultrawork`                         | 10 de 1,058 prompts                                                                                                                   |
| Metis                                               | 4 sesiones hijas, 35 mensajes                                                                                                         |
| Hooks sin tool visible                              | `non-interactive-env`, `tool-pair-validator`, `write-existing-file-guard`, `comment-checker`, `think-mode`, `category-skill-reminder` |

## Sin uso: candidatos a no reimplementar

| Feature                                                             | Evidencia                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Team mode                                                           | Activo en config, pero 0 llamadas a `team_*`                             |
| Hephaestus                                                          | 1 mensaje en 60 días                                                     |
| `ulw-loop`, `ralph-loop`, `init-deep`, `stop-continuation`          | 0                                                                        |
| `skill_mcp`, ast-grep                                               | 0                                                                        |
| `call_omo_agent`                                                    | 6                                                                        |
| Categorías `ultrabrain`, `artistry`, `unspecified-low`, `deep-high` | 0                                                                        |
| Profile `cursor`                                                    | 0 mensajes con `cursor-acp/*`                                            |
| Visualización en tmux                                               | Desactivada en config                                                    |
| Harnesses Codex / Senpi, binario nativo                             | No los usas; son la mitad del build y la causa de los choques en el pull |

## No es OMO: no hay que reimplementarlo

- MCPs y plugins aparte: Plannotator, OpenChamber, context7, exa, chrome-devtools, railway, codegraph.
- Tools nativas de OpenCode: `bash`, `read`, `write`, `webfetch`, `todowrite`, `question`, y el `subagent` nativo de V2 (15 usos).
- Tus skills propios.
- OpenCode V2 ya inyecta `AGENTS.md` de forma nativa; OMO desactiva su propio injector cuando lo detecta.

## Qué modelos corren de verdad (mensajes de asistente, 60 días)

`kimi-for-coding/k3` 7,563 · `claude-code/claude-opus-5-5` 3,883 · `openai/gpt-5.6-sol` 1,552 · `openai/gpt-5.6-terra` 376 · `opencode-go/kimi-k2.7-code` 361 · `kimi-for-coding/k3-256k` 328 · `google/gemini-3.1-pro-preview` 298 · el resto por debajo de 230.

K3 por el provider viejo `kimi-for-coding` fue el que más trabajó. La config actual ya no lo usa: ahora va por `kimi-code-plan-global`.

## Borrador para decidir tu versión (otra sesión)

**Mínimo que cubre el ~95% de tu uso:**

- Un orquestador (Sisyphus), 4 subagentes de consulta y un ejecutor para categorías.
- `task` con background y notificaciones.
- Cadenas de fallback por cuota, con **un solo lugar** que decida modelo y nivel, validado contra el catálogo de V2 (sin heurísticas).
- Hashline edit, grep y glob.
- Continuación de todos.
- Preservar el agente al compactar.
- Carga de skills.

**Segunda ola, si la extrañas:** Prometheus/Atlas con planes, `look_at`, `interactive_bash`, tools de sesión, `ulw`.

**Riesgos y decisiones abiertas:**

- Licencia: OMO es `SUL-1.0`. Para uso personal puedes modificarlo, pero si publicas o distribuyes tu versión, revisa antes las condiciones. Esto pesa si copias prompts.
- Los prompts de los agentes son el valor real de OMO y lo más caro de rehacer bien, sobre todo los que están afinados por familia de modelo.
- Hay que decidir si empezar de cero como plugin nativo de V2 (sin el shim) o recortar un fork de OMO.

## Historial completo (17 de mayo – 24 de septiembre)

Cobertura: 53,021 mensajes, 3,514 prompts tuyos, 170 sesiones top-level y 1,426 hijas.

Septiembre casi no tiene sesiones hijas (18). Puede ser un cambio real en cómo trabajas, o que desde el paso a OpenCode V2 y al provider `claude-code` las delegaciones se registren de otra forma. No lo verifiqué.

### Por mes

| Mes | Prompts | Top-level | Hijas | `task` | `task` con categoría | `edit` | `team_*` | ast-grep | `lsp_diagnostics` | Prompts con `ulw` |
| --- | ------- | --------- | ----- | ------ | -------------------- | ------ | -------- | -------- | ----------------- | ----------------- |
| May | 1,200   | 43        | 544   | 507    | 358                  | 2,121  | 213      | 116      | 969               | 0                 |
| Jun | 91      | 6         | 26    | 18     | 14                   | 10     | 57       | 0        | 1                 | 0                 |
| Jul | 1,339   | 46        | 639   | 529    | 245                  | 4,002  | 107      | 0        | 113               | 86                |
| Ago | 596     | 21        | 199   | 216    | 43                   | 1,629  | 0        | 0        | 57                | 9                 |
| Sep | 288     | 54        | 18    | 12     | 1                    | 432    | 0        | 0        | 85                | 0                 |

Sesiones por agente y mes (top-level + hijas):

| Mes | Sisyphus-Junior | oracle | explore | librarian | momus | metis | Prometheus | Atlas | multimodal-looker |
| --- | --------------- | ------ | ------- | --------- | ----- | ----- | ---------- | ----- | ----------------- |
| May | 343             | 34     | 63      | 14        | 35    | 9     | 3          | 4     | 46                |
| Jun | 17              | 0      | 7       | 2         | 0     | 0     | 0          | 0     | 0                 |
| Jul | 250             | 78     | 30      | 59        | 61    | 57    | 0          | 7     | 96                |
| Ago | 42              | 44     | 48      | 9         | 37    | 4     | 2          | 7     | 8                 |
| Sep | 1               | 0      | 3       | 5         | 0     | 0     | 0          | 0     | 6                 |

### Qué cambia respecto a los 60 días

- **Team mode no es algo que nunca usaste: lo usaste y lo dejaste.** Hubo 377 llamadas a `team_*` entre mayo y julio, y cero desde agosto.
- **Las categorías fueron tu motor principal.** Suman 652 sesiones de Sisyphus-Junior: `quick` 201, `unspecified-high` 180, `visual-engineering` 120, `deep` 65, `unspecified-low` 44, `writing` 16, `ultrabrain` 14. La única que nunca usaste es `artistry`. Desde agosto cayeron fuerte (43) y en septiembre casi desaparecen (1).
- **El flujo de planes pesaba mucho más.** Prometheus tiene 2,778 mensajes y Atlas 2,165, con 11 sesiones top-level de Atlas. `start-work` aparece en 20 prompts, y hubo 31 `BOULDER COMPLETE` y 15 `BOULDER CONTINUATION`.
- **`ulw` fue una fase de julio:** 86 de sus 102 prompts. También usaste los modos `search-mode` (22) y `analyze-mode` (19) del keyword detector.
- **ast-grep solo se usó en mayo** (116 llamadas). `lsp_diagnostics` cayó de 969 en mayo a menos de 120 por mes.
- **Metis y multimodal-looker tuvieron su pico en julio**, con 57 y 96 sesiones.
- **Siguen sin uso real:** Hephaestus (53 mensajes en total), `skill_mcp` (11), `call_omo_agent` (50), `ralph-loop` / `ulw-loop` (0–1) e `init-deep` (3).
- **Skills de OMO en todo el historial:** `git-master` 84, `ulw-plan` 15, `ai-slop-remover` / `remove-ai-slops` 15, `ulw-research` 10, `review-work` 7, `frontend` 5, `team-mode` 3.

### Modelos en todo el historial

`kimi-for-coding/k3` 11,870 · `opencode-go/kimi-k2.6` 7,579 · `opencode-go/kimi-k2.7-code` 7,316 · `openai/gpt-5.5` 3,903 · `claude-code/claude-opus-5-5` 3,888 · `openai/gpt-5.4-mini` 3,208 · `openai/gpt-5.6-sol` 2,531 · `openai/gpt-5.4-mini-fast` 2,493 · `google/gemini-3.1-pro-preview` 2,035.

La familia Kimi suma ~28.5k de ~48.6k mensajes de asistente (59%).

### Qué implica para tu versión

- Lo que usas en septiembre es todavía menos que lo de los 60 días: casi todo es Sisyphus directo, con poca delegación.
- Categorías, planes (Prometheus/Atlas) y team mode fueron centrales hasta julio.

### Por qué cayeron las categorías

No fue por V2 ni por la plomería de `claude-code`:

- V2 empezó el 23 de septiembre, y la caída ya se veía en julio y agosto con V1.
- La única tarea con categoría que se lanzó en V2 (`visual-engineering`, 24 de septiembre) terminó bien.

La caída sigue al modelo que manejaba a Sisyphus:

| Periodo | Modelo de Sisyphus            | Sesiones | Tareas con categoría | Por sesión |
| ------- | ----------------------------- | -------- | -------------------- | ---------- |
| May     | `opencode-go/kimi-k2.6`       | 36       | 218                  | 6.1        |
| Jul     | `opencode-go/kimi-k2.7-code`  | 8        | 48                   | 6.0        |
| Jul     | `kimi-for-coding/k3`          | 26       | 14                   | 0.5        |
| Ago     | `kimi-for-coding/k3`          | 12       | 2                    | 0.2        |
| Sep     | `claude-code/claude-opus-5-5` | 11       | 1                    | 0.1        |

Opus sigue delegando consultas a oracle, explore y librarian (26 delegaciones en esas 11 sesiones), pero la implementación la hace él mismo.

Cada modelo carga su propio prompt de Sisyphus (`agents/sisyphus/*.ts`). Todos incluyen la guía de categorías, pero los más nuevos empujan más a hacerlo uno mismo. El de Opus 5 (agregado el 2026-07-25) tiene una regla explícita, `OVER-DELEGATION`: "Work you can finish in a handful of tool calls → do it yourself".

Implicación para tu versión: las categorías funcionan como concepto, pero que se usen depende del prompt del orquestador. Si quieres que Opus reparta trabajo, la regla de ruteo tiene que ser explícita (qué tipo de tarea va a qué categoría), no quedar a criterio del modelo. También cuenta el costo: si Opus hace él mismo lo que podría resolver un modelo barato, gasta cuota de Claude.
