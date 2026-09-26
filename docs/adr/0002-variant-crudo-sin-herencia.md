# Variant crudo del catálogo V2, sin traducción ni herencia

Cada titular y cada suplente declara el id exacto de un variant del catálogo de V2 para su modelo (`xhigh`, `max`, `thinking`…) o lo omite, y en ese caso corre el default del proveedor sin mandar variant. No hay nivel abstracto, ni tabla de mapeo, ni herencia del variant de otra entrada. Todos los bugs de razonamiento que encontramos en OMO vinieron de su capa de traducción heurística y de la herencia de `reasoning` entre entradas. Además, los ids cambian por modelo (kimi-k3 en opencode-go solo tiene `max`; MiniMax solo `none` y `thinking`), así que cualquier abstracción termina mintiendo en algún modelo.

## Consequences

Cambiar un modelo obliga a revisar su variant. Lo compensa la validación contra el catálogo de V2.
