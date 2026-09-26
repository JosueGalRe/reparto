# El catálogo V2 decide qué effort corre

Fecha: 2026-09-24. En tu setup (OpenCode v2.0.16 con OMO cargado a través del shim `opencode-v1-compat`), un nivel de reasoning solo tiene efecto si coincide exactamente con un variant que V2 genera desde el catálogo de models.dev para ese provider/model. Si no coincide, V2 lanza `VariantUnavailableError` y el turno muere. Si OMO no logra traducirlo con su registro heurístico, que está desactualizado respecto al catálogo de septiembre, lo descarta y corre el default del proveedor. Con esa regla, Claude (vía claude-code), OpenAI, Gemini, DeepSeek y GLM-5.3 reciben el effort que configuraste. En cambio, **`opencode-go/kimi-k3` en `low` falló 30 veces en tus logs**, K3 en el plan de Kimi Code probablemente corre en `high` aunque pidas `max`, el `off` de Kimi HighSpeed nunca apaga el thinking, y el `max` de MiniMax M3 y de MiMo no existe como variant. En los benchmarks, las curvas se aplanan en los niveles altos. Opus 5.5 gana +1.6 puntos AA de `xhigh` a `max` por 1.73× el costo. Fable 5.1 empata `xhigh` y `max` (53.2 vs 53.4). GPT-6 Astra empata `high`, `xhigh` y `max` en el Terminal-Bench 4.0 oficial (57.88 / 57.88 / 58.18). La excepción es GPT-6 Sol, que sube 3.4 puntos y 13.6 en TB4 al pasar a `max`. En los niveles bajos pasa lo contrario: GPT-6 Luna en `low` saca 0% en TB4 y 2.4% en DeepSWE. Entre modelos, Opus 5.5 supera a Fable 5.1 en cada nivel y cuesta menos por tarea. GPT-6 Sol empata a GPT-5.6 Sol a la mitad del costo, con una tasa de no-alucinación 4.7× mayor. MiMo V2.6 Pro empata a Grok 4.7 en el índice AA a 1/20 del costo. El reporte cierra con una tabla de evidencia por rol y la lista, ordenada por impacto, de las entradas de `omo.jsonc` que hoy no hacen nada o fallan. No apliqué ningún cambio.

## Solo los variants del catálogo V2 llegan al proveedor

