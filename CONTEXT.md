# Reparto

Plugin de suplencias para OpenCode V2: a cada agente lo interpreta un titular y, si está de baja, entra su suplente. Además hace obligatorio el ensayo general de los planes.

## Language

### Lo que se interpreta

**Agente**:
Un agente de V2 con entrada en `reparto.jsonc`: nativo (`build`, `plan`, `explore`, `general`) o definido en la config de V2 (`agents/*.md`).
_Avoid_: persona, subagente (cuando se habla del reparto)

**Guion**:
Las instrucciones de sistema de un agente; en un `.md` de agente, el cuerpo.
_Avoid_: prompt, system prompt

### Quién lo interpreta

**Actor**:
Un modelo con su variant, o sin variant, que interpreta un agente.
_Avoid_: intérprete, modelo (cuando se habla del par)

**Titular**:
El actor que interpreta un agente mientras no está de baja.
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

**Pendientes**:
La lista de trabajo de una sesión.
_Avoid_: todos, tareas

### Agentes

**Solista** (`build`):
El agente nativo con el que se trabaja: implementa y ejecuta los planes aprobados.
_Avoid_: director, Sisyphus

**Compositor** (`plan`):
El agente nativo de planificación con el guion de reparto: entrevista, escribe el plan, lo ensaya y lo manda a plannotator.
_Avoid_: planificador, Dramaturgo, Prometheus

**Crítico** (`critico`):
Agente que revisa planes en el ensayo general.
_Avoid_: revisor, Momus

**Tiresias** (`tiresias`):
Agente de consulta, de solo lectura, para decisiones difíciles; también revisa planes en el ensayo general (antes `oracle`).

**Archivista** (`archivista`):
Agente que busca documentación y código fuera del repo.
_Avoid_: librarian

### Planes

**Plan**:
Documento del Compositor con las tareas que ejecuta Solista.
_Avoid_: boulder, spec

**Ensayo general**:
Revisión en paralelo de un plan por el crítico y tiresias en proveedores distintos, repetida en rondas hasta que ambos aprueban la misma versión. Es obligatorio antes de `submit_plan`.
_Avoid_: review loop

**Objeción**:
Observación de un revisor que nombra una sección y un defecto concreto; bloquea el cierre del plan.
_Avoid_: blocker, concern

**Nota**:
Observación de un revisor que no bloquea el cierre del plan.

**Acta**:
Lista de objeciones aceptadas que se congela al terminar la primera ronda de un ensayo; las rondas siguientes solo verifican que se cierren y buscan regresiones.
_Avoid_: ledger, backlog
