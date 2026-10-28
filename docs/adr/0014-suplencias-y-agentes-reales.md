# Solo suplencias: agentes reales y el ensayo antes de plannotator

Reemplaza a los ADR 0006, 0007, 0012 y 0013, y enmienda el 0011.

reparto deja de orquestar. Queda lo que funciona sin que el modelo coopere, más el ensayo:

- **Suplencias** para cualquier agente de V2 con entrada en `reparto.jsonc`: nativos (`build`, `plan`, `explore`, `general`) o de config. El actor se impone en cada hija nativa y en el primer turno de una sesión primaria que llega sin modelo; el modelo que el cliente eligió para el primer mensaje se respeta, igual que el `model` explícito de un `subagent` en su hija. El `retry` cambia de suplente según el tipo de error (ADR 0004).
- **Ensayo general** antes de `submit_plan` (plannotator), obligatorio.
- **Nombres visibles**: `build` se muestra como Solista y `plan` como Compositor. El config de V2 no tiene `name`, así que eso queda en el plugin.

Los agentes viven en la config de V2 como agentes reales, no inyectados por el plugin: `tiresias`, `critico`, `archivista` y el guion del Compositor (`plan.md`) están en `agentes/` del repo, y la config los enlaza (en mi PC) o los copia (`scripts/instalar.sh`, en las que no tienen mis dotfiles). V2 los recarga en caliente, así que cambiar un guion ya no pide `build` y `publicar`. Con `utilero` no hace falta un agente: su papel lo cubre el `explore` nativo, con `shell`, `codegraph_*` y `skill` agregados en `opencode.json`.

Se van el director, el regidor, `/estreno`, la continuación, los papeles, el shell de solo lectura, `bitacora`, `interrumpir`, `migrate-omo` y `pendientes`.

## Por qué

En los tres días de uso con el director hubo 6 suplencias reales, 2 de ellas salvando sesiones de Opus, y hubo 0 ensayos, 0 estrenos y una sola sesión del dramaturgo. El director sí repartía (31 encargos a `rapido` y 23 a `protagonista`), pero porque los permisos lo obligaban, y el modelo peleaba contra el shell de solo lectura. Lo que dependía de que el modelo siguiera un protocolo largo (tabla de ruteo, formato de encargo, tareas congeladas) generaba fricción. Lo que corre en hooks funcionó sin que nadie lo notara.

El ensayo es la excepción: depende de que el modelo lo llame, y la lección del ADR 0006 es que una guía en el prompt no alcanza. Por eso un hook rechaza `submit_plan` mientras la sesión no tenga un ensayo cerrado o llegado a la ronda 5. `submit_plan` es una tool de plugin y no pide permiso, así que `permission.evaluate` no la ve: el gate va en `tool.execute.before`. Si no hay revisores disponibles, el plan pasa y la revisión queda solo en manos de Bryan.

El Compositor es el `plan` nativo porque plannotator ya lo tiene como agente de planificación. Con plannotator el plan no es un archivo que escribe el agente: llega por `submit_plan`, y plannotator lo guarda en su propio directorio. Por eso `ensayar` recibe el texto del plan y guarda las rondas, las versiones y el acta con el id de la sesión como clave.

## Considered Options

- Dejar al director con el shell abierto. La queja era el shell, pero Bryan no usaba al director, y sin permisos que lo obliguen un modelo delega 0.1 tareas por sesión (ADR 0006).
- Subagentes con nombre de modelo (`sol`, `k3`). Un agente que se llama `sol` y corre K3 cuando `sol` está de baja miente sobre lo que es.
- Guiones en los dotfiles. Fue la primera versión, pero la PC del trabajo no tiene mis dotfiles, y los guiones son parte del contrato de `ensayar`: viajan con el plugin.
- `ensayar` leyendo el directorio del `plan` nativo. Con plannotator el plan nunca llega ahí, y leer el archivo de plannotator ata a reparto a sus detalles internos.

## Consequences

- Opus hace todo el trabajo: la cuota de Claude se gasta antes, y las suplencias pasan a ser el único control de cuota. El orden de los suplentes de `build` importa más.
- Los permisos de solo lectura se escriben a mano en cada `.md`, con la base repetida al final, porque gana la última regla que coincide. Un `deny *` seguido de `allow read` sin volver a negar `.env` reabre `.env`.
- `ensayar` depende de que `critico` y `tiresias` existan fuera del plugin. Si faltan, `validar` lo avisa en el log (`agente inexistente en V2`) y `ensayar` falla.
- Los revisores del ensayo son sesiones sin `parentID`, para que el hook de hijas no les cambie el actor. Por eso un pedido de permiso no le aparece a nadie y colgaría la ronda: la sesión del revisor niega `external_directory`, el único `ask` que le queda.
- OpenChamber y la TUI siempre mandan un modelo antes del primer prompt (S10; en el log, todas las imposiciones de primer turno tenían `antes`), así que el titular de una sesión primaria solo entra en sesiones creadas por API sin modelo o por una suplencia. Imponerlo siempre pisaba lo elegido, incluidas las tareas programadas.
- V2 crea la hija con `model ?? agent.model ?? modelo del padre` y no guarda si el modelo fue pedido. reparto anota el `model` del `subagent` en `tool.execute.before`, la hija que nace con él lo conserva en todos sus turnos (`elegido/<sesión>` en `ctx.storage`), y el permiso no se niega aunque los actores del agente estén de baja.
- El primer prompt tras un reinicio espera la validación, hasta 5 s: V2 la publica unos cientos de ms después del setup, y antes ese primer turno corría con el modelo por defecto.
- Un plan por sesión: un segundo plan en la misma sesión hereda el acta del primero.
- `pendientes` se quitó después: se usó en 4 sesiones en cinco días, y OpenChamber ya trae Todos y planes con checklist que Bryan ve en el panel. Lo que se pierde es la lista de pasos de la tarea en curso que sobrevivía a la compactación; los Todos de OpenChamber son el backlog del proyecto, no esa lista.
- Las tablas de encargos, estrenos, continuaciones y pendientes quedan huérfanas en las bases viejas; no se borran.
