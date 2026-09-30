# Cinco papeles, sin comodín

**Reemplazado por el [ADR 0014](./0014-suplencias-y-agentes-reales.md).** Sin director no hay quien enrute a los papeles.

Hay cinco papeles: `rapido`, `visual`, `protagonista`, `estelar` y `prosa`. Ninguno es comodín. Un papel existe solo si su regla de ruteo se puede enunciar en positivo y si su reparto es distinto al de los demás. En OMO, `unspecified-*` se definía por exclusión y absorbió 224 tareas mientras las reglas fueron difusas, y `deep-high` y `ultrabrain` tenían casi el mismo reparto. A `estelar` se llega por escalamiento, no porque la tarea "parezca difícil", para no devolverle el criterio al modelo. `protagonista` es el default explícito.
