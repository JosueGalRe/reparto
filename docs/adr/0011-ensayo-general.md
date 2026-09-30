# Ensayo general: revisores en proveedores distintos, cierre por versión aprobada

**Enmendado por el [ADR 0014](./0014-suplencias-y-agentes-reales.md).** `ensayar` recibe el texto del plan, guarda las rondas por sesión y es obligatorio antes de `submit_plan`; no hay estreno.

Un plan lo revisan en paralelo el crítico y tiresias. Cada revisor corre con el primer actor de su reparto cuyo proveedor no esté ocupado por el otro revisor ni por el dramaturgo, y que no esté de baja: un modelo que revisa un plan de su propia familia comparte sus puntos ciegos. Si las bajas no dejan proveedores distintos, el ensayo corre igual y el plan queda marcado como "con proveedores repetidos".

El plan se cierra cuando todos los revisores aprueban la misma versión. Una objeción bloquea solo si nombra una sección y un defecto concreto; todo lo demás es una nota. Entre rondas, solo el dramaturgo corrige, con cambios mínimos. Después de 5 rondas sin cierre, decides tú con las objeciones abiertas. Un plan cerrado se estrena solo con tu visto bueno.

Cada ronda es un encargo nuevo por revisor, sin retomar la sesión de la ronda anterior. Así, una ronda que se corta con un reinicio no arrastra nada, y el revisor no se ancla en su razonamiento anterior ni acumula contexto. Todo lo que necesita de rondas previas va en el prompt.

La primera ronda descubre. Al terminarla, las objeciones aceptadas de los dos revisores se congelan en el **acta**, cada una con su causa y la condición que la cierra. Las rondas siguientes cierran: cada revisor recibe el plan, el diff contra la ronda anterior y el acta, verifica que cada objeción del acta esté cerrada y busca regresiones que hayan causado los arreglos. No vuelve a revisar el texto que no cambió. Una objeción nueva entra al acta solo si la causó un arreglo, si depende de un hecho que antes no se podía verificar o si es un riesgo concreto de pérdida de datos o de seguridad, y tiene que decir por qué la primera ronda no pudo encontrarla. Si no, es una nota. Sin esta regla, cada ronda encuentra algo nuevo en texto que no cambió y el ensayo no converge.

## Considered Options

- Mantener a Metis como tercer revisor. Tuvo 4 sesiones en 60 días, y su análisis de huecos cabe en la entrevista del dramaturgo.
- Estrenar automáticamente al cerrar. Así, un plan que solo leyeron modelos se ejecutaría sin que lo hayas leído tú.
- Retomar la sesión del revisor en cada ronda. Ahorra releer el plan, pero una ronda se pierde si el proceso muere (pasó en el ensayo del propio plan de reparto) y el revisor tiende a confirmar lo que ya dijo.
