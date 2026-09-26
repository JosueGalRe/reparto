# Suplentes: el tipo de error decide a quién da de baja

Cuando falla una llamada a un modelo, el alcance depende del tipo de error:

- **Cuota agotada**: da de baja al proveedor entero, en todas las sesiones, agentes y papeles, hasta el reset que informe el proveedor. Si no lo informa, la baja dura hasta que vence un plazo configurable por proveedor.
- **5xx o timeout**: se reintenta el mismo actor, y el suplente entra después de N fallos.
- **Auth**: entra el suplente y se avisa de forma visible.

El turno que falló se reintenta con el suplente, sin reenviar el mensaje del usuario, y la sesión avisa quién entró. Cuando vence la baja, el titular vuelve en las sesiones nuevas, y en la sesión del director al empezar tu siguiente turno. La sesión de un papel conserva su actor hasta terminar, para no perder el prompt cache a mitad del trabajo. Las bajas se guardan en la base de estado de reparto (ADR 0010), así que sobreviven a los reinicios y las comparten todos los procesos de OpenCode.

El caso real es el límite semanal de OpenAI: agota la cuenta, o sea todos los modelos `openai/*`, y dura días. El cooldown de OMO, de 5 h, por modelo y en memoria, lo trataba como un fallo pasajero de un solo modelo.

## Consequences

- El hook `retry` de V2 solo decide si reintentar y con cuánto delay: `model` y `providerID` son de solo lectura. Pero un `session.switchModel` dentro del hook, seguido de `{ retry: true, delay: 0 }`, hace que el reintento salga con el suplente en el mismo turno, sin prompt nuevo (sonda S8). Así lo implementa reparto.
- V2 ya trae el tipo de error en el `retry` (`provider.quota`, `provider.rate-limit`, `provider.internal`, `provider.auth`) y por defecto no reintenta cuota ni auth. reparto lo usa como base y lo corrige con el cuerpo del error, que lee en `http.response`, o en `experimental.ws.receive` para `openai`, que va por WebSocket (sonda S3). De ahí sale también el reset.
- El límite de suscripción de `claude-code` llega como `provider.rate-limit` (429 con `code: "claude_session_limit"`), y V2 lo reintentaría cada 15 min. reparto lo trata como cuota.
- Un 429 por límite de velocidad, incluido el que provoca la propia concurrencia de reparto, no es cuota agotada y no da de baja al proveedor.
- Si algún proveedor resulta tener cuota por modelo, para ese proveedor la baja se aplica por actor.
