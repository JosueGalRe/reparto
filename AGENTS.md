# Convenciones de reparto

- Bun y TypeScript estricto. `bun run check` debe pasar antes de cada commit (tipos, lint, formato y tests).
- `oxfmt`: 128 columnas, sin punto y coma, comillas simples y comas finales. Llaves siempre; línea en blanco entre bloques lógicos y antes de `return`.
- Nombres descriptivos, nunca identificadores de una letra. `import type` para tipos; evitar `as` (salvo `as const`) y ternarios anidados.
- Archivos en kebab-case; módulos de apoyo `-types.ts` y `-utils.ts`. Tests en `test/`.
- Commits `tipo(ámbito): resumen` en español, según `git log`.
- Identificadores de dominio en español sin tildes ni ñ (ADR 0003); guiones en inglés (ADR 0008); documentación en español.
- Agentes: no usar `pty_*`. Iniciar servidores de desarrollo en el puerto 4297 con `scripts/run.sh serve --port 4297` (`REPARTO_DATA_DIR` ya queda aislado). Nunca usar el servidor diario.
