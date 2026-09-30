# Solo suplencias: agentes reales y el ensayo antes de plannotator

Reemplaza a los ADR 0006, 0007, 0012 y 0013, y enmienda el 0011.

reparto deja de orquestar. Queda lo que funciona sin que el modelo coopere, más el ensayo:

- **Suplencias** para cualquier agente de V2 con entrada en `reparto.jsonc`: nativos (`build`, `plan`, `explore`, `general`) o de config. El actor se impone en el primer turno de una sesión primaria y en cada hija nativa, y el `retry` cambia de suplente según el tipo de error (ADR 0004).
- **`pendientes`**, la lista de trabajo que sobrevive a la compactación. V2 no trae una nativa.
- **Ensayo general** antes de `submit_plan` (plannotator), obligatorio.
- **Nombres visibles**: `build` se muestra como Solista y `plan` como Compositor. El config de V2 no tiene `name`, así que eso queda en el plugin.

Los agentes viven en la config de V2 como agentes reales, no inyectados por el plugin: `tiresias`, `critico`, `archivista` y el guion del Compositor (`plan.md`) están en `agentes/` del repo, y la config los enlaza (en mi PC) o los copia (`scripts/instalar.sh`, en las que no tienen mis dotfiles). V2 los recarga en caliente, así que cambiar un guion ya no pide `build` y `publicar`. Con `utilero` no hace falta un agente: su papel lo cubre el `explore` nativo, con `shell`, `codegraph_*` y `skill` agregados en `opencode.json`.

Se van el director, el regidor, `/estreno`, la continuación, los papeles, el shell de solo lectura, `bitacora`, `interrumpir` y `migrate-omo`.

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
- El primer prompt tras un reinicio espera la validación, hasta 5 s: V2 la publica unos cientos de ms después del setup, y antes ese primer turno corría con el modelo por defecto.
- Un plan por sesión: un segundo plan en la misma sesión hereda el acta del primero.
- Las tablas de encargos, estrenos y continuaciones quedan huérfanas en las bases viejas; no se borran.
