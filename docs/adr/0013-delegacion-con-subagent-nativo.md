# Encargos con el `subagent` nativo

Reemplaza al ADR 0009.

reparto delega con el `subagent` nativo de V2 (`background: true`, continuación con `sessionID`) y agrega lo suyo con hooks sobre las sesiones hijas. La tool propia `delegar` queda solo como maquinaria interna de `ensayar`, que necesita una espera sincrónica. El director, el regidor y `build` usan `subagent`.

## Por qué el ADR 0009 estaba mal

El ADR 0009 descartó el `subagent` nativo por tres motivos: no elige el actor, no sabe de bajas y no tiene background. El tercero era falso. El background existe en todas las versiones de V2 desde 2.0.0 (2026-09-11); se verificó en los binarios de las 19 versiones. El error vino de buscar en el binario el nombre del parámetro de OMO, `run_in_background`, en lugar del concepto. Regla para las sondas: se lee el schema de la tool nativa; no se grepea el binario con los nombres de otra tool. Los otros dos motivos se resuelven con hooks.

## Evidencia

Sondas del 2026-09-27 en el servidor de desarrollo, sesiones `ses_f1e9cc46effeOxyuZr4fjRsSrH` y `ses_f1e9469f3ffe4FweGJDO7HeNOZ`:

- `subagent` acepta papeles ocultos como `agent`, y la hija nace con un `parentID` real.
- La hija hereda el modelo del padre por defecto, pero un hook `prompt` que mira el agente de la hija puede hacer `switchModel` (modelo y variant) antes de la primera request, y gana sobre el parámetro `model` nativo.
- El hook `retry` se dispara con el `sessionID` de la hija y el cambio al suplente funciona.
- `execute.after` se dispara dentro de las hijas, así que la bitácora funciona.
- La continuación con `sessionID` conserva la hija, su historial y su `parentID`, y el hook del actor se vuelve a aplicar.
- Pasar otro `agent` al continuar cambia el agente de la hija; se debe pasar el mismo. La permission `subagent` recibe como `resource` el id del agente destino (`resources: [X.id]` en V2 2.0.18).
- El hook `context` puede inyectar un SKILL.md en el guion de una hija (`ev.system.push`).
- OpenChamber agrupa las hijas bajo el padre, muestra si están trabajando o terminadas y presenta los permisos que pide una hija como tarjetas en la vista del padre.
- El fin llega al padre como un mensaje `synthetic` nativo (source: subagent).

## Decisiones

1. **Se elimina la cola por proveedor.** Esperar dentro del hook `prompt` serializa las hijas, pero bloquea la tool call del padre y anula el background. Es una simplificación deliberada; la vía de vuelta es una cola global en SQLite, si el tope por proveedor vuelve a hacer falta por 429 propios.
2. **Skills.** La hija los carga con la tool nativa `skill`: el brief los nombra y el guion del papel dice que los cargue primero. Plan B, si una hija los ignora: inyectarlos con el hook `context`.
3. **Qué se retira y qué se conserva.** Para las hijas nativas se retiran los avisos visibles de encargo, los avisos de permisos pendientes y la reconciliación al arrancar. Se conservan el actor por hook, las bajas y suplentes, la bitácora, `interrumpir` (propiedad por `parentID`) y un vigilante de estancados más simple, basado en eventos. `ensayar` mantiene el mecanismo interno y el aviso de permiso para sus revisores sin `parentID` nativo.

## Consequences

- `src/encargos.ts` se achica: sin cola, sin avisos, sin reconciliación.
- La UX nativa de OpenChamber reemplaza los avisos que construimos: agrupación, estado y permisos de las hijas.
- El id de un encargo sigue siendo el de su sesión hija, ahora con `parentID` nativo en lugar de `metadata.padre`.
- Las hijas nativas no tienen fila de estado propia por ejecución; la sesión hija es la fuente de verdad y reparto guarda solo actor y bitácora.
- El director, el regidor y `build` recuperan `subagent` en sus permisos y pierden `delegar`.
- Un encargo sigue viviendo en el proceso que lo creó (S15). Sin reconciliación, una hija perdida en un reinicio no se marca `fallida`: el padre la ve sin respuesta y decide.
- En cada upgrade se hace también un diff del schema de las tools nativas sacado del binario, no solo de los tipos del SDK.