Lo que tienes instalado es OpenCode v2.0.16, un bundle compilado con Bun, no el `transform.ts` de V1. OMO no habla directo con V2: pasa por el shim `opencode-v1-compat` ([opencode.json:52-64](file:///home/josuegalre/dotfiles/opencode/opencode.json)), y eso define qué parte de tu `reasoning` sobrevive. Hay dos caminos.

En el **path A**, el default de cada agente, OMO copia `reasoning` tal cual a `agent.variant` ([agent-overrides.ts:52-54](file:///home/josuegalre/projects/oh-my-openagent/packages/omo-opencode/src/agents/builtin-agents/agent-overrides.ts)), y el shim lo convierte en la referencia `provider/model#variant` ([config.ts:46-70](file:///home/josuegalre/projects/opencode-v1-compat/src/config.ts)).

El **path B** cubre los fallbacks de runtime, los prompts de categoría vía delegate-task, call-omo-agent y team-mode. Ahí OMO llama a `lowerReasoningForModel()`. La función devuelve `{variant}` solo si el nivel está en la lista de variants que OMO cree que tiene el modelo. Si no está, devuelve `{reasoningEffort}`, con `off` traducido a `"none"` ([agent-variant.ts:28-49](file:///home/josuegalre/projects/oh-my-openagent/packages/omo-opencode/src/shared/agent-variant.ts)). Esa lista sale del registro heurístico de familias por dos razones: en tu máquina no existe el cache `provider-models.json`, y OMO no sabe leer la forma `[{id:"max"}]` en que V2 expone sus variants ([runtime-model-readers.ts:13-34](file:///home/josuegalre/projects/oh-my-openagent/packages/model-core/src/model-capabilities/runtime-model-readers.ts)).

Los cambios que OMO hace después sobre `message.variant` en `chat.params` se pierden. El shim le entrega un objeto `message` nuevo y solo copia de vuelta `output.options` ([session.ts:74-84](file:///home/josuegalre/projects/opencode-v1-compat/src/session.ts)). Por eso, un `reasoningEffort` suelto termina como `providerOptions.reasoningEffort`, un campo plano que los builders nativos no usan, porque ellos escriben en `settings`. Nadie ha verificado qué efecto tiene ese campo.

Del lado de V2 la regla es estricta. V2 arma los variants de cada modelo a partir del campo `reasoning_options` del catálogo, con un builder por paquete:

- **OpenAI Responses**: manda `{reasoningEffort, reasoningSummary:"auto", include:["reasoning.encrypted_content"]}`.
- **Anthropic**: manda `thinking:{type:"adaptive"}` más `effort`, o solo el toggle `none`/`thinking`.
- **Google**: manda `thinkingConfig.thinkingLevel`.
- **openai-compatible genérico**: solo entiende `effort`, e ignora `toggle` y `budget_tokens`.

Cuando llega un id que no está en la lista, `ModelResolver` lanza **`SessionRunnerModel.VariantUnavailableError`** y el turno muere. No hay clamp ni fallback genérico, y un modelo con `reasoning_options: []` no tiene ningún variant. La evidencia está en el bundle de v2.0.16, offsets @144837626–144846380 y @~144273588 de [`~/.opencode/bin/opencode`](file:///home/josuegalre/.opencode/bin/opencode).

Para Claude, tu plugin `opencode-claude` registra los ids `low`…`max` y traduce el elegido al header `x-opencode-claude-effort`. El proxy local abre la query del Agent SDK con ese `effort` y thinking adaptativo. Los requests de metadatos (títulos, compaction) van con thinking desactivado y sin effort ([v2.ts:101-172](file:///home/josuegalre/projects/opencode-claude/src/v2.ts); [proxy.ts:1051-1058](file:///home/josuegalre/projects/opencode-claude/src/proxy.ts); [query.ts:195-203](file:///home/josuegalre/projects/opencode-claude/src/query.ts)).

El problema es que el registro heurístico de OMO está desfasado del catálogo de septiembre en las dos direcciones ([model-capability-heuristics.ts:15-142](file:///home/josuegalre/projects/oh-my-openagent/packages/model-core/src/model-capability-heuristics.ts)):

- No conoce `xhigh` en Claude ni en Grok.
- No reconoce `k3` como Kimi, porque el patrón `/(?:kimi|k2…)/` no lo captura.
- Supone low/medium/high para Kimi, cuando `opencode-go/kimi-k3` solo tiene `max`.
- Supone low/medium/high para MiniMax, cuando V2 solo ofrece `none`/`thinking`.

El resultado va en ambos sentidos. Algunos niveles válidos se degradan a "sin variant" y corre el default del proveedor. Algunos inválidos se emiten como variant y revientan. Lo segundo ya pasó: **30 errores `Variant unavailable for opencode-go/kimi-k3: low`** entre 2026-09-24T03:29Z y 2026-09-25T04:06Z, y ningún otro par modelo/variant falló ([opencode.log](file:///home/josuegalre/.local/share/opencode/log/opencode.log), líneas 20092–130524).

Hay un matiz que complica el cuadro. Una delegación de categoría registrada lanzó `claude-fable-5-1` con `variant:"max"` intacto, aunque la heurística de Fable no incluye `max` ([oh-my-opencode.log:11171](file:///tmp/oh-my-opencode.log)). Al menos ese caller pasa el valor crudo. Tampoco está trazado cómo llegan tus entradas `models: [{model, reasoning}]` al payload del runtime fallback. Ese payload prefiere `agentSettings.variant`, que es el `reasoning` crudo del agente, antes que el valor bajado ([retry-model-payload.ts:13-18](file:///home/josuegalre/projects/oh-my-openagent/packages/omo-opencode/src/hooks/runtime-fallback/retry-model-payload.ts)). Si ese orden aplica a tus cadenas, un fallback podría recibir el nivel del agente en vez del de su entrada. Por ahora los logs solo muestran el caso de kimi-k3.

El hook `think-mode` agrega otro riesgo, aún no observado: fuerza `#high`, un variant que no existe en kimi-k3 de Go, MiniMax, Qwen 3.7 Plus ni MiMo ([think-mode/hook.ts:60](file:///home/josuegalre/projects/oh-my-openagent/packages/omo-opencode/src/hooks/think-mode/hook.ts)).

La tabla resume qué niveles existen en cada proveedor, cuáles genera V2 y qué pasa con lo que tienes configurado. Las columnas de variants salen de tu snapshot [`~/.cache/opencode/models.json`](file:///home/josuegalre/.cache/opencode/models.json) (mtime 2026-09-23). Los niveles reales de cada proveedor salen de su documentación, citada en las secciones siguientes.

| Provider/model | Niveles reales del proveedor (default) | Variants que genera V2 | Lo configurado y qué le pasa |
|---|---|---|---|
| `claude-code/claude-opus-5-5` | low–max, thinking siempre on (medium) | low, medium, high, xhigh, max | `xhigh` como primario aplica vía header. `low` aplica. Como fallback, `xhigh` puede caer al default `medium` (incierto) |
| `claude-code/claude-fable-5-1` | low–max, thinking siempre on (high) | low…max | `xhigh`/`max` como primario aplican. El log muestra `max` aplicado en una categoría. `low` aplica |
| `openai/gpt-6-astra` | low–max; `none` da HTTP 400 (sin default publicado) | low…max | `high`, `xhigh` y `max` aplican |
| `openai/gpt-6-sol`, `gpt-6-sol-fast` | none–max (medium) | none…max; `-fast` agrega `service_tier:"priority"` | `medium` aplica |
| `openai/gpt-6-luna-fast` | none–max (medium) | none…max + priority | `low` aplica |
| `openai/gpt-5.6-sol` | none–max (medium) | none…max | `low`, `medium` y `xhigh` aplican. `max` como fallback de ultrabrain queda incierto |
| `openai/gpt-5.6-terra` | none–max (medium) | none…max | `high` aplica |
| `kimi-code-plan-global/k3` | low/high/max; default del plan `high`; `none` reenruta a K2.8 Preview sin thinking | low, high, max | En path B, `max` y las entradas sin nivel se descartan y corre `high` |
| `kimi-code-plan-global/kimi-for-coding-highspeed` | K2.7 Code HighSpeed, thinking siempre on, sin effort | ninguno | `off` no tiene efecto |
| `opencode-go/kimi-k3` | low/high/max (default Moonshot `max`) | **solo max** | `max` aplica. `low` falla (observado), `medium` fallaría y `xhigh` heredado se descarta |
| `opencode-go/glm-5.3` | low/high/max, siempre piensa (max) | low, high, max | `max` aplica |
| `opencode-go/glm-5.2` | off/high/max; low/medium→high, xhigh→max (max) | high, max | El `xhigh` heredado se descarta y corre el default |
| `opencode-go/deepseek-v4-pro` | low/high/max; xhigh→high (high en DeepSeek, max en Alibaba) | high, max | `max` aplica |
| `opencode-go/deepseek-v4-flash` | low/high/max (high) | low, high, max | `max` aplica |
| `opencode-go/qwen3.7-plus` | thinking on + `thinking_budget` (máx. 262,144) | ninguno | El `off` heredado se descarta: piensa con presupuesto máximo |
| `opencode-go/qwen3.8-flash` | low/medium/xhigh; max/high→xhigh (xhigh) | none, low, medium, xhigh | Sin nivel corre `xhigh` |
| `opencode-go/minimax-m3` | toggle adaptive/disabled, sin effort (off en la API de MiniMax) | none, thinking | `max` no existe. El `medium` heredado fallaría |
| `opencode-go/minimax-m2.7` | siempre piensa | ninguno | El `off` heredado no tiene efecto |
| `opencode-go/mimo-v2.6-pro` | thinking on/off, sin profundidad (on) | ninguno | `max` no existe: según el caller, error o no-op |
| `opencode-go/grok-4.7` | low/medium/high/xhigh, no se apaga (high) | low, medium, high, xhigh | `xhigh` es válido si llega crudo. Si OMO lo baja, corre `high` |
| `google/gemini-3.1-pro-preview` | low/medium/high, no se apaga (high) | low, medium, high | `high` aplica y es igual al default |
| `google/gemini-3.6-flash` | minimal/low/medium/high (medium) | minimal…high | `low` aplica. Con el `off` heredado corre `medium` |

## Anthropic: `xhigh` es el techo útil y Fable no justifica su precio

Anthropic documenta cinco niveles para Opus 5.5 y Fable 5.1: `low`, `medium`, `high`, `xhigh` y `max`. En los dos, el thinking adaptativo está siempre encendido. En Opus 5.5, `thinking:{type:"disabled"}` devuelve 400, así que effort es el único control de profundidad ([Effort docs](https://platform.claude.com/docs/en/build-with-claude/effort); [What's new in Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5)). El default es **`medium` en Opus 5.5 y `high` en Fable 5.1**, tanto en la API como en Claude Code. En Claude Code, además, el `effortLevel` global de settings no aplica a Opus 5.5 ([Claude Code model config](https://code.claude.com/docs/en/model-config)). Anthropic reserva `xhigh` para "long-running agentic and coding tasks (over 30 minutes)" y describe `max` como gasto sin restricción. Claude Code agrega que `max` "may show diminishing returns and is prone to overthinking".

| Modelo · effort | AA II | TB4 (AA) | TB4 oficial (Claude Code) | $/tarea AA | TTFT | Output tokens del índice | No-alucinación |
|---|---:|---:|---:|---:|---:|---:|---:|
| Opus 5.5 low | 42.3 | 31.3% | — | $0.55 | 6.9 s | 20M | 32.4% |
| Opus 5.5 medium | 51.2 | 52.5% | — | $1.34 | 21.4 s | 38M | 31.6% |
| Opus 5.5 high | 53.6 | 56.6% | — | $1.82 | 34.9 s | 53M | 32.4% |
| Opus 5.5 xhigh | 56.0 | 59.6% | — | $3.46 | 147.1 s | 100M | 34.3% |
| Opus 5.5 max | 57.6 | 59.6% | — | $5.98 | n/d | 260M | 41.4% |
| Fable 5.1 low | 46.8 | 40.4% | 43.33 | $2.37 | 6.0 s | 33M | 34.4% |
| Fable 5.1 medium | 48.9 | 44.9% | 53.94 | $2.98 | 9.9 s | 44M | 30.9% |
| Fable 5.1 high | 51.2 | 52.0% | 54.55 | $3.91 | 22.5 s | 62M | 31.2% |
| Fable 5.1 xhigh | 53.2 | 55.1% | 57.88 | $5.98 | 111.3 s | 120M | 29.5% |
| Fable 5.1 max | 53.4 | 52.0% | 57.88 | $7.63 | 261.4 s | 190M | 27.4% |

Fuentes: [AA leaderboard](https://artificialanalysis.ai/leaderboards/models), [AA Opus 5.5 release](https://artificialanalysis.ai/models/releases/claude-opus-5-5), [AA Fable 5.1 release](https://artificialanalysis.ai/models/releases/claude-fable-5-1) y [tbench.ai](https://www.tbench.ai/leaderboard). Opus 5.5 no aparece en el board oficial de TB4.

Hay que leer esta tabla sabiendo que el IC del índice AA es menor a ±1 punto ([AA methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)).

En Opus 5.5, cada escalón compra menos:

- **medium → high**: +2.4 puntos por 1.36× el costo.
- **high → xhigh**: +2.4 puntos por 1.90× el costo, con un TTFT 4.2× mayor.
- **xhigh → max**: +1.6 puntos por 1.73× el costo y 2.6× los tokens, con TB4 plano en 59.6%.

Anthropic dice además que el mejor Terminal-Bench 4.0 de Opus 5.5 fue **66.4% en `xhigh`**, no en `max` ([Anthropic launch](https://www.anthropic.com/claude-opus-5-5)).

En Fable 5.1, `max` sobre `xhigh` suma 0.2 puntos, dentro del ruido, por 1.28× el costo y 2.35× el TTFT. El board oficial los empata en 57.88 con un costo de corrida 22% menor para `xhigh` ($4,872 vs $6,244), y el TB4 de AA cae de 55.1% a 52.0%.

Entre modelos, **Opus 5.5 en `high` (53.6, $1.82) iguala a Fable 5.1 en `max` (53.4, $7.63) a 4.2× menos costo**, y Opus en `medium` empata a Fable en `high` (51.2) a $1.34 contra $3.91. Fable en `max` tiene además la peor tasa de no-alucinación entre los modelos frontier del roster (27.4%).

Los datos del vendor apuntan en la misma dirección. En un subset interno de SWE-bench Pro con 478 problemas, Opus 5.5 obtuvo:

- `low`: 87.4% a $0.12 por tarea resuelta.
- `medium`: 92.8% a $0.22.
- `high`: 94.8–95.8% a $0.29.
- `xhigh`: 1.4 puntos sobre `high` a 2.5× el costo.
- `max`: no se midió.

Correr todo en `low` y repetir solo los fallos en `high` dio ~97% a $0.17 por tarea, contra 95.3% a $0.29 con todo en `high` ([Anthropic cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)). En el mismo subset, Opus en `medium` sacó 92.8% a $0.22 por tarea resuelta y Fable en su default `high` sacó 92.3% a $1.19.

En `medium`, Opus 5.5 llega a 54.6% en FrontierCode, por encima de su propio 54.4% en `max`. En CursorBench 4.0 sí pierde 5.3 puntos (52.5% vs 57.8%) ([Anthropic launch](https://www.anthropic.com/claude-opus-5-5); [Vellum](https://www.vellum.ai/blog/claude-opus-5-5-benchmarks-explained)).

Dentro de un harness de agente, el Coding Agent Index de AA pone a Claude Code con Opus 5.5 `max` en **66.0** ($13.04 por tarea, 3,867 s, 155 pasos) y a Fable 5.1 `max` en 62.2 ($12.39, 2,090 s, 37 pasos) ([AA Coding Agents](https://artificialanalysis.ai/agents/coding)). En el Vals Index, Opus 5.5 saca 69.69% y Fable 5.1 68.83% ([Vals](https://www.vals.ai/models/anthropic_claude-opus-5-5)).

Fable gana donde el juicio es estético o de cobertura:

- **Escritura creativa**: en EQ-Bench Creative Writing v3 saca 2162 con slop 8.16, contra 2050 con slop 10.43 de Opus 5.5 ([EQ-Bench](https://eqbench.com/creative_writing.html)). En LMArena Creative Writing, Fable `max` es #6 con 1486 y Opus 5.5 todavía no aparece ([LMArena](https://lmarena.ai/leaderboard/text/creative-writing)).
- **Búsqueda de bugs**: Bug Hunt Bench es el único board con niveles de Fable. Ahí `max` arregla 43 bugs ($77.55), `high` 33 ($41.52) y `low` 29 ($27.27), o sea +10 bugs por 1.9× el costo ([BenchLM Bug Hunt Bench](https://benchlm.ai/benchmarks/bug-hunt-bench)).

En UI web la evidencia va al revés. LMArena WebDev pone a Opus 5.5 `max` en 1818±21 y a Fable `max` en 1755±11 ([LMArena WebDev](https://lmarena.ai/leaderboard/code/webdev)), y Vibe Code Bench los empata (90.29 vs 90.26) ([Vals Vibe Code](https://www.vals.ai/benchmarks/vibe-code)).

Contra `max` en Fable pesan tres cosas documentadas:

- En `xhigh` y `max`, Fable redacta buena parte del entregable dentro del thinking y luego lo reescribe. Para entregables largos, Anthropic recomienda `high` ([Prompting Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)).
- FrontierCode Extended empeora a mayor effort porque Fable "can't stop itself from making additional helpful edits" ([Zvi](https://thezvi.substack.com/p/claude-mythos-51-and-fable-51-capabilities)).
- En DeepResearch Bench II, el puntaje de Fable es casi igual entre `low` y `high` ([cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)).

En revisión de código, CodeRabbit encontró que su pipeline "Max" con Opus 5.5 tuvo menos precisión que "Standard" en sus dos sets: 35.7% vs 38.6% y 52.0% vs 66.7% ([CodeRabbit](https://www.coderabbit.ai/blog/opus-5-5-model-review)).

Cuatro detalles operativos afectan a tus cadenas:

- **Thinking blocks entre modelos**: Opus 5.5 descarta en silencio los thinking blocks de Fable. Un fallback de Fable a Opus pierde el razonamiento previo; al revés sí se conserva ([What's new in Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5)).
- **Cache**: cambiar el effort de nivel superior a mitad de sesión invalida el cache. Con un prefijo de 100K tokens, el turno cuesta $0.50 en vez de $0.02 en Opus y $1.25 en vez de $0.03 en Fable ([cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)).
- **Refusals y fallbacks del vendor**: los dos modelos derivan tareas de cyber y bio a Opus 4.8 u Opus 5. En la suite de coding de AA rechazan 9.09% (Opus) y 8.84% (Fable) de las tareas. En Vals, el TB4 de Opus baja de 61.62% a 53.54% si las tareas atendidas por fallback cuentan como fallo ([AA Coding Agents](https://artificialanalysis.ai/agents/coding); [Vals TB4](https://www.vals.ai/benchmarks/terminal-bench-4)).
- **Truncado por `max_tokens`**: un límite de 16K tokens cortó el 25% de los intentos de Opus y el 43% de los de Fable. Anthropic recomienda 64K–128K ([cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)). No verifiqué qué límite manda tu proxy.

Precios por MTok: Opus 5.5 $4/$20, Fable 5.1 $10/$50.

## OpenAI: Astra se aplana en `high` y solo Sol premia `max`

GPT-6 Sol y Luna aceptan `none`, `low`, `medium`, `high`, `xhigh` y `max`, con default `medium`. GPT-6 Astra acepta de `low` a `max`: `none` devuelve HTTP 400 y el default no está documentado. Para GPT-5.6 Sol y Terra, AA mide un modo non-reasoning además de `low` a `max`.

OpenAI describe `xhigh` como "only use when your evals show a clear benefit" y lista entre sus casos de uso "security and code review". De `max` solo dice "evaluate if max results in stronger performance" ([reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)). Codex recomienda empezar Sol en Medium, Luna en High y Astra en Light (`low`) ([Codex Models](https://learn.chatgpt.com/docs/models)). El catálogo de V2 coincide con estos enums; Astra no tiene `none`.

| Modelo (celda = AA II · $/tarea · TB4) | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| GPT-6 Astra ($10/$50) | 45.8 · $0.82 · 41.9% | 49.6 · $1.54 · 49.5% | 50.9 · $1.73 · 54.0% | 52.4 · $2.31 · 59.6% | 52.7 · $3.26 · 59.1% |
| GPT-6 Sol ($2/$10) | 33.9 · $0.13 · 9.1% | 39.8 · $0.25 · 18.7% | 42.8 · $0.38 · 26.3% | 44.1 · $0.53 · 30.3% | 47.5 · $1.06 · 43.9% |
| GPT-6 Luna ($0.10/$0.50) | 20.9 · $0.004 · 0.0% | 29.5 · $0.017 · 2.5% | 32.1 · $0.029 · 4.5% | 33.9 · $0.042 · 8.1% | 37.3 · $0.068 · 12.6% |
| GPT-5.6 Sol ($4/$20, deprecated en AA) | 33.5 · $0.26 · 1.0% | 39.2 · $0.51 · 14.6% | 42.3 · $0.81 · 20.7% | 44.0 · $1.18 · 24.7% | 47.0 · $1.99 · 39.9% |
| GPT-5.6 Terra ($2/$12) | 27 · $0.14 · — | 30.1 · $0.18 · 1.0% | 34.2 · $0.34 · 1.5% | 38.0 · $0.63 · 10.1% | 42.1 · $1.40 · 35.4% |

| Modelo (celda = TTFT · no-alucinación) | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| GPT-6 Astra | 3.3 s · 53.1% | 6.4 s · 53.5% | 66.2 s · 55.2% | 184.5 s · 51.7% | 367.6 s · 48.7% |
| GPT-6 Sol | 1.8 s · 49.3% | 2.0 s · 43.2% | 12.2 s · 41.9% | 44.8 s · 41.1% | 178.3 s · 39.9% |
| GPT-6 Luna | 2.1 s · 15.7% | 5.3 s · 15.3% | 8.9 s · 15.6% | 19.5 s · 17.6% | 109.3 s · 23.3% |
| GPT-5.6 Sol | 2.8 s · 10.6% | 3.6 s · 9.2% | 11.4 s · 8.8% | 36.3 s · 8.1% | 113.2 s · 7.8% |
| GPT-5.6 Terra | — | 2.1 s · 10.2% | 3.5 s · 10.2% | 25.1 s · 11.0% | 211.1 s · 12.1% |

Fuentes: [AA leaderboard](https://artificialanalysis.ai/leaderboards/models) y las release pages de AA ([Astra](https://artificialanalysis.ai/models/releases/gpt-6-astra), [Sol](https://artificialanalysis.ai/models/releases/gpt-6-sol), [Luna](https://artificialanalysis.ai/models/releases/gpt-6-luna), [5.6 Sol](https://artificialanalysis.ai/models/releases/gpt-5-6-sol), [5.6 Terra](https://artificialanalysis.ai/models/releases/gpt-5-6-terra)).

OpenAI publicó curvas por nivel para Sol y Luna. Estas cifras vienen de la transcripción de Kingy AI; OpenAI confirma en prosa varios puntos (33.2% en `xhigh`, 68.8% y 66.6% en DeepSWE `max`) ([Kingy AI](https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/); [OpenAI Sol/Luna launch](https://openai.com/index/introducing-gpt-6-sol-and-luna/)):

| Effort | Sol DeepSWE ($/tarea) | Sol AutomationBench | Sol error factual | Luna DeepSWE ($/tarea) | Luna OSWorld | Luna error factual |
|---|---:|---:|---:|---:|---:|---:|
| low | 37.2% ($0.16) | 21.2% | 11.4% | **2.4%** ($0.006) | 8.3% | 27.7% |
| medium | 56.6% ($0.38) | 26.9% | 6.9% | 44.5% ($0.052) | 31.5% | 17.5% |
| high | 65.3% ($0.64) | 31.2% | 5.1% | 59.3% ($0.084) | 41.4% | 12.5% |
| xhigh | 66.6% ($1.00) | **33.2%** | 4.5% | 61.3% ($0.11) | 46.7% | 10.2% |
| max | 68.8% ($2.74) | 32.0% | 4.6% | 66.6% ($0.22) | 52.7% | 7.6% |

**Astra deja de mejorar a partir de `high` en casi todo lo medible.** En el board oficial de TB4 empatan `high` y `xhigh` (57.88), y `max` sube a 58.18 con un costo de corrida 39% mayor ([tbench.ai](https://www.tbench.ai/leaderboard)). La serie del vendor para TB4 tiene su pico en `high` con 57.9% ([Kingy AI](https://kingy.ai/blog/gpt-6-astra-vs-claude-opus-5-5-reasoning-effort/)). El error factual del vendor es 3.9 / 4.0 / 3.9 de `high` a `max`, y la no-alucinación de AA llega a su máximo en `high` (55.2%). La única ganancia clara de `xhigh` es el TB4 de AA (54.0% → 59.6%), que el board oficial no reproduce. Los TTFT se duplican o triplican en cada escalón: 66 s, 184 s y 368 s.

**Sol es el único modelo del roster cuya curva sigue subiendo**: +3.4 puntos y +13.6 en TB4 de `xhigh` a `max`, por el doble de costo. En los datos del vendor la señal es mixta: AutomationBench toca techo en `xhigh`, y DeepSWE suma apenas 2.2 puntos de `xhigh` a `max` con un costo por tarea 2.7× mayor.

**Luna en `low` no sirve para trabajo agéntico**: 0% en TB4, 2.4% en DeepSWE y 1.2% en AutomationBench según el vendor. En `medium` salta a 44.5% en DeepSWE a $0.017 por tarea AA.

A igual effort, GPT-6 Sol empata a GPT-5.6 Sol en el índice (+0.1 a +0.6), cuesta la mitad o menos por tarea y su tasa de no-alucinación es entre 4 y 5 veces mayor. En `medium`, además, tarda 60 s por tarea contra 114 s ([AA Sol vs 5.6 Sol medium](https://artificialanalysis.ai/models/comparisons/gpt-6-sol-medium-vs-gpt-5-6-sol-medium)). GPT-5.6 Sol conserva algunas ventajas:

- Knowledge work: GDPval 45.1 vs 41.0 y SciCode 57.4% vs 53.8% en `medium`.
- Pico de DeepSWE en `max`: 72.7% vs 68.8% según el vendor, y 72.3 vs 69.0 en el Coding Agent Index de AA ([Kingy AI](https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/); [AA Coding Agents](https://artificialanalysis.ai/agents/coding)).

Aun así, en ese mismo índice Codex con GPT-6 Sol `max` saca 56.7 a $2.99 por tarea, contra 54.6 a $6.35 de 5.6 Sol, y AA ya marca a 5.6 Sol como deprecated. SWE-rebench, cuya ventana cierra el 2026-07-01, antes de GPT-6, ubicó a 5.6 Sol `medium` #5 con 62.3% a $0.85 por problema ([SWE-rebench](https://swe-rebench.com/)). Terra `high` (34.2, $0.338, TB4 1.5%) queda dominado por Sol `low` (33.9, $0.132) y por Sol `medium` (39.8, $0.248).

No existe un benchmark de code review por nivel de Astra. MacroscopeBench (12K bugs reales, 14 lenguajes) pone a Astra `max` arriba con 78.0, precisión de 91.7% y señal/ruido de 6.26:1, a $7.87 por review. Muy cerca quedan GPT-5.6 Sol `high` con 77.8 a $3.90 y GLM-5.3 `max` con 77.4 a $3.86. La conclusión explícita del autor es que "effort level matters more than model family" ([Macroscope](https://macroscope.com/content/ai-code-review-benchmark-best-models)). En Bug Hunt Bench, 5.6 Sol arregla 42, 39 y 34 bugs en `max`, `xhigh` y `high` ([BenchLM](https://benchlm.ai/benchmarks/bug-hunt-bench)).

La única comparación práctica de revisión es anecdótica: un solo run por condición y no ciego. En ella, Astra `medium` encontró un bug de arranque que `high` pasó por alto, mientras `high` descartó un falso positivo que `low` y `medium` habían reportado. Astra `medium` fue además la configuración más barata del experimento completo: $25.67 contra $37.23 de `high` ([dev.to / Kagawa](https://dev.to/shinpr/switching-from-gpt-56-sol-to-gpt-6-astra-start-with-medium-effort-25ao)).

Los modelos `-fast` son el tier priority del mismo modelo:

- **Precio**: 2× en la API (Sol-fast lista $4/$20) y 2.5× en créditos de ChatGPT.
- **Velocidad**: OpenAI publica aceleración solo para Astra (hasta 2×) y GPT-5.6 (1.5×). Para Sol y Luna no publica ningún multiplicador, ni diferencias de calidad ([Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed); [Sol model page](https://developers.openai.com/api/docs/models/gpt-6-sol)).
- **`gpt-6-luna-fast`**: no aparece en catálogos externos. En V2 existe como modelo "mode" que hereda los variants de Luna y agrega `service_tier:"priority"`.

Con suscripción, el effort solo cambia el consumo a través de los tokens. Las tarifas en créditos por 1M tokens (input/cached/output) son:

| Modelo | Créditos por 1M (in/cached/out) | Mensajes por 5 h en Plus |
|---|---|---|
| Astra | 250 / 25 / 1,250 | 5–45 |
| GPT-6 Sol | 50 / 5 / 250 | 15–150 |
| GPT-6 Luna | 2.5 / 0.25 / 12.5 | 350–3,000 |
| GPT-5.6 Sol | 100 / 10 / 500 | 10–100 |
| GPT-5.6 Terra | 50 / 5 / 300 | 25–200 |

Fuente: [Codex Pricing](https://learn.chatgpt.com/docs/pricing).

AA mide los output tokens por tarea en cada nivel: Sol usa 3k en `low`, 6k en `medium`, 16k en `xhigh` y 31k en `max`, y Astra usa 12k, 17k y 27k de `high` a `max`. Con esos números, Sol-fast en `medium` consume más o menos lo mismo que Sol estándar en `xhigh`. En Codex, `max` se habilita en settings. No sé si un cliente OAuth como OpenCode lo recibe sin ese paso.

## Kimi y GLM: el endpoint cambia el default y el catálogo recorta niveles

Kimi K3 siempre razona y expone `reasoning_effort` `low`, `high` y `max`, pero **su default depende del endpoint**. En la API de Moonshot es `max` ([Kimi API params](https://platform.kimi.ai/docs/api/models-overview)). En el endpoint del plan de Kimi Code (`kimi-code-plan-global`) es **`high`**. Ese endpoint mapea los valores que recibe así:

- `xhigh`/`ultra` → `max`.
- `medium` → `high`.
- `none` → apaga el thinking y **reenruta a K2.8 Preview**.
- Cualquier valor desconocido → HTTP 400.

Fuente: [Kimi Code: Model Configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html). V2 genera `low/high/max` para el plan y **solo `max` para `opencode-go/kimi-k3`**, en línea con models.dev ([models.dev](https://models.dev/api.json)).

Hay dos advertencias de Moonshot que pesan en tus cadenas. Cambiar el effort a mitad de sesión invalida el prefix cache ([Kimi API params](https://platform.kimi.ai/docs/api/models-overview)). Y cambiar a K3 en medio de una sesión que venía de otro modelo produce una calidad "highly unstable", que es exactamente lo que hace un fallback ([Kimi K3 blog](https://www.kimi.ai/blog/kimi-k3)).

En números:

- **AA**: 43.6 en `max` ($2.00 por tarea, 35 t/s, no-alucinación 46.8%) y 34.5 en `low`. AA no mide `high` ([AA leaderboard](https://artificialanalysis.ai/leaderboards/models)).
- **TB4**: 12.6% en la corrida de AA contra 21.2% en Kimi Code CLI. En ese harness nativo, el Coding Agent Index de K3 es 51.9 (DeepSWE 68.4) a $5.05 por tarea y 3,689 s ([AA Coding Agents](https://artificialanalysis.ai/agents/coding)).
- **Vendor**: DeepSWE 67.5 y Terminal-Bench 2.1 88.3, en su propio harness ([HF Kimi-K3](https://huggingface.co/moonshotai/Kimi-K3)).
- **Vals**: SWE-bench (probablemente Verified) 93.4% ([Vals SWE-bench](https://www.vals.ai/benchmarks/swebench)).
- **Diseño**: K3 es #1 en Design Arena con 1378, por encima de Astra (1361) y Fable (1343), aunque ahí no se etiqueta el effort. En LMArena WebDev es #9 con 1660 ([Design Arena](https://www.designarena.ai/leaderboard); [LMArena WebDev](https://lmarena.ai/leaderboard/code/webdev)).
- **Revisión**: en MacroscopeBench saca 72.9 en `max` ([Macroscope](https://macroscope.com/content/ai-code-review-benchmark-best-models)).

En OpenCode Go, K3 cuesta $3/$15 con un tope de $15 al mes. Go estima ~110 requests cada 5 h suponiendo solo 300 tokens de output por request ([OpenCode Go docs](https://opencode.ai/docs/go/)).

`kimi-for-coding-highspeed` es **K2.7 Code HighSpeed**: los mismos pesos que K2.7 Code, con thinking obligatorio y sin `reasoning_effort` ([Kimi Code: Model Configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)). En la API de plataforma, desactivar el thinking devuelve error ([Kimi API params](https://platform.kimi.ai/docs/api/models-overview)). Otros datos del modelo:

- **Velocidad**: ~180 t/s, frente a 64 t/s del K2.7 Code estándar.
- **Cuota**: consume 3× la cuota del plan.
- **Acceso**: requiere el plan Pro o superior; con un plan menor devuelve 401.
- **Calidad**: AA le da 26 a K2.7 Code ($0.54 por tarea) ([AA K2.7 Code](https://artificialanalysis.ai/models/kimi-k2-7-code)). En Vals resuelve 89%, 75%, 50% y 33% de las tareas según los tramos de dificultad (<15 min, 15 min–1 h, 1–4 h, >4 h) ([Vals SWE-bench](https://www.vals.ai/benchmarks/swebench)).

GLM-5.3 siempre piensa y admite `low`, `high` y `max`, con default `max` ([Z.ai GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)). Sus números:

- **AA**: en `max` saca 44.8, con TB4 41.9%, no-alucinación 70.4% y $2.01 por tarea. En `low` saca 34.3 con TB4 34.8%. El costo publicado para `low`, $3.66, no cuadra con que use menos tokens, así que probablemente es un error de AA.
- **Z.ai Code Bench** (el único dato de `high`): 34.5% en `max` con ~75K tokens por tarea, y 31.4% en `high` con ~50K ([Z.ai GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)).
- **OpenCode**: es el único dato del roster medido dentro de OpenCode. Coding Agent Index 53.6, DeepSWE 61.4 y TB4 39.9, a $4.24 por tarea ([AA Coding Agents](https://artificialanalysis.ai/agents/coding)).
- **TB4 oficial**: 41.82 en Claude Code ([tbench.ai](https://www.tbench.ai/leaderboard)).

GLM-5.2 comparte el modelo base con 5.3 y la mejora de 5.3 viene solo de post-training. Aun así, 5.2 queda atrás en todo:

- **AA**: 33.7, con TB4 1.0%; AA lo marca deprecated.
- **DeepSWE del vendor**: 46.2 contra 66.9 de 5.3 ([HF GLM-5.3](https://huggingface.co/zai-org/GLM-5.3)).
- **Controles**: acepta `off`, `high` y `max`. `low`/`medium` suben a `high` y `xhigh` pasa a `max` ([Z.ai API reference](https://docs.z.ai/api-reference/llm/chat-completion)).

Su única ventaja documentada en Go es la cuota: $60 al mes contra $15 de 5.3 (~880 vs ~220 requests cada 5 h), al mismo precio por token.

## Fallbacks baratos: MiMo empata a Grok a 1/20 del costo

| Modelo (nivel medido por AA) | Niveles reales | AA II | TB4 | $/tarea | tok/s | TTFT | No-alucinación |
|---|---|---:|---:|---:|---:|---:|---:|
| MiMo V2.6 Pro (sin etiqueta) | on/off | 46.3 | 34.8% | $0.133 | 43 | 3.2 s | 59.4% |
| Grok 4.7 high | low/medium/high/xhigh | 46.3 | 24.7% | $2.73 | 52 | 0.9 s | 67.6% |
| Grok 4.7 xhigh | ídem | 46.4 | 25.8% | $3.74 | 40 | 1.0 s | 70.7% |
| Gemini 3.8 Flash (high) | low/medium/high | 41 | — | $1.24 | 293 | — | — |
| Qwen3.8-Flash-Next (¿mismo modelo?) | low/medium/xhigh | 39.8 | 25.3% | $0.372 | 53 | 3.3 s | 54.7% |
| DeepSeek V4.1 Flash max | low/high/max | 39.5 | 26.8% | $0.265 | 232 | 1.0 s | 3.5% |
| Gemini 3.7 Flash (high) | low/medium/high | 39 | — | $0.93 | 304 | — | — |
| DeepSeek V4 Pro 0813 max | low/high/max | 36.0 | 14.1% | $0.674 (peak) | 69 | 1.7 s | 5.2% |
| DeepSeek V4 Flash 0731 max (deprecated) | low/high/max | 34.3 | 12.1% | $0.220 | 221 | 1.0 s | 8.3% |
| Gemini 3.6 Flash high (deprecated) | minimal/low/medium/high | 34.0 | 7.1% | $0.929 | 196 | 17.9 s | 44.4% |
| Gemini 3.1 Pro Preview | low/medium/high | 29.7 | 4.0% | $0.675 | 120 | 27.5 s | 49.1% |
| MiniMax M3 | on/off | 29.2 | 2.0% | $0.508 | 153 | 1.3 s | 81.6% |
| Qwen 3.7 Plus | budget | 25.2 | 1.0% | $0.295 | 68 | 2.2 s | 72.3% |
| MiniMax M2.7 (deprecated) | siempre on | 22.8 | 0.0% | $0.102 | 56 | 1.5 s | 64.4% |

Fuentes: [AA leaderboard](https://artificialanalysis.ai/leaderboards/models), [AA Gemini 3.7 Flash](https://artificialanalysis.ai/models/gemini-3-7-flash) y [AA Gemini 3.8 Flash](https://artificialanalysis.ai/models/gemini-3-8-flash).

**DeepSeek** es el único de este grupo con effort real de varios niveles. Su API tiene el thinking encendido por default y el effort en `high`. Acepta `low`, `high` y `max`; `low` se agregó el 2026-08-13. `xhigh` y `medium` se mapean a `high`, sin error ([DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode); [Change Log](https://api-docs.deepseek.com/updates)).

La única tabla por nivel es la de los checkpoints preview de abril, ya reemplazados (Non-think / High / Max) ([HF DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro)):

| Modelo | Benchmark | Non-think | High | Max |
|---|---|---:|---:|---:|
| V4 Pro | Terminal Bench 2.0 | 59.1 | 63.3 | 67.9 |
| V4 Pro | SWE Verified | 73.6 | 79.4 | 80.6 |
| V4 Pro | MCPAtlas | 69.4 | **74.2** | 73.6 |
| V4 Flash | Terminal Bench 2.0 | 49.1 | 56.6 | 56.9 |

En MCPAtlas, `high` le gana a `max`. En Vals, SWE-bench Verified pone a V4 Pro 0813 segundo con 96.4% ([Vals SWE-bench](https://www.vals.ai/benchmarks/swebench)). El problema de DeepSeek es la alucinación: su tasa de no-alucinación es la peor del roster (5.2% y 3.5%).

En Go, V4 Pro solo tiene variants `high` y `max`. El precio de peak dobla al de off-peak; el peak va de 01:00 a 04:00 y de 06:00 a 10:00 UTC, de lunes a viernes ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)). Hay una ambigüedad con el nombre `deepseek-v4-flash`. DeepSeek ya lo atiende con V4.1 Flash, pero Go lista `deepseek-v4-flash` y `deepseek-v4.1-flash` por separado. Tu `deepseek-v4-flash` puede ser el 0731 deprecated (34.3) o el 4.1 (39.5).

**MiMo V2.6 Pro** solo tiene `thinking` on/off, encendido por default y sin control de profundidad ([MiMo Deep Thinking](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)). Es fuerte y barato, pero lento: 1,454 s por tarea AA, contra 559 s de V4 Pro. Tiene dos días en el mercado. El vendor reporta DeepSWE 71.9 y TB 2.1 89.9 ([HF MiMo-V2.6-Pro-RL](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL)). Exige devolver `reasoning_content` en tool calls multi-turno; Go marca `interleaved` para él, así que OpenCode probablemente lo cumple. En Go tiene un tope de $15 al mes.

**Grok 4.7** acepta `low`, `medium`, `high` (default) y `xhigh`, y el reasoning no se puede apagar ([xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)). En AA, `high` y `xhigh` empatan en 46.3/46.4, y `xhigh` cuesta 37% más y es ~25% más lento.

El CursorBench del vendor da 33.1% en `low` ($1.58), 43.9% en `high` ($4.69) y 46.3% en `xhigh` ($6.01) ([Tabbit](https://go.tabbit.ai/blog/grok-4-7-review)). El TB4 varía entre 26% y 38% según el harness: 25.8% en la corrida de AA, 33.3% en Grok Build dentro del Coding Agent Index y 37.58% en el board oficial ([AA article](https://artificialanalysis.ai/articles/benchmarking-grok-4-7); [tbench.ai](https://www.tbench.ai/leaderboard)). En `xhigh` tarda ~7.1 minutos por tarea del índice. Go le da una de las cuotas más chicas del catálogo, con 169 requests en la ventana corta ([OpenCode Go docs](https://opencode.ai/docs/go)).

**MiniMax M3** solo tiene toggle `adaptive`/`disabled`, y **en la API de MiniMax arranca con el thinking apagado**. M2.7 piensa siempre, aunque le mandes `disabled` ([MiniMax Anthropic API](https://platform.minimax.io/docs/api-reference/text-anthropic-api)). M3 destaca en tool use conversacional (τ² 88.9%, IFBench 82.9%) y no alucina porque se abstiene: su precisión en Omniscience es de solo 16.7%. En TB4 saca 2.0% ([AA MiniMax-M3](https://artificialanalysis.ai/models/minimax-m3)). En Go, su output tiene un tope de 131K contra 512K en la API directa.

**Qwen** tiene dos casos distintos:

- **Qwen 3.7 Plus**: controla el thinking con `enable_thinking` y `thinking_budget`, y el presupuesto por default es el máximo del modelo, 262,144 tokens de CoT. No tiene alias de effort ([Alibaba deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)). En Go, su output tiene un tope de 65K.
- **Qwen 3.8 Flash**: en el endpoint Anthropic, que es el que usa Go, acepta `low`, `medium` y `xhigh`, con default `xhigh`; `max` y `high` se mapean a `xhigh` ([Alibaba Anthropic API](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages)). No tiene ningún score independiente. AA lista un "Qwen3.8-Flash-Next" que podría ser otro modelo.

**Gemini** controla el thinking con `thinking_level`, que no se puede apagar. 3.1 Pro acepta `low`, `medium` y `high` (default `high`). 3.6 Flash acepta `minimal`, `low`, `medium` y `high` (default `medium`). Los sucesores 3.7 y 3.8 Flash no tienen `minimal` ([Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)).

3.1 Pro sigue siendo el único Pro disponible y sigue en preview. Aun así, en AA saca 29.7, debajo de cualquier Flash desde 3.6. La propia ficha de 3.6 Flash lo muestra detrás en SWE-Bench Pro (58.7 vs 54.2), DeepSWE (49 vs 12) y MRCR a 1M (54% vs ~26%) ([Google blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber); [OfficeChai](https://officechai.com/ai/gemini-3-6-flash-benchmarks)). Además tiene el slop más alto de EQ-Bench (30.03) y queda último del roster en Design Arena (1240) ([EQ-Bench](https://eqbench.com/creative_writing.html); [Design Arena](https://www.designarena.ai/leaderboard)).

AA ya considera 3.6 Flash una generación anterior y lo marca deprecated. 3.7 Flash cuesta lo mismo por tarea ($0.93), suma 5 puntos y corre 55% más rápido. Los tres Flash cuestan $0.75/$3.75 hasta el 31 de diciembre de 2026 y **suben a $1.50/$7.50 el 1 de enero de 2027** ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)). No hay ningún benchmark de Gemini por `thinking_level`.

## El harness, la versión y los fallbacks mueven varios puntos

**Las versiones de Terminal-Bench no se pueden comparar entre sí.** Gemini 3.1 Pro, por ejemplo, saca 68.5% en TB 2.0 y 73.8% en TB 2.1 ([DeepMind 3.1 Pro](https://deepmind.google/models/gemini/pro); [OfficeChai](https://officechai.com/ai/gemini-3-6-flash-benchmarks)). Incluso dentro de TB4, el mismo modelo cambia según quién lo mida:

| Modelo | tbench.ai oficial | AA Coding Agent Index | Corrida del índice AA | Vals | Vendor |
|---|---:|---:|---:|---:|---:|
| Fable 5.1 `max` | 57.88 | 57.6 | 52.0 | 49.49 | — |
| Opus 5.5 `max` | no listado | 63.1 | 59.6 | 61.62 (53.54 contando el fallback como fallo) | 66.4 en `xhigh` |

Fuentes: [tbench.ai](https://www.tbench.ai/leaderboard), [AA Coding Agents](https://artificialanalysis.ai/agents/coding) y [Vals TB4](https://www.vals.ai/benchmarks/terminal-bench-4).

El único estudio controlado de harness, HarnessTax de Arena, comparó Claude Code, Codex y Pi. Encontró que el harness mueve la tasa de éxito solo ±2–5 puntos, pero el costo hasta 5×. Claude Code costó 2.0× lo de Pi, y en 9 de 12 comparaciones el modelo rindió mejor fuera del harness de su propio vendor ([Arena HarnessTax](https://arena.ai/blog/coding-agents-harness-tax/)). OpenCode no entró en ese estudio. Su único dato independiente es GLM-5.3: 39.9 en TB4 dentro de OpenCode contra 41.82 en Claude Code, dentro del IC (±3.2).

K3 y Grok ganan 8.6 y 7.5 puntos de TB4 en sus CLIs nativas frente a la corrida genérica de AA. Eso sugiere que en OpenCode rinden por debajo de sus números de marketing.

Las cuotas de Go asumen entre 120 y 300 tokens de output por request: 120 para Grok, 150 para GLM, 290 para DeepSeek Pro y 300 para K3. En AA, DeepSeek V4 Pro produce 55K tokens por tarea y MiMo 64K. Con turnos de reasoning pesados, los topes de $15 se agotan mucho antes de lo que sugieren las tablas de Go ([OpenCode Go docs](https://opencode.ai/docs/go/)).

Varias cifras que circularon antes no se sostienen:

- El default de `kimi-code-plan-global/k3` es `high`, no `max` ([Kimi Code](https://www.kimi.com/code/docs/en/kimi-code/models.html)).
- El "SWE-bench Verified 76.8%" de K3 y el "Vals 78.2%" de HighSpeed no aparecen en ninguna fuente; Vals muestra 93.4% para K3 ([Vals](https://www.vals.ai/benchmarks/swebench)).
- Qwen 3.7 Plus no tiene alias de effort ni default `medium`.
- MiniMax M3 arranca con el thinking apagado.
- DeepSeek no rechaza `xhigh`: lo mapea a `high`.
- Los 147 s de TTFT de Opus corresponden a `xhigh`; AA no midió `max`.
- El 38.0% de Grok en TB4 es del vendor con Grok Build; la corrida del índice AA da 25.8%.

## Evidencia por rol

"Efectivo" indica qué corre según el código y los logs. "(A)" significa default del agente, que se pasa crudo. Los fallbacks y las categorías van por el path B, con las salvedades de la primera sección.

**Agentes**

| Rol | Configurado → efectivo | Evidencia por nivel | Lo que muestra la evidencia |
|---|---|---|---|
| `sisyphus` (orquestador) | Opus 5.5 `xhigh` (A, aplica) → GPT-5.6 Sol `medium` (aplica) → plan k3 sin nivel (default `high`) → Go kimi-k3 sin nivel (default de Go, sin verificar) | Opus: `high` 53.6 / $1.82 / TTFT 35 s; `xhigh` 56.0 / $3.46 / 147 s; `max` 57.6 / $5.98. Anthropic: mejor TB4 en `xhigh` (66.4%). Coding Agent Index de Claude Code con Opus `max`: 66.0. GPT-6 Sol `medium` 39.8 / $0.25 vs 5.6 Sol `medium` 39.2 / $0.51 | `xhigh` coincide con el caso de uso documentado (>30 min). `high` ahorra ~47% por −2.4 puntos. GPT-6 Sol domina a 5.6 Sol como fallback. Moonshot advierte inestabilidad si K3 entra a mitad de sesión |
| `hephaestus` | GPT-6 Sol `medium` → 5.6 Sol `medium` (los dos aplican) | Sol `medium`: 39.8, TB4 18.7%, TTFT 2.0 s, 114 t/s, $0.25. `high`: 42.8, TB4 26.3%, TTFT 12.2 s, $0.38. DeepSWE del vendor: 56.6% → 65.3% | `medium` es el punto más rápido de la curva y lo que recomienda Codex. `high` compra +8.7 puntos de DeepSWE por 1.7× el costo y 6× el TTFT |
| `oracle` | 5.6 Sol `xhigh` (A, aplica) → Astra `high` → Opus `xhigh` → Go glm-5.2 sin nivel (hereda `xhigh`; se descarta y corre el default) | 5.6 Sol `xhigh`: 44.0 / $1.18, no-alucinación 8.1%, deprecated en AA. Astra `high`: 50.9 / $1.73, no-alucinación 55.2%. Astra `xhigh`: 52.4 / $2.31. GPT-6 Sol `xhigh`: 44.1 / $0.53. GLM-5.2 33.7 vs GLM-5.3 44.8 al mismo precio | El primario queda 6.9 puntos debajo de su primer fallback y alucina mucho más. 5.6 Sol solo gana en GDPval, Briefcase y SciCode |
| `prometheus` | Fable `xhigh` (A, aplica) → Opus `xhigh` → plan k3 `max` (`high` si se baja) → Astra `high` | Fable `xhigh`: 53.2 / $5.98 / TTFT 111 s. Opus `xhigh`: 56.0 / $3.46. Opus `high`: 53.6 / $1.82. No hay ningún benchmark independiente de calidad de planes | Opus `xhigh` supera a Fable `xhigh` en AA y cuesta 42% menos. Un fallback de Fable a Opus pierde los thinking blocks |
| `metis` | Fable `max` (A, aplica) → Opus `xhigh` → plan k3 `max` → Go kimi-k3 `max` (válido) | Fable `max`: 53.4 / $7.63 / TTFT 261 s. Fable `xhigh`: 53.2 / $5.98 / 111 s. TB4 oficial: 57.88 en los dos. No-alucinación en `max`: 27.4% | `max` no suma nada medible. Anthropic recomienda `high` para entregables largos, por el doble borrador en `max` |
| `momus` | Astra `xhigh` (A) → Opus `xhigh` → Gemini 3.1 Pro `high` (= default) → Go glm-5.2 sin nivel | Astra: TB4 oficial `high` = `xhigh` = 57.88; error factual 3.9 / 4.0; no-alucinación 55.2% (`high`) vs 51.7% (`xhigh`); TTFT 66 s vs 184 s. Macroscope: Astra `max` 78.0 con precisión 91.7%. Gemini 3.1 Pro: 29.7 en AA | Macroscope, CodeRabbit y Kagawa coinciden en que más effort no mejora la revisión, aunque OpenAI cita el code review como caso de uso de `xhigh`. Gemini 3.1 Pro es el eslabón más débil de la cadena |
| `atlas`, `sisyphus-junior` | 5.6 Sol `medium` (A) → plan k3 (`high`) → Go kimi-k3 (hereda `medium`; error previsto) → Go minimax-m3 (hereda `medium`; error previsto) | GPT-6 Sol `medium` iguala o supera a 5.6 Sol `medium` en índice, TB4 y no-alucinación (43.2% vs 9.2%), a la mitad del costo y 1.9× más rápido por tarea. SWE-rebench (datos anteriores a GPT-6): 5.6 Sol `medium` 62.3% a $0.85 | Dos de los tres fallbacks no pueden correr con el nivel heredado |
| `librarian`, `explore` | HighSpeed `off` (no se apaga; siempre piensa) → Luna-fast `low` → Go DS V4 Flash `max` → Qwen 3.7 Plus, MiniMax M2.7 y Gemini 3.6 Flash sin nivel (heredan `off`, que se descarta) | K2.7 Code: 26 en AA, ~180 t/s, 3× cuota, requiere Pro+. Luna `low`: 20.9, TB4 0%, no-alucinación 15.7%, DeepSWE del vendor 2.4%. Luna `medium`: 29.5 a $0.017. DS V4.1 Flash `max`: 39.5, 232 t/s, no-alucinación 3.5%. Gemini 3.6 Flash: MRCR 1M 54% | Toda la cadena piensa: el `off` no tiene efecto en ningún eslabón. Luna `low` es el eslabón con peor evidencia |
| `multimodal-looker` | 5.6 Sol `low` (A) → Go kimi-k3 (hereda `low`; **falla, 30× en log**) → Gemini 3.6 Flash (hereda `low`, válido) | GDP.pdf en `low`: GPT-6 Sol 22%, 5.6 Sol 21%, Luna 6%. GPT-6 Sol `low` cuesta $0.13 vs $0.26. Gemini lee PDF nativo con 1M de contexto. No hay MMMU por nivel | GPT-6 Sol `low` es un reemplazo 1:1 a mitad de costo en el único proxy de documentos disponible |

**Categorías**

| Categoría | Configurado → efectivo | Evidencia por nivel | Lo que muestra la evidencia |
|---|---|---|---|
| `quick` | Luna-fast `low` → HighSpeed (thinking on) → Go minimax-m3 `max` (no existe; si se baja, probablemente sin thinking; si pasa crudo, error) → Go qwen3.8-flash sin nivel (default `xhigh`) → Gemini 3.6 Flash (default `medium`) | Luna `low` → `medium`: DeepSWE 2.4% → 44.5%, $0.004 → $0.017 por tarea AA. Fast: 2× en la API y 2.5× en créditos. M3: 29.2 en AA, 153 t/s, IFBench 82.9% | Pasar Luna a `medium` es el salto más barato de todo el roster |
| `visual-engineering` | Fable `max` (el log muestra que aplica) → Opus `xhigh` → plan k3 `max` → Go kimi-k3 `max` | LMArena WebDev: Opus `max` 1818 > Astra `max` 1792 > Fable `max` 1755 > K3 `max` 1660. Vibe Code: Opus 90.29 ≈ Fable 90.26. Design Arena (sin effort): K3 1378 > Astra 1361 > Fable 1343 | Ningún board independiente pone a Fable arriba de Opus en UI web, y ninguno mide niveles por debajo de `max` |
| `deep-low` | GPT-6 Sol-fast `medium` → Sol `medium` → 5.6 Sol `medium` (todos aplican) | La misma curva de Sol que en hephaestus. Fast cuesta 2× / 2.5× y no tiene aceleración publicada para Sol | Con suscripción, Sol-fast `medium` gasta créditos más o menos como Sol estándar en `xhigh` |
| `deep-high` | Astra `xhigh` (aplica) | `xhigh`: 52.4 / $2.31 / TTFT 184 s. `high`: 50.9 / $1.73 / 66 s. TB4 oficial igual en los dos. Coding Agent Index de Codex con Astra `max`: 61.6 | `high` da el mismo TB4 oficial con un costo de corrida 3% menor y un tercio del TTFT |
| `ultrabrain` | Astra `max` (aplica) → 5.6 Sol `max` (válido si pasa crudo; si se baja, queda como `providerOptions` plano) | Astra `max` vs `xhigh`: +0.3 en AA a 1.41× el costo, TTFT 368 s; HLE 54.7 vs 54.6; CritPt 31.7 vs 31.4. Un reporte secundario sin verificar dice que en ARC-AGI-3 `max` fue el mejor y el más barato en total ([ilikekillnerds](https://ilikekillnerds.com/2026/09/06/gpt-5-6-sol-to-gpt-6-astra-reasoning-effort/)). 5.6 Sol `max`: DeepSWE 72.7% (vendor) y 72.3 (Coding Agent Index), el pico del roster junto a Grok | La ganancia de `max` en Astra cae dentro del ruido. El fallback aporta un pico real en DeepSWE |
| `unspecified-high` | Opus `xhigh` → GLM-5.3 `max` (aplica) → plan k3 `max` → Astra `high` | Opus `xhigh`: 56.0. GLM-5.3 `max`: 44.8, Coding Agent Index en OpenCode 53.6 ($4.24), Macroscope 77.4. Z.ai Code Bench: `high` 31.4% con 50K tokens vs `max` 34.5% con 75K | La cadena ya está ordenada por índice AA |
| `unspecified-low` | MiMo `max` (sin variants: error si pasa crudo, no-op si se baja) → Grok `xhigh` (válido crudo; `high` si se baja) → Terra `high` → DS V4 Pro `max` (aplica) | MiMo: 46.3 / $0.133, pero 43 t/s y 1,454 s por tarea. Grok `high` 46.3 / $2.73 = `xhigh` 46.4 / $3.74. Terra `high`: 34.2 / $0.338. DS V4 Pro: 36.0 / $0.674 (peak), no-alucinación 5.2%. Topes de Go de $15 para MiMo y DS Pro | Grok `xhigh` no compra nada sobre `high`, y Terra `high` queda debajo de todos los demás |
| `writing` | Fable `low` → Opus `low` → plan k3 `max` (`high` si se baja) | Fable `low`: 46.8 / $2.37. Opus `low`: 42.3 / $0.55. EQ-Bench (sin effort etiquetado): Fable 2162, slop 8.16, vs Opus 5.5 2050, slop 10.43. En `low`, Fable llama menos a herramientas de búsqueda | Fable gana en estilo según los boards. Opus `low` cuesta 4.3× menos por tarea AA |
| `artistry` | Fable `max` → plan k3 `max` → Opus `xhigh` | LMArena creative: Fable `max` 1486 (#6). EQ-Bench: Astra 2173 ≈ Fable 2162, K3 2082. Ningún board creativo mide effort debajo de `max`. Fable `max`: doble borrador y TTFT de 261 s | La evidencia de creatividad existe solo en `max`; ningún dato muestra que `xhigh` o `high` la pierdan |

## Entradas que hoy no hacen nada o fallan

Ordené las entradas por impacto esperado: qué tan grave es el efecto y qué tan probable es que la entrada se use. No cambié nada.

| # | Entrada | Qué pasa | Confianza | Impacto |
|---|---|---|---|---|
| 1 | `multimodal-looker` → `opencode-go/kimi-k3` (hereda `low`) | V2 solo genera `max`, así que lanza `VariantUnavailableError` y aparece "Failed to drain Session" | **Observado 30×** | Alto: rompe el segundo eslabón de la cadena |
| 2 | `unspecified-low` → `opencode-go/mimo-v2.6-pro` `max` (primario) | El catálogo no tiene variants. Si la delegación pasa el valor crudo, como hizo con Fable `max`, falla en cada uso. Si lo baja, se descarta y MiMo piensa igual | Previsto; no hay usos en los logs | Alto si pasa crudo (la categoría entera cae); nulo si se baja |
| 3 | `atlas`, `sisyphus-junior` → `opencode-go/kimi-k3` y `opencode-go/minimax-m3` (heredan `medium`) | La heurística los emite como variant `medium`, pero V2 solo tiene `max` en uno y `none`/`thinking` en el otro, así que lanza error | Previsto por código | Alto cuando 5.6 Sol y K3 del plan fallan a la vez (por ejemplo, 429 de cuota) |
| 4 | `librarian`, `explore` → `kimi-for-coding-highspeed` `off`; el mismo modelo sin nivel en `quick` | K2.7 Code HighSpeed siempre piensa y el catálogo no le da variants. `#off` debería fallar, pero no aparece en los logs, así que se descarta en algún punto | Docs de Moonshot + código; error no observado | Medio: cada llamada piensa y gasta 3× cuota; con un plan menor a Pro, 401 |
| 5 | `kimi-code-plan-global/k3` con `max` (prometheus, metis, visual-engineering, unspecified-high, writing, artistry) y sin nivel (sisyphus, atlas, sisyphus-junior) | `k3` no coincide con ninguna familia heurística, así que el valor se descarta y corre el default del plan, `high`. Donde el valor pasa crudo, `#max` sí es válido | Previsto por código | Medio: K3 está en 9 cadenas. AA mide 43.6 en `max` y 34.5 en `low`, sin dato para `high` |
| 6 | Claude `xhigh`/`max` como fallback (Opus en oracle, prometheus, metis, momus, visual-engineering y artistry; Fable y Opus en categorías) | La heurística no tiene `xhigh` para Claude ni `max` para Fable, así que el valor se descarta y corre el default de Claude Code (Opus `medium`, Fable `high`). El log de una categoría, sin embargo, muestra `max` de Fable aplicado | Incierto | Medio-alto si se cumple: pasar Opus de `xhigh` a `medium` cuesta −4.8 puntos AA y −7.1 en TB4 |
| 7 | `quick` → `opencode-go/minimax-m3` `max` | No existe el variant `max` (solo `none`/`thinking`). Si pasa crudo, error. Si se baja, no se manda ningún parámetro de thinking y M3 arranca con el thinking apagado en la API de MiniMax | Previsto; la semántica de Go no está documentada | Bajo-medio: es el tercer eslabón |
| 8 | `ultrabrain` → `openai/gpt-5.6-sol` `max` | Válido si pasa crudo. Si se baja, la heurística gpt-5 no incluye `max` y queda como `providerOptions.reasoningEffort` plano, probablemente ignorado, y corre el default `medium` | Incierto | Bajo-medio: es el fallback con el pico de DeepSWE |
| 9 | `librarian`, `explore` → Qwen 3.7 Plus, MiniMax M2.7 y Gemini 3.6 Flash (heredan `off`) | `off` se traduce a `none`, que no está en la escalera de clamp, así que se descarta. Qwen piensa con el presupuesto máximo (262K), M2.7 siempre piensa y Gemini corre en `medium` | Previsto por código + docs | Bajo: son los últimos eslabones, aunque caros o lentos para búsqueda |
| 10 | `quick` → `opencode-go/qwen3.8-flash` sin nivel | Sin variant corre el default de Alibaba en el endpoint Anthropic, `xhigh`, el nivel más caro | Doc de Alibaba; el paso por Go no está verificado | Bajo |
| 11 | `unspecified-low` → `opencode-go/grok-4.7` `xhigh` | Válido si pasa crudo. Si se baja, la heurística grok no tiene `xhigh` y corre el default `high` | Previsto | Nulo en calidad: AA da 46.3 vs 46.4 |
| 12 | `oracle`, `momus` → `opencode-go/glm-5.2` (hereda `xhigh`) | El alias `xhigh→max` termina en `providerOptions` plano; sin variant corre el default del proveedor (`max` en Z.ai) | Previsto | Nulo en effort; el problema es el modelo, que está deprecated |
| 13 | `sisyphus` → `opencode-go/kimi-k3` (hereda `xhigh`) | Se descarta y corre el default de Go para K3, probablemente `max` (sin verificar) | Previsto | Nulo |
| 14 | `momus` → `google/gemini-3.1-pro-preview` `high` | Válido, pero es el mismo valor que el default de la API | Doc de Google | Nulo |

Dos riesgos no entran en la tabla porque no hay ninguna observación. El primero: el runtime fallback prefiere `agentSettings.variant`, que es el `reasoning` crudo del agente. Si eso pisa el nivel de cada entrada, fallarían varios fallbacks: `sisyphus` y `prometheus` mandarían `xhigh` a K3 del plan; `oracle` y `momus` mandarían `xhigh` a GLM-5.2 y a Gemini; y `explore` y `librarian` mandarían `off` a Luna y DeepSeek. El segundo: el hook `think-mode` fuerza `#high` en modelos que no tienen ese variant. Para detectar cualquiera de los dos, busca `Variant unavailable` en `~/.local/share/opencode/log/opencode.log`.

## Conclusión

El eslabón débil de esta config no es la elección de modelos: es la traducción entre OMO y V2. Cada cambio de effort necesita tres verificaciones: que el id exista en `models.json` para ese provider exacto, qué path va a recorrer (default del agente, fallback o categoría) y cuál es el default del proveedor si el valor se descarta. El mismo nombre de modelo se comporta distinto según el endpoint: K3 corre en `high` en el plan de Kimi y en `max` en Go, y DeepSeek usa `high` por default en su API y `max` en Alibaba. Por eso copiar niveles entre cadenas no es seguro. Mientras OMO no lea los variants de V2, la única fuente confiable de qué corre de verdad es el catálogo más el log.

Sobre el fine-tuning, la evidencia dice que el effort importa sobre todo en tres zonas. En los modelos chicos, abajo: Luna `low` → `medium` y Sol `low` → `medium` son los saltos más grandes por dólar. En GPT-6 Sol, arriba, donde `max` todavía rinde. Y en Opus hasta `xhigh`. En casi todo lo demás el nivel es de segundo orden frente al modelo. En `oracle`, por ejemplo, el primario queda 6.9 puntos debajo de su primer fallback, más de lo que cualquier ajuste de effort mueve dentro de un modelo. La cobertura de benchmarks es más pobre justo donde el roster es más exótico: no hay datos de K3 en `high`, de GLM-5.3 en `high` salvo el del vendor, de Grok en `low`/`medium` ni de Gemini por nivel. Para esos modelos, cualquier ajuste va a tener que validarse con tus propias corridas.
