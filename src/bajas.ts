import { etiqueta, modelRef, siguiente } from './actores.ts'
import { type Actor, type Config, plazoMs } from './config.ts'
import { db, write } from './db.ts'
import { log } from './log.ts'
import { proceso } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { Plugin } from '@opencode/plugin'
import type { SessionRetry } from '@opencode/plugin/promise/session'
import type { Database } from 'bun:sqlite'

export interface Baja {
  tipo: 'proveedor' | 'actor'
  /** ProviderID, o `<provider>/<model>#<variant>` para una baja de actor. */
  id: string
  motivo: string
  /** Ms epoch */
  hasta: number
}

// La última información gana: el reset que informa el proveedor reemplaza al anterior.
export const registrarBaja = (db: Database, baja: Baja) =>
  write(db, 'registrar baja', () =>
    db
      .query(
        `INSERT INTO bajas (tipo, id, motivo, hasta) VALUES ($tipo, $id, $motivo, $hasta)
         ON CONFLICT (tipo, id) DO UPDATE SET motivo = excluded.motivo, hasta = excluded.hasta`,
      )
      .run({ ...baja }),
  )

export const bajasVigentes = (db: Database, ahora = Date.now()): Baja[] =>
  db
    .query<Baja, { ahora: number }>('SELECT tipo, id, motivo, hasta FROM bajas WHERE hasta > $ahora ORDER BY hasta')
    .all({ ahora })

export const deBaja = (bajas: readonly Baja[]) => (actor: Actor) =>
  bajas.some(
    (baja) =>
      (baja.tipo === 'proveedor' && baja.id === actor.model.split('/')[0]) ||
      (baja.tipo === 'actor' && baja.id === etiqueta(actor)),
  )

// ---------- Clasificador (S3) ----------

/** Cuerpo del último error de una request `primary`, con el actor que lo recibió. */
export interface ErrorCrudo {
  actor: string
  cuerpo: string
  headers: Record<string, string>
}

type Clase =
  | { tipo: 'cuota'; hasta?: number }
  | { tipo: 'velocidad' }
  | { tipo: 'interno' }
  | { tipo: 'auth' }
  | { tipo: 'otro' }

/**
 * Las requests de título, compactación y `generate` comparten `sessionID` (session.d.ts): solo se guarda el
 * error de las `primary`, y cada error nuevo reemplaza al anterior.
 */
export function guardarError(errores: Map<string, ErrorCrudo>, sessionID: string, kind: string, crudo: ErrorCrudo) {
  if (kind === 'primary') {
    errores.set(sessionID, crudo)
  }
}

/** El `retry` consume el error guardado; un cuerpo de otro actor (anterior a un cambio) no cuenta. */
export function tomarError(errores: Map<string, ErrorCrudo>, sessionID: string, actor: string): ErrorCrudo | undefined {
  const crudo = errores.get(sessionID)

  errores.delete(sessionID)

  return crudo?.actor === actor ? crudo : undefined
}

const json = (texto: string) => {
  try {
    const entrada: unknown = JSON.parse(texto)

    if (!esRegistro(entrada)) {
      return undefined
    }

    return {
      error: esRegistro(entrada.error) ? entrada.error : undefined,
      headers: esRegistro(entrada.headers) ? entrada.headers : undefined,
    }
  } catch {
    return undefined
  }
}

const numero = (entrada: unknown) => {
  if (typeof entrada === 'number') {
    return entrada
  }

  if (typeof entrada === 'string' && entrada.trim() && Number.isFinite(Number(entrada))) {
    return Number(entrada)
  }

  return undefined
}

/** Segundos o ms epoch, o una fecha ISO. */
const instante = (entrada: unknown): number | undefined => {
  const numeroValor = numero(entrada)

  if (numeroValor !== undefined) {
    if (numeroValor <= 0) {
      return undefined
    }

    return numeroValor < 1e12 ? numeroValor * 1000 : numeroValor
  }

  const fechaValor = typeof entrada === 'string' ? Date.parse(entrada) : NaN

  return Number.isFinite(fechaValor) ? fechaValor : undefined
}

/** Reset informado por el proveedor: el cuerpo (`resets_at` en OpenAI y `claude-code`) y después los headers. */
export function reset(crudo: ErrorCrudo, ahora = Date.now()): number | undefined {
  const cuerpo = json(crudo.cuerpo)
  const error = cuerpo?.error ?? {}
  // El frame de error de OpenAI trae sus headers adentro (S3)
  const headers = Object.fromEntries(
    Object.entries({ ...crudo.headers, ...cuerpo?.headers }).map(([clave, valor]) => [clave.toLowerCase(), String(valor)]),
  )
  const relativo = (entrada: unknown) => {
    const numeroValor = numero(entrada)

    return numeroValor !== undefined ? ahora + numeroValor * 1000 : undefined
  }

  return (
    instante(error.resets_at) ??
    relativo(error.resets_in_seconds) ??
    instante(headers['x-codex-primary-reset-at']) ??
    instante(headers['x-claude-rate-limit-reset']) ??
    relativo(headers['retry-after'])
  )
}

