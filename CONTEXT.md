# Reparto

Plugin de orquestación para OpenCode V2: un director reparte el trabajo entre agentes y papeles, y a cada uno lo interpreta un titular con sus suplentes.

## Language

### Lo que se interpreta

**Agente**:
Personaje con guion propio al que se invoca por su nombre.
_Avoid_: actor, persona, subagente

**Papel**:
Tipo de trabajo al que el director enruta tareas y que se ejecuta con el guion de ese papel.
_Avoid_: categoría, category

**Guion**:
Las instrucciones de sistema de un agente o de un papel.
_Avoid_: prompt, system prompt

### Quién lo interpreta

**Actor**:
Un modelo con su variant, o sin variant, que interpreta un agente o un papel.
_Avoid_: intérprete, modelo (cuando se habla del par)

**Titular**:
El actor que interpreta un agente o papel mientras no está de baja.
_Avoid_: primario, default

**Suplente**:
Actor que entra, en orden, cuando el titular y los suplentes anteriores están de baja.
_Avoid_: fallback

**Baja**:
Periodo en que un proveedor o un actor no puede actuar; mientras dura, entran los suplentes.
_Avoid_: cooldown, fuera de servicio

**Variant**:
Id exacto de un variant del catálogo de V2 para un modelo; si se omite, corre el default del proveedor.
_Avoid_: nivel, reasoning, effort

### Encargos

**Encargo**:
Tarea que se delega a un agente o papel con el `subagent` nativo; es una sesión hija nativa (con `parentID`) a la que reparto le impone su actor, y se identifica por esa sesión. `delegar` queda solo como mecanismo interno de `ensayar`.
_Avoid_: task, background task, job

**Bitácora**:
Registro de lo que hizo un encargo: sus tool calls y su mensaje final.
_Avoid_: output, transcript

**Estancado**:
Estado de un encargo que lleva un plazo sin actividad; se le reporta al director, que decide si lo interrumpe.
_Avoid_: stale, colgado

**Pendientes**:
La lista de trabajo de una sesión.
_Avoid_: todos, tareas

### Agentes

**Director** (`director`):
Agente principal: recibe tus pedidos, los reparte entre agentes y papeles y verifica el resultado. No edita.
_Avoid_: orquestador, Sisyphus

**Dramaturgo** (`dramaturgo`):
Agente que escribe planes.
_Avoid_: planificador, Prometheus

**Regidor** (`regidor`):
Agente que ejecuta un plan estrenado.
_Avoid_: Atlas

**Crítico** (`critico`):
Agente que revisa planes.
_Avoid_: revisor, Momus

**Utilero** (`utilero`):
Agente que explora el código del repo.
_Avoid_: explore

**Archivista** (`archivista`):
Agente que busca documentación y código fuera del repo.
_Avoid_: librarian

**Oracle** (`oracle`):
Agente de consulta, de solo lectura, para decisiones difíciles.

### Papeles

**Rápido** (`rapido`):
Papel para cambios mecánicos y acotados, sin decisiones de diseño.
_Avoid_: quick

**Visual** (`visual`):
Papel para todo cambio cuyo resultado se ve.
_Avoid_: visual-engineering

**Protagonista** (`protagonista`):
Papel por defecto para implementar: trabajo que exige entender el código antes de cambiarlo.
_Avoid_: profundo, deep, deep-low

**Estelar** (`estelar`):
Papel al que se escala cuando protagonista falla o vuelve con dudas, cuando oracle marca la tarea como difícil o cuando la corrección depende de invariantes.
_Avoid_: ultrabrain, deep-high

**Prosa** (`prosa`):
Papel para entregables que son texto para personas.
_Avoid_: writing

### Planes

**Plan**:
Documento del dramaturgo con las tareas que ejecuta el regidor.
_Avoid_: boulder, spec

**Ensayo general**:
Revisión en paralelo de un plan por el crítico y oracle en proveedores distintos, repetida en rondas hasta que ambos aprueban la misma versión.
_Avoid_: review loop

**Objeción**:
Observación de un revisor que nombra una sección y un defecto concreto; bloquea el cierre del plan.
_Avoid_: blocker, concern

**Nota**:
Observación de un revisor que no bloquea el cierre del plan.

**Acta**:
Lista de objeciones aceptadas que se congela al terminar la primera ronda de un ensayo; las rondas siguientes solo verifican que se cierren y buscan regresiones.
_Avoid_: ledger, backlog

**Estreno**:
Un plan que pasó el ensayo general y recibió tu visto bueno; desde entonces no cambia.
