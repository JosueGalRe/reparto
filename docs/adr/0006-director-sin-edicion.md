# El director no edita: los permisos lo obligan a delegar

El director no tiene `edit`, `write` ni `patch`, y bash queda limitado a comandos de lectura (`rg`, `git status`, `git diff`…) con reglas de permiso de V2. Lee, busca, planea, delega y verifica, y todo cambio pasa por un papel. Con la guía de categorías solo en el prompt, Opus lanzó 0.1 tareas por sesión: si se deja a criterio del modelo, no reparte el trabajo. Para trabajar directo está el agente `build` nativo.

## Considered Options

- Dejar que el director haga ediciones chicas. No se puede imponer con permisos, y vuelve a quedar a criterio del modelo.
- Poner solo una tabla de ruteo en el guion. Es lo que ya falló con OMO.

## Consequences

- Un typo cuesta un round-trip a `rapido`.
- Para los follow-ups, el director retoma la sesión del papel en vez de abrir una nueva en frío.
- Si la fricción molesta, el siguiente paso es un presupuesto de edición en un hook, no quitar la restricción.
- Delegar no baja el costo total, lo reparte entre proveedores.
- Las reglas de V2 ya exigen que cada tramo de `;`, `&&`, `|` y `$( )` esté permitido, y ocultan al modelo las tools negadas. La redirección (`>`) y `--output` quedan dentro de un tramo permitido y pasan, así que reparto los niega en `ctx.permission.hook("evaluate")` (sonda S7).
- La frontera es de conducta, no un sandbox: busca que el director delegue en lugar de tomar atajos (`sed -i`, heredoc, `>`), no aislarlo de un modelo hostil. Por eso no se cierran los caminos que dependen de la configuración del usuario, como un driver de diff definido en git. Sí se cierran los que un modelo usaría como atajo: `git difftool`, `--ext-diff`, `--textconv` y las tools de PTY.