/** Parte del `error.type` que ya pone V2 y lo corrige con el cuerpo, si hay uno del mismo actor. */
export function clasificar(error: { type: string }, crudo: ErrorCrudo | undefined, ahora = Date.now()): Clase {
  const cuerpo = crudo && json(crudo.cuerpo)

  switch (error.type) {
    case 'provider.quota': {
      return { tipo: 'cuota', hasta: crudo && reset(crudo, ahora) }
    }

    case 'provider.rate-limit': {
      // El límite de suscripción de claude-code llega como velocidad y V2 lo reintentaría cada 15 min (S3)
      if (cuerpo?.error?.code === 'claude_session_limit') {
        return { tipo: 'cuota', hasta: reset(crudo!, ahora) }
      }

      return { tipo: 'velocidad' }
    }

    case 'provider.internal': {
      return { tipo: 'interno' }
    }

    case 'provider.auth': {
      return { tipo: 'auth' }
    }

    default: {
      return { tipo: 'otro' }
    }
  }
}

// ---------- Suplencias: el cambio de actor dentro del hook `retry` (S8) ----------

/** `provider/model#variant` de un Model.Ref, con `default` cuando V2 no reporta variant. */
const claveModelo = (modelo: { providerID: string; id: string; variant?: string }) =>
  `${modelo.providerID}/${modelo.id}#${modelo.variant ?? 'default'}`

const PLAZO_BAJA = '5h'
const FALLOS_INTERNOS = 3

const errores = () => (proceso.errores ??= new Map())
const fallos = () => (proceso.fallos ??= new Map())

function guardar(
  sessionID: string,
  kind: string,
  model: { providerID: string; id: string; variant?: string },
  cuerpo: string,
  headers: Record<string, string>,
) {
  guardarError(errores(), sessionID, kind, { actor: claveModelo(model), cuerpo, headers })
}

export function suplencias(ctx: Plugin.Context, config: Config) {
  async function retry(reintento: SessionRetry) {
    const actual = {
      providerID: String(reintento.model.providerID),
      id: String(reintento.model.id),
      variant: reintento.model.variant && String(reintento.model.variant),
    }
    const clase = clasificar(reintento.error, tomarError(errores(), reintento.sessionID, claveModelo(actual)))

    log.info('retry', {
      sessionID: reintento.sessionID,
      agent: reintento.agent,
      actor: claveModelo(actual),
      attempt: reintento.attempt,
      error: reintento.error.type,
      clase,
      decisionV2: reintento.decision,
    })

    if (clase.tipo === 'velocidad' || clase.tipo === 'otro') {
      return
    } // El reintento nativo ya respeta retry-after

    if (clase.tipo === 'interno') {
      // `attempt` es el número del próximo intento de la ejecución, no de fallos del actor (S3): se cuentan acá
      const previo = fallos().get(reintento.sessionID)
      const intentos = previo?.actor === claveModelo(actual) ? previo.n + 1 : 1

      fallos().set(reintento.sessionID, { actor: claveModelo(actual), n: intentos })

      if (intentos < (config.fallosInternos ?? FALLOS_INTERNOS)) {
        return
      }
    }

    if (clase.tipo === 'cuota') {
      const proveedor = actual.providerID
      const hasta = clase.hasta ?? Date.now() + plazoMs(config.proveedores?.[proveedor]?.plazoBaja ?? PLAZO_BAJA)

      registrarBaja(db(), { tipo: 'proveedor', id: proveedor, motivo: `cuota: ${reintento.error.message}`, hasta })
      log.warn('baja', {
        proveedor,
        hasta: new Date(hasta).toISOString(),
        reset: clase.hasta !== undefined,
        sessionID: reintento.sessionID,
      })
    }

    const validacion = proceso.validacion
    const agente = String(reintento.agent)

    if (!validacion?.actores.has(agente)) {
      return
    } // Sesión sin reparto: queda la decisión de V2

    const suplente = siguiente(validacion, agente, actual, deBaja(bajasVigentes(db())))

    if (!suplente) {
      reintento.decision = { retry: false }
      log.warn('sin suplente', { sessionID: reintento.sessionID, agente, actor: claveModelo(actual), clase: clase.tipo })

      return
    }

    await ctx.session.switchModel({ sessionID: reintento.sessionID, model: modelRef(suplente) })
    reintento.decision = { retry: true, delay: 0 }
    errores().delete(reintento.sessionID)
    fallos().delete(reintento.sessionID)
    const motivo = {
      cuota: 'cuota agotada',
      interno: `${config.fallosInternos ?? FALLOS_INTERNOS} fallos seguidos del proveedor`,
      auth: 'error de autenticación',
    }[clase.tipo]

    // La sesión ya muestra el cambio (marca model-switched de V2). No se le inyecta un mensaje: un `synthetic` que
    // Llega después de la respuesta abre un paso más, y en un encargo esa respuesta pisaba el mensaje final.
    log.info('suplente', {
      sessionID: reintento.sessionID,
      agente,
      de: claveModelo(actual),
      a: etiqueta(suplente),
      motivo,
    })
  }

  return { guardar, retry }
}
