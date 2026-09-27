import type { Database } from "bun:sqlite";
import type { Plugin } from "@opencode/plugin";
import type { SessionRetry } from "@opencode/plugin/promise/session";
import { etiqueta, modelRef, siguiente } from "./actores.ts";
import { type Actor, type Config, plazoMs } from "./config.ts";
import { db, write } from "./db.ts";
import { abiertos, moverCupo } from "./encargos.ts";
import { log } from "./log.ts";
import { proceso } from "./process.ts";

export interface Baja {
  tipo: "proveedor" | "actor";
  /** providerID, o `<provider>/<model>#<variant>` para una baja de actor. */
  id: string;
  motivo: string;
  /** ms epoch */
  hasta: number;
}

// La última información gana: el reset que informa el proveedor reemplaza al anterior.
export const registrarBaja = (db: Database, baja: Baja) =>
  write(db, "registrar baja", () =>
    db
      .query(
        `INSERT INTO bajas (tipo, id, motivo, hasta) VALUES ($tipo, $id, $motivo, $hasta)
         ON CONFLICT (tipo, id) DO UPDATE SET motivo = excluded.motivo, hasta = excluded.hasta`,
      )
      .run({ ...baja }),
  );

export const bajasVigentes = (db: Database, ahora = Date.now()): Baja[] =>
  db.query("SELECT tipo, id, motivo, hasta FROM bajas WHERE hasta > $ahora ORDER BY hasta").all({ ahora }) as Baja[];

export const deBaja = (bajas: readonly Baja[]) => (actor: Actor) =>
  bajas.some((b) => (b.tipo === "proveedor" && b.id === actor.model.split("/")[0]) || (b.tipo === "actor" && b.id === etiqueta(actor)));

// ---------- Clasificador (S3) ----------

/** Cuerpo del último error de una request `primary`, con el actor que lo recibió. */
export interface ErrorCrudo {
  actor: string;
  cuerpo: string;
  headers: Record<string, string>;
}

export type Clase = { tipo: "cuota"; hasta?: number } | { tipo: "velocidad" } | { tipo: "interno" } | { tipo: "auth" } | { tipo: "otro" };

/**
 * Las requests de título, compactación y `generate` comparten `sessionID` (session.d.ts): solo se guarda el
 * error de las `primary`, y cada error nuevo reemplaza al anterior.
 */
export function guardarError(errores: Map<string, ErrorCrudo>, sessionID: string, kind: string, crudo: ErrorCrudo) {
  if (kind === "primary") errores.set(sessionID, crudo);
}

/** El `retry` consume el error guardado; un cuerpo de otro actor (anterior a un cambio) no cuenta. */
export function tomarError(errores: Map<string, ErrorCrudo>, sessionID: string, actor: string): ErrorCrudo | undefined {
  const crudo = errores.get(sessionID);
  errores.delete(sessionID);
  return crudo?.actor === actor ? crudo : undefined;
}

const json = (texto: string): Record<string, any> | undefined => {
  try {
    const x = JSON.parse(texto);
    return x && typeof x === "object" ? x : undefined;
  } catch {
    return undefined;
  }
};

const numero = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : undefined);

/** Segundos o ms epoch, o una fecha ISO. */
const instante = (x: unknown): number | undefined => {
  const n = numero(x);
  if (n !== undefined) return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined;
  const d = typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(d) ? d : undefined;
};

