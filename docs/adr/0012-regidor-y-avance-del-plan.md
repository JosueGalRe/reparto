# Regidor propio, plan inmutable y avance en SQLite

**Reemplazado por el [ADR 0014](./0014-suplencias-y-agentes-reales.md).** Solista ejecuta el plan que Bryan aprueba en plannotator.

El regidor es un agente propio y no el director con un plan cargado. Tiene la misma restricción de no editar y las mismas tools, pero otra conducta: ejecuta el plan al pie de la letra, no rediseña y avisa cuando algo se desvía. `/estreno <plan>` convierte la sesión actual si no tiene mensajes; si ya los tiene, abre una sesión nueva y limpia con el plan cargado.

Los planes viven en el repo, en `.reparto/planes/<slug>.md`, y el dramaturgo solo puede escribir ahí. Desde el estreno el archivo no se edita: el avance se guarda en SQLite, atado a la versión estrenada, y cada tarea del plan corresponde a un pendiente del regidor. Una sesión nueva del regidor sobre el mismo plan retoma donde quedó la anterior. La continuación automática, que le pide seguir cuando queda libre con tareas sin terminar, aplica solo en sesiones del regidor.

## Consequences

`/estreno` se niega a correr si el archivo ya no coincide con la versión estrenada.

La autorización de `/estreno` es una frontera de conducta, no un sandbox: cualquier agente con shell podría técnicamente escribir la base SQLite. Se acepta esa limitación, con el mismo criterio que ADR 0006.
