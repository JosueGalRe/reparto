# Encargos con una tool propia

reparto delega con una tool propia, `delegar`, y les niega el `subagent` nativo al director y a `build`. La tool:

- resuelve el actor según el titular, los suplentes y las bajas;
- crea la sesión hija con `session.create`, con el padre en `metadata`;
- carga los skills pedidos;
- la corre de forma sincrónica o en background;
- y retoma una sesión anterior por su id.

El id de un encargo es el de su sesión hija, sin un segundo id como el `bg_…` de OMO. Cuando el encargo termina, el aviso trae su mensaje final. `bitacora` agrega las tool calls y, con detalle completo, sus resultados.

El aviso al padre es un solo `session.prompt({ delivery: "queue" })`: cabecera visible, resultado recortado y pista de `bitacora` en texto plano. OpenChamber oculta y fusiona mensajes de usuario totalmente sintéticos, `prompt` solo acepta `text`, y el intento de enviar primero un `synthetic` y luego un `prompt` produjo dos turnos del director.

El `subagent` nativo elige el agente pero no el actor, no sabe de bajas y no tiene background. Las hijas no se crean con `fork`, porque copiaría todo el historial del padre a un agente que debería empezar solo con un brief.

## Consequences

- Las sesiones hijas nunca se borran (en OMO se borraban a los 10 min por defecto). Un encargo sin actividad durante un plazo se le reporta al director como estancado, y él decide si lo interrumpe.
- Un encargo se da por terminado solo si su ejecución cerró y además hay salida: OMO vio sesiones idle antes de que el hijo escribiera algo. En V2 la ejecución la cierran `session.execution.succeeded`, `.failed` o `.interrupted`, y `session.get().outcome` confirma cuál fue (sonda S13).
- Las tool calls de la bitácora se registran con `execute.after` en la base de reparto, porque una compactación las borra de `session.context` (sonda S14).
- Un encargo vive en el proceso que lo creó: si ese proceso muere, la hija queda sin `outcome` y el encargo se da por fallido (sonda S15).
- La concurrencia de encargos se limita por proveedor, y lo que pasa del límite entra en cola.
- La UI no agrupa las hijas bajo el padre. `session.import` con `parentID` lo haría, pero no está en el `ctx.session` que recibe el plugin, así que no se usa.
