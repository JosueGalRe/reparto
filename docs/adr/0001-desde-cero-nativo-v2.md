# Plugin nativo de V2 desde cero, sin fork de OMO

`reparto` se escribe desde cero contra la API de plugins de V2 (`@opencode/plugin`) y no pasa por `opencode-v1-compat`. `omo-opencode` es un plugin V1 que hoy corre sobre ese shim. Un fork recortado aportaría plomería V1 que igual habría que reescribir hook por hook, dentro de un monorepo con Codex, Senpi y binarios nativos que no se usan.

OMO se usa como referencia, y se pueden tomar piezas cuando la situación lo requiera. reparto es de uso personal, y la SUL-1.0 lo permite siempre que los archivos que traen código o texto de OMO conserven su aviso de licencia. Del código MIT (`opencode-ensemble`, `opencode-background-agents`) también se pueden tomar piezas, con atribución.

## Considered Options

- Fork recortado y portado a V2.
- Fork que sigue en el shim y se migra después.