/** Reset informado por el proveedor: el cuerpo (`resets_at` en OpenAI y `claude-code`) y después los headers. */
export function reset(crudo: ErrorCrudo, ahora = Date.now()): number | undefined {
  const cuerpo = json(crudo.cuerpo);
  const error = cuerpo?.error ?? {};
  // el frame de error de OpenAI trae sus headers adentro (S3)
  const h = Object.fromEntries(Object.entries({ ...crudo.headers, ...(cuerpo?.headers ?? {}) }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const relativo = (x: unknown) => {
    const n = numero(x);
    return n !== undefined ? ahora + n * 1000 : undefined;
  };
  return (
    instante(error.resets_at) ??
    relativo(error.resets_in_seconds) ??
    instante(h["x-codex-primary-reset-at"]) ??
    instante(h["x-claude-rate-limit-reset"]) ??
    relativo(h["retry-after"])
  );
}

/** Parte del `error.type` que ya pone V2 y lo corrige con el cuerpo, si hay uno del mismo actor. */
export function clasificar(error: { type: string }, crudo: ErrorCrudo | undefined, ahora = Date.now()): Clase {
  const cuerpo = crudo && json(crudo.cuerpo);
  switch (error.type) {
    case "provider.quota":
      return { tipo: "cuota", hasta: crudo && reset(crudo, ahora) };
    case "provider.rate-limit":
      // el límite de suscripción de claude-code llega como velocidad y V2 lo reintentaría cada 15 min (S3)
      if (cuerpo?.error?.code === "claude_session_limit") return { tipo: "cuota", hasta: reset(crudo!, ahora) };
      return { tipo: "velocidad" };
    case "provider.internal":
      return { tipo: "interno" };
    case "provider.auth":
      return { tipo: "auth" };
    default:
      return { tipo: "otro" };
  }
}

// ---------- Suplencias: el cambio de actor dentro del hook `retry` (S8) ----------

/** `provider/model#variant` de un Model.Ref, con `default` cuando V2 no reporta variant. */
export const claveModelo = (m: { providerID: string; id: string; variant?: string }) => `${m.providerID}/${m.id}#${m.variant ?? "default"}`;

const PLAZO_BAJA = "5h";
const FALLOS_INTERNOS = 3;

export function suplencias(ctx: Plugin.Context, config: Config) {
  const errores = () => (proceso.errores ??= new Map());
  const fallos = () => (proceso.fallos ??= new Map());

  function guardar(sessionID: string, kind: string, model: { providerID: string; id: string; variant?: string }, cuerpo: string, headers: Record<string, string>) {
    guardarError(errores(), sessionID, kind, { actor: claveModelo(model), cuerpo, headers });
  }

  async function retry(r: SessionRetry) {
    const actual = { providerID: String(r.model.providerID), id: String(r.model.id), variant: r.model.variant && String(r.model.variant) };
    const clase = clasificar(r.error, tomarError(errores(), r.sessionID, claveModelo(actual)));
    log.info("retry", { sessionID: r.sessionID, agent: r.agent, actor: claveModelo(actual), attempt: r.attempt, error: r.error.type, clase, decisionV2: r.decision });
    if (clase.tipo === "velocidad" || clase.tipo === "otro") return; // el reintento nativo ya respeta retry-after

    if (clase.tipo === "interno") {
      // `attempt` es el número del próximo intento de la ejecución, no de fallos del actor (S3): se cuentan acá
      const previo = fallos().get(r.sessionID);
      const n = previo?.actor === claveModelo(actual) ? previo.n + 1 : 1;
      fallos().set(r.sessionID, { actor: claveModelo(actual), n });
      if (n < (config.fallosInternos ?? FALLOS_INTERNOS)) return;
    }

    if (clase.tipo === "cuota") {
      const proveedor = actual.providerID;
      const hasta = clase.hasta ?? Date.now() + plazoMs(config.proveedores?.[proveedor]?.plazoBaja ?? PLAZO_BAJA);
      registrarBaja(db(), { tipo: "proveedor", id: proveedor, motivo: `cuota: ${r.error.message}`, hasta });
      log.warn("baja", { proveedor, hasta: new Date(hasta).toISOString(), reset: clase.hasta !== undefined, sessionID: r.sessionID });
    }

    const validacion = proceso.validacion;
    const agente = String(r.agent);
    if (!validacion?.actores.has(agente)) return; // sesión sin reparto: queda la decisión de V2

    const suplente = siguiente(validacion, agente, actual, deBaja(bajasVigentes(db())));
    if (!suplente) {
      r.decision = { retry: false };
      log.warn("sin suplente", { sessionID: r.sessionID, agente, actor: claveModelo(actual), clase: clase.tipo });
      return;
    }
    await ctx.session.switchModel({ sessionID: r.sessionID, model: modelRef(suplente) });
    r.decision = { retry: true, delay: 0 };
    errores().delete(r.sessionID);
    fallos().delete(r.sessionID);
    const encargo = abiertos().get(r.sessionID);
    const proveedor = suplente.model.split("/")[0]!;
    if (encargo) moverCupo(encargo.id, proveedor, config.proveedores?.[proveedor]?.concurrencia ?? 3);
    const motivo = { cuota: "cuota agotada", interno: `${config.fallosInternos ?? FALLOS_INTERNOS} fallos seguidos del proveedor`, auth: "error de autenticación" }[clase.tipo];
    // La sesión ya muestra el cambio (marca model-switched de V2). No se le inyecta un mensaje: un `synthetic` que
    // llega después de la respuesta abre un paso más, y en un encargo esa respuesta pisaba el mensaje final.
    log.info("suplente", { sessionID: r.sessionID, agente, de: claveModelo(actual), a: etiqueta(suplente), motivo, encargo: encargo?.id });
  }

  return { guardar, retry };
}
