import { readFileSync } from "node:fs";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { etiqueta, modelRef, resolver } from "./actores.ts";
import { bajasVigentes, deBaja } from "./bajas.ts";
import { papeles } from "./agentes.ts";
import type { Actor, Config } from "./config.ts";
import { db, write } from "./db.ts";
import { planDeSesion } from "./estreno.ts";
import { log } from "./log.ts";
import { proceso } from "./process.ts";

export type Estado = "en_cola" | "corriendo" | "terminado" | "fallido" | "interrumpido" | "estancado";

export interface Encargo {
  id: number;
  hija: string;
  padre: string;
  a: string;
  actor: string;
  background: number;
  estado: Estado;
  desde: number | null;
  cerrado: number | null;
  mensaje_final: string | null;
  error: string | null;
  aviso_pendiente: number;
  boot_id: string;
  pid: number;
  starttime: string;
  creado: number;
}

const permitidas: Record<Estado, readonly Estado[]> = {
  en_cola: ["corriendo", "fallido"],
  corriendo: ["terminado", "fallido", "interrumpido", "estancado"],
  estancado: ["corriendo", "terminado", "fallido", "interrumpido"],
  terminado: [],
  fallido: [],
  interrumpido: [],
};

/** Agentes y papeles a los que se puede delegar en la fase 1. */
export const destinos = new Set<string>([...papeles, "utilero", "archivista", "oracle"]);
const investigacion = new Set(["utilero", "archivista", "oracle"]);
export const puedeDelegar = (agente: string | undefined, destino: string) => agente !== "dramaturgo" || investigacion.has(destino);

export const PLAZO_ESTANCADO = 30 * 60_000;
const TOPE_AVISO = 8_000;
const TOPE_AVISO_VISIBLE = 1_500;
const TOPE_RESULTADO = 4_000;
const CONCURRENCIA = 3;

const recortar = (texto: string, tope: number) => (texto.length > tope ? `${texto.slice(0, tope)}\n[… recortado, ${texto.length - tope} caracteres más]` : texto);

export function tituloEncargo(a: string, prompt: string): string {
  const resumen = (prompt.split("\n").find((linea) => linea.trim()) ?? "").trim().replace(/\s+/g, " ");
  return `${a} · ${resumen.length > 60 ? `${resumen.slice(0, 60)}…` : resumen}`;
}

// ---------- Proceso dueño de un encargo (ADR 0010): boot_id + pid + starttime, porque el pid solo se reusa ----------

const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

function starttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // campo 22 de /proc/<pid>/stat; el nombre del proceso (campo 2) puede tener espacios, así que se cuenta desde el ")"
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

export const yo = { boot_id: bootId, pid: process.pid, starttime: starttime(process.pid) ?? "" };
export const vivo = (e: Pick<Encargo, "boot_id" | "pid" | "starttime">) => e.boot_id === bootId && starttime(e.pid) === e.starttime;

// ---------- Filas ----------

export const leer = (id: number) => db().query("SELECT * FROM encargos WHERE id = $id").get({ id }) as Encargo | null;

type Cambios = Partial<Pick<Encargo, "desde" | "cerrado" | "mensaje_final" | "error" | "aviso_pendiente">>;

/** Transición atómica: solo la instancia que obtiene `changes = 1` sigue (y avisa). */
export function transicion(e: Encargo, a: Estado, cambios: Cambios = {}): boolean {
  if (!permitidas[e.estado].includes(a)) {
    log.error("transición no permitida", { id: e.id, de: e.estado, a });
    return false;
  }
  const sets = Object.keys(cambios).map((k) => `, ${k} = $${k}`).join("");
  const r = write(db(), `encargo ${e.id}: ${e.estado} → ${a}`, () =>
    db().query(`UPDATE encargos SET estado = $a${sets} WHERE id = $id AND estado = $de`).run({ a, id: e.id, de: e.estado, ...cambios }),
  );
  return r?.changes === 1;
}

/** Un evento o un outcome cuenta para la fila solo si es posterior a `desde`: el `outcome` es el de la última ejecución de la sesión. */
export const posterior = (instante: number | undefined, desde: number | null) => instante !== undefined && desde !== null && instante > desde;

// ---------- Cola por proveedor, en el proceso (S15 contradicha: vive en globalThis) ----------

function cola(proveedor: string) {
  proceso.colas ??= new Map();
  let c = proceso.colas.get(proveedor);
  if (!c) proceso.colas.set(proveedor, (c = { corriendo: 0, espera: [] }));
  return c;
}

async function tomarCupo(proveedor: string, limite: number, id: number) {
  const c = cola(proveedor);
  if (c.corriendo >= limite) {
    log.info("cola: en espera", { proveedor, id, corriendo: c.corriendo, limite, enEspera: c.espera.length + 1 });
    await new Promise<void>((resolve) => c.espera.push(resolve));
  } else c.corriendo++;
  (proceso.cupos ??= new Map()).set(id, proveedor);
  log.info("cola: corre", { proveedor, id, corriendo: c.corriendo, limite, enEspera: c.espera.length });
}

function soltarCupo(id: number) {
  const proveedor = proceso.cupos?.get(id);
  if (!proveedor) return;
  proceso.cupos!.delete(id);
  const c = cola(proveedor);
  const siguiente = c.espera.shift();
  if (siguiente) siguiente();
  else c.corriendo--;
  log.info("cola: libera", { proveedor, id, corriendo: c.corriendo, enEspera: c.espera.length });
}

/**
 * Un encargo que cambia de actor a otro proveedor (1.8) pasa su cupo a la cola nueva. Si está llena la excede:
 * esperar un cupo dentro de `retry` podría trabarse con cambios cruzados.
 */
// ponytail: exceso por suplencia; cola estricta si provoca 429 propios
export function moverCupo(id: number, proveedor: string, limite: number) {
  const anterior = proceso.cupos?.get(id);
  if (!anterior || anterior === proveedor) return;
  soltarCupo(id);
  const c = cola(proveedor);
  c.corriendo++;
  proceso.cupos!.set(id, proveedor);
  if (c.corriendo > limite) log.warn("cola: exceso por suplencia", { id, de: anterior, a: proveedor, corriendo: c.corriendo, limite });
  else log.info("cola: cupo movido", { id, de: anterior, a: proveedor, corriendo: c.corriendo, limite });
}

export const abiertos = () => (proceso.abiertos ??= new Map());
export const hijosNativos = () => (proceso.hijosNativos ??= new Map());

// ---------- Encargos ----------

type Ctx = Plugin.Context;

interface Entrada {
  a?: string;
  prompt: string;
  background?: boolean;
  sesion?: string;
  skills?: string[];
}

function parsear(input: unknown): Entrada {
  const x = (input ?? {}) as Record<string, unknown>;
  if (typeof x.prompt !== "string" || !x.prompt.trim()) throw new Error("delegar: falta `prompt`");
  if (x.sesion === undefined && typeof x.a !== "string") throw new Error("delegar: falta `a` (o `sesion` para retomar)");
  return {
    a: typeof x.a === "string" ? x.a : undefined,
    prompt: x.prompt,
    background: x.background === true,
    sesion: typeof x.sesion === "string" ? x.sesion : undefined,
    skills: Array.isArray(x.skills) ? x.skills.filter((s): s is string => typeof s === "string") : undefined,
  };
}

const etiquetaRef = (m: { providerID: string; id: string; variant?: string } | undefined) =>
  m ? etiqueta({ model: `${m.providerID}/${m.id}`, variant: m.variant }) : "desconocido";

export function textoAviso(e: Encargo, ultimoActor: string, titulo: string): string {
  const cabeza = `[reparto] ${titulo} — ${e.estado} (${e.hija})`;
  const suplente = ultimoActor.replace(/#default$/, "") !== e.actor.replace(/#default$/, "") ? `\nentró como suplente en lugar de ${e.actor}.` : "";
  const pista = `(bitacora({ id: "${e.hija}" }) para el resto)`;
  switch (e.estado) {
    case "terminado":
      return `${cabeza}\n\n${recortar(e.mensaje_final ?? "", TOPE_AVISO_VISIBLE)}${suplente}\n${pista}`;
    case "fallido":
      return `${cabeza}\n\nError: ${recortar(e.error ?? "la ejecución falló", 120)}. Último actor: ${ultimoActor}.${suplente}${e.mensaje_final ? `\nÚltimo mensaje: ${recortar(e.mensaje_final, TOPE_AVISO_VISIBLE)}` : ""}\n${pista}`;
    case "interrumpido":
      return `${cabeza}\n\nInterrumpido antes de completar el encargo.${suplente}\n${pista}`;
    case "estancado":
      return `${cabeza}\n\nSin actividad desde hace ${PLAZO_ESTANCADO / 60_000} min. Sigue abierto; decide si lo interrumpes.${suplente}\n${pista}`;
    case "en_cola":
    case "corriendo":
      throw new Error(`aviso para encargo abierto: ${e.estado}`);
  }
}

export function textoPermiso(titulo: string, action: string, resources: readonly string[], requestID: string): string {
  return `[reparto] ${titulo} — espera permiso: ${action} ${resources.join(", ")} (${requestID})\nÁbrela en chats por su título y aprueba o rechaza ahí.`;
}

export function permisoPendiente(hija: string): boolean {
  return !!db().query("SELECT 1 FROM permisos WHERE hija = $hija AND estado = 'pendiente' LIMIT 1").get({ hija });
}

export function registrarPermiso(request: { id: string; sessionID: string; action: string; resources: readonly string[] }): boolean {
  return write(db(), "permiso pedido", () =>
    db().query("INSERT OR IGNORE INTO permisos (request_id, hija, action, resources, estado) VALUES ($id, $hija, $action, $resources, 'pendiente')")
      .run({ id: request.id, hija: request.sessionID, action: request.action, resources: JSON.stringify(request.resources) }).changes,
  ) === 1;
}

export function encargos(ctx: Ctx, config: Config) {
  const limite = (proveedor: string) => config.proveedores?.[proveedor]?.concurrencia ?? CONCURRENCIA;

  async function mensajeFinal(hija: string): Promise<string | undefined> {
    const mensajes = await ctx.session.context({ sessionID: hija });
    for (const m of [...mensajes].reverse()) {
      if (m.type !== "assistant") continue;
      const texto = m.content
        .flatMap((parte) => (parte.type === "text" ? [parte.text] : []))
        .join("\n")
        .trim();
      if (texto) return texto;
    }
  }

  async function avisar(e: Encargo, ultimoActor: string) {
    try {
      const hija = await ctx.session.get({ sessionID: e.hija });
      await ctx.session.prompt({ sessionID: e.padre, text: textoAviso(e, ultimoActor, hija.title ?? e.hija), delivery: "queue", metadata: { repartoAviso: true } });
      write(db(), "aviso enviado", () => db().query("UPDATE encargos SET aviso_pendiente = 0 WHERE id = $id").run({ id: e.id }));
      log.info("aviso", { id: e.id, hija: e.hija, padre: e.padre, estado: e.estado });
    } catch (error) {
      log.error("aviso falló", { id: e.id, padre: e.padre, error: String(error) });
    }
  }

  /** Cómo cerró la última ejecución, si es posterior a `desde`; undefined si todavía corre. */
  async function cierre(e: Encargo, errorEvento?: string) {
    const s = await ctx.session.get({ sessionID: e.hija });
    if (!s.outcome || !posterior(s.time.idle, e.desde)) return;
    const ultimoActor = etiquetaRef(s.model);
    if (s.outcome === "interrupted") return { estado: "interrumpido" as const, ultimoActor };
    const mensaje = await mensajeFinal(e.hija);
    if (s.outcome === "succeeded")
      return mensaje
        ? { estado: "terminado" as const, mensaje, ultimoActor }
        : { estado: "fallido" as const, error: "terminó sin salida", ultimoActor };
    return { estado: "fallido" as const, mensaje, error: errorEvento ?? "la ejecución falló", ultimoActor };
  }

  /** Cierra un encargo abierto de este proceso. Solo avisa quien gana la transición. */
  async function cerrar(id: number, evento?: { created: number; error?: string }) {
    proceso.cerrando ??= new Set();
    if (proceso.cerrando.has(id)) return;
    proceso.cerrando.add(id);
    try {
      const e = leer(id);
      if (!e || (e.estado !== "corriendo" && e.estado !== "estancado")) return;
      // el cierre de una ejecución anterior de la misma hija, procesado tarde, no toca la fila retomada
      if (evento && !posterior(evento.created, e.desde)) return;
      const c = await cierre(e, evento?.error);
      if (!c) return;
      const cambios = { cerrado: Date.now(), mensaje_final: c.mensaje ?? null, error: c.error ?? null, aviso_pendiente: e.background };
      if (!transicion(e, c.estado, cambios)) return;
      soltarCupo(e.id);
      abiertos().delete(e.hija);
      const cerrado = { ...e, ...cambios, estado: c.estado };
      log.info("encargo cerrado", { id, hija: e.hija, a: e.a, estado: c.estado, error: c.error, actor: c.ultimoActor });
      if (e.background) await avisar(cerrado, c.ultimoActor);
    } catch (error) {
      log.error("cierre falló", { id, error: String(error) });
    } finally {
      proceso.cerrando.delete(id);
    }
  }

  /** Espera el cupo, pasa a corriendo y manda el prompt. false si el encargo no llegó a correr. */
  async function correr(id: number, prompt: string, skills: string[] | undefined): Promise<boolean> {
    const inicial = leer(id)!;
    await tomarCupo(inicial.actor.split("/")[0]!, limite(inicial.actor.split("/")[0]!), id);
    const e = leer(id)!;
    const desde = Date.now();
    if (e.estado !== "en_cola" || !transicion(e, "corriendo", { desde })) {
      soltarCupo(id);
      return false;
    }
    abiertos().set(e.hija, { id, actividad: desde });
    try {
      await ctx.session.prompt({ sessionID: e.hija, text: prompt, ...(skills?.length ? { skills: skills.map((s) => ({ id: s })) } : {}) });
      return true;
    } catch (error) {
      const actual = leer(id)!;
      if (transicion(actual, "fallido", { cerrado: Date.now(), error: `el prompt falló: ${String(error)}`, aviso_pendiente: e.background })) {
        soltarCupo(id);
        abiertos().delete(e.hija);
        if (e.background) await avisar({ ...actual, estado: "fallido", error: `el prompt falló: ${String(error)}` }, e.actor);
      }
      return false;
    }
  }

  async function delegar(input: unknown, tool: ToolContext, actorElegido?: Actor) {
    const args = parsear(input);
    const validacion = proceso.validacion;
    if (!validacion) throw new Error("reparto todavía no validó los actores contra el catálogo; reintenta en unos segundos");
    const padre = await ctx.session.get({ sessionID: tool.sessionID });
    if (padre.agent === "regidor" && !planDeSesion(db(), tool.sessionID)) throw new Error("regidor sin plan estrenado: usa /estreno <plan>");

    let hija: string;
    let a: string;
    let actor: string;
    let suplencia: string | undefined;
    if (args.sesion) {
      const previo = db().query("SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1").get({ hija: args.sesion }) as Encargo | null;
      if (!previo) throw new Error(`${args.sesion} no es un encargo de reparto`);
      if (!puedeDelegar(padre.agent, previo.a))
        throw new Error("dramaturgo solo delega investigación de lectura a utilero, archivista u oracle");
      const s = await ctx.session.get({ sessionID: args.sesion });
      hija = s.id;
      a = previo.a;
      actor = etiquetaRef(s.model);
    } else {
      if (!destinos.has(args.a!) && !(actorElegido && args.a === "critico")) throw new Error(`"${args.a}" no es un agente ni un papel al que se pueda delegar (${[...destinos].join(", ")})`);
      if (!actorElegido && !puedeDelegar(padre.agent, args.a!))
        throw new Error("dramaturgo solo delega investigación de lectura a utilero, archivista u oracle");
      if (!validacion.actores.has(args.a!)) throw new Error(`"${args.a}" está desactivado: no tiene actores válidos`);
      const bajas = bajasVigentes(db());
      const elegido = actorElegido ?? resolver(validacion, args.a!, deBaja(bajas));
      if (!elegido)
        throw new Error(`todos los actores de "${args.a}" están de baja: ${bajas.map((b) => `${b.id} hasta ${new Date(b.hasta).toISOString()}`).join(", ")}`);
      if (elegido !== validacion.actores.get(args.a!)![0]) suplencia = `el titular está de baja; entra ${etiqueta(elegido)}`;
      const s = await ctx.session.create({
        title: tituloEncargo(args.a!, args.prompt),
        agent: args.a,
        model: modelRef(elegido),
        location: { directory: padre.location.directory },
        metadata: { padre: tool.sessionID },
      });
      hija = s.id;
      a = args.a!;
      actor = etiqueta(elegido);
    }

    const fila = { hija, padre: tool.sessionID, a, actor, background: args.background ? 1 : 0, creado: Date.now(), ...yo };
    // Chequeo e INSERT en la misma transacción IMMEDIATE: dos retomas simultáneas, aun desde procesos distintos, no pasan las dos.
    const id = write(db(), "crear encargo", () => {
      if (db().query("SELECT 1 FROM encargos WHERE hija = $hija AND estado IN ('en_cola', 'corriendo', 'estancado')").get({ hija })) return 0;
      db().query("UPDATE permisos SET estado = 'respondido' WHERE hija = $hija AND estado = 'pendiente'").run({ hija });
      return Number(
        db()
          .query(
            `INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
             VALUES ($hija, $padre, $a, $actor, $background, 'en_cola', $boot_id, $pid, $starttime, $creado)`,
          )
          .run(fila).lastInsertRowid,
      );
    });
    if (id === 0) throw new Error(`encargo ya corriendo: ${hija}`);
    if (id === undefined) throw new Error("no se pudo registrar el encargo (SQLite); ver el log de reparto");
    log.info("encargo creado", { id, hija, padre: tool.sessionID, a, actor, background: !!args.background, retoma: !!args.sesion, suplencia });
    const nota = suplencia ? ` (${suplencia})` : "";

    if (args.background) {
      void correr(id, args.prompt, args.skills);
      return {
        content: `Encargo ${hija} lanzado en background a ${a} (${actor})${nota}. Te llega un aviso cuando termine, falle, lo interrumpan o quede estancado; no hace falta consultarlo.`,
        metadata: { encargo: id, hija },
      };
    }

    const interrumpir = () => {
      const e = leer(id);
      if (e?.estado === "en_cola") transicion(e, "fallido", { cerrado: Date.now(), error: "cancelado antes de correr" });
      else void ctx.session.interrupt({ sessionID: hija }).catch((error) => log.error("interrupt falló", { hija, error: String(error) }));
    };
    tool.signal.addEventListener("abort", interrumpir, { once: true });
    try {
      if (await correr(id, args.prompt, args.skills)) {
        await ctx.session.wait({ sessionID: hija });
        await cerrar(id);
      }
      // otra instancia puede estar cerrando la misma fila a partir del evento: se espera su transición
      for (let i = 0; i < 40 && isOpen(leer(id)); i++) await Bun.sleep(250);
    } finally {
      tool.signal.removeEventListener("abort", interrumpir);
    }
    const e = leer(id)!;
    if (isOpen(e)) return { content: `Encargo ${hija} (${a}) sigue ${e.estado}; te llega un aviso cuando cierre.`, metadata: { encargo: id, hija } };
    write(db(), "encargo sincrónico entregado", () => db().query("UPDATE encargos SET aviso_pendiente = 0 WHERE id = $id").run({ id }));
    const cuerpo = e.estado === "terminado" ? recortar(e.mensaje_final ?? "", TOPE_AVISO) : e.error ?? e.estado;
    return { content: `Encargo ${hija} (${a}, ${actor})${nota} ${e.estado}.\n\n${cuerpo}`, metadata: { encargo: id, hija, estado: e.estado } };
  }

  /** Interrumpe un encargo abierto cuya hija tenga `metadata.padre` = la sesión que llama. */
  async function interrumpir(input: unknown, tool: ToolContext) {
    const x = (input ?? {}) as { id?: unknown };
    if (typeof x.id !== "string") throw new Error("interrumpir: falta `id` (el id de la sesión hija)");
    const hija = x.id;
    const s = await ctx.session.get({ sessionID: hija }).catch(() => undefined);
    if (!s || (s.parentID ?? s.metadata?.padre) !== tool.sessionID)
      throw new Error(`interrumpir: ${hija} no es un encargo de esta sesión; solo se pueden interrumpir los encargos propios`);
    if (s.parentID) {
      await ctx.session.interrupt({ sessionID: hija });
      hijosNativos().delete(hija);
      return { content: `Encargo ${hija} interrumpido.`, metadata: { hija, estado: "interrumpido" } };
    }
    const e = db().query("SELECT * FROM encargos WHERE hija = $hija AND estado IN ('en_cola', 'corriendo', 'estancado')").get({ hija }) as Encargo | null;
    if (!e) throw new Error(`interrumpir: ${hija} no tiene un encargo abierto`);
    if (e.estado === "en_cola") {
      // no llegó a correr: no hay ejecución que interrumpir, y en_cola solo puede pasar a corriendo o fallido
      const cambios = { cerrado: Date.now(), error: "interrumpido antes de correr", aviso_pendiente: e.background };
      if (transicion(e, "fallido", cambios)) {
        abiertos().delete(hija);
        if (e.background) await avisar({ ...e, ...cambios, estado: "fallido" }, e.actor);
      }
    } else {
      await ctx.session.interrupt({ sessionID: hija });
      // la transición a interrumpido y el aviso los hace cerrar(), a partir de session.execution.interrupted
      for (let i = 0; i < 40 && isOpen(leer(e.id)); i++) await Bun.sleep(250);
      if (isOpen(leer(e.id))) await cerrar(e.id);
    }
    const final = leer(e.id)!;
    log.info("interrupción pedida", { id: e.id, hija, por: tool.sessionID, estado: final.estado });
    return { content: `Encargo ${hija} (${e.a}): ${final.estado}${final.error ? ` (${final.error})` : ""}.`, metadata: { encargo: e.id, hija, estado: final.estado } };
  }

  async function bitacora(input: unknown) {
    const x = (input ?? {}) as { id?: unknown; detalle?: unknown };
    if (typeof x.id !== "string") throw new Error("bitacora: falta `id` (el id de la sesión hija)");
    const e = db().query("SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1").get({ hija: x.id }) as Encargo | null;
    const s = e ? undefined : await ctx.session.get({ sessionID: x.id }).catch(() => undefined);
    if (!e && !s?.parentID)
      throw new Error(`${x.id} no es un encargo de reparto`);
    const completo = x.detalle === "completo";
    const llamadas = db().query("SELECT tool, argumentos, resultado, estado FROM bitacora WHERE hija = $hija ORDER BY hora").all({ hija: x.id }) as {
      tool: string;
      argumentos: string;
      resultado: string | null;
      estado: string;
    }[];
    const lineas = llamadas.map((l) => {
      const base = `- ${l.tool} ${argumentoClave(l.argumentos)}${l.estado === "error" ? " [error]" : ""}`;
      return completo && l.resultado ? `${base}\n  → ${l.resultado.replaceAll("\n", "\n    ")}` : base;
    });
    return {
      content: [
        e ? `Encargo ${e.hija} (${e.a}, ${e.actor}): ${e.estado}${e.error ? ` (${e.error})` : ""}.` : `Encargo ${x.id} (${s?.agent}): ${s?.outcome ?? "abierto"}.`,
        `Tool calls (${llamadas.length}):`,
        lineas.join("\n") || "(ninguna)",
        `Mensaje final:`,
        e?.mensaje_final ?? (s ? await mensajeFinal(x.id) : undefined) ?? "(todavía no hay)",
      ].join("\n\n"),
    };
  }

  async function registrarLlamada(x: { tool: string; sessionID: string; messageID: string; id: string; input: unknown; status: "completed" | "error"; result?: { content?: unknown }; error?: { message: string } }) {
    if (!abiertos().has(x.sessionID)) {
      const s = await ctx.session.get({ sessionID: x.sessionID }).catch(() => undefined);
      if (!s?.parentID) return;
    }
    const resultado = x.status === "error" ? x.error?.message ?? "" : typeof x.result?.content === "string" ? x.result.content : JSON.stringify(x.result?.content ?? "");
    write(db(), "bitácora", () =>
      db()
        .query(
          `INSERT OR IGNORE INTO bitacora (hija, mensaje, llamada, tool, argumentos, resultado, estado, hora)
           VALUES ($hija, $mensaje, $llamada, $tool, $argumentos, $resultado, $estado, $hora)`,
        )
        .run({
          hija: x.sessionID,
          mensaje: x.messageID,
          llamada: x.id,
          tool: x.tool,
          argumentos: JSON.stringify(x.input ?? {}),
          resultado: recortar(resultado, TOPE_RESULTADO),
          estado: x.status,
          hora: Date.now(),
        }),
    );
  }

  /** Eventos de todas las locations del proceso (S15); los session.execution.* no traen location (S13). */
  function evento(ev: { type: string; created?: number; data?: unknown }) {
    const data = ev.data as { sessionID?: string; id?: string; requestID?: string; action?: string; resources?: string[]; error?: { message?: string } } | undefined;
    const abierto = data?.sessionID ? abiertos().get(data.sessionID) : undefined;
    const nativo = data?.sessionID ? hijosNativos().get(data.sessionID) : undefined;
    if (nativo) {
      if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed" || ev.type === "session.execution.interrupted") hijosNativos().delete(data!.sessionID!);
      else if (ev.type === "permission.asked") nativo.permiso = true;
      else if (ev.type === "permission.replied") { nativo.permiso = false; nativo.actividad = Date.now(); }
      else if (/^session\.(step|tool|text|reasoning)\./.test(ev.type)) { nativo.actividad = Date.now(); nativo.avisado = false; }
    }
    if (!abierto) return;
    if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed" || ev.type === "session.execution.interrupted") {
      void cerrar(abierto.id, { created: ev.created ?? Date.now(), error: data?.error?.message });
      return;
    }
    if (ev.type === "permission.asked" && data?.id && data.action && data.resources && data.sessionID) {
      const e = leer(abierto.id);
      if (!e || !isOpen(e)) return;
      const { id, action, resources, sessionID } = data;
      actividad();
      if (registrarPermiso({ id, action, resources, sessionID })) void (async () => {
        try {
          const hija = await ctx.session.get({ sessionID: e.hija });
          await ctx.session.prompt({ sessionID: e.padre, text: textoPermiso(hija.title ?? e.hija, action, resources, id), delivery: "queue", metadata: { repartoAviso: true } });
          log.info("permiso avisado", { id: e.id, hija: e.hija, padre: e.padre, requestID: id });
        } catch (error) {
          log.error("aviso de permiso falló", { id: e.id, hija: e.hija, padre: e.padre, requestID: id, error: String(error) });
        }
      })();
      return;
    }
    if (ev.type === "permission.replied" && data?.requestID && data.sessionID) {
      const { requestID, sessionID } = data;
      actividad();
      write(db(), "permiso respondido", () => db().query("UPDATE permisos SET estado = 'respondido' WHERE request_id = $id AND hija = $hija")
        .run({ id: requestID, hija: sessionID }));
      return;
    }
    if (/^session\.(step|tool|text|reasoning)\./.test(ev.type)) actividad();

    function actividad() {
      abierto.actividad = Date.now();
      if (abierto.estancado) {
        const e = leer(abierto.id);
        if (e?.estado === "estancado" && transicion(e, "corriendo")) {
          abierto.estancado = false;
          log.info("encargo reanudado", { id: e.id, hija: e.hija });
        }
      }
    }
  }

  async function vigilar() {
    const ahora = Date.now();
    for (const [hija, nativo] of hijosNativos()) {
      if (nativo.avisado || nativo.permiso || ahora - nativo.actividad < PLAZO_ESTANCADO) continue;
      nativo.avisado = true;
      try {
        await ctx.session.prompt({ sessionID: nativo.padre, text: `[reparto] ${hija} — estancado\n\nSin actividad desde hace 30 min. Sigue abierto; decide si lo interrumpes.\n(bitacora({ id: "${hija}" }) para el resto)`, delivery: "queue", metadata: { repartoAviso: true } });
      } catch (error) {
        log.error("aviso de estancado falló", { hija, error: String(error) });
      }
    }
    for (const [hija, abierto] of abiertos()) {
      if (abierto.estancado || ahora - abierto.actividad < PLAZO_ESTANCADO || permisoPendiente(hija)) continue;
      const e = leer(abierto.id);
      if (e?.estado !== "corriendo" || !transicion(e, "estancado")) continue;
      abierto.estancado = true;
      log.warn("encargo estancado", { id: e.id, hija });
      await avisar({ ...e, estado: "estancado" }, e.actor);
    }
  }

  /** Al arrancar: cierra los encargos de procesos muertos y reenvía los avisos pendientes (al menos una vez). */
  async function reconciliar() {
    const filas = db()
      .query("SELECT * FROM encargos WHERE estado IN ('en_cola', 'corriendo', 'estancado') OR aviso_pendiente = 1 ORDER BY id")
      .all() as Encargo[];
    for (const e of filas) {
      if (vivo(e)) continue; // es de un proceso vivo, con su cola intacta (S15)
      try {
        if (isOpen(e)) {
          // desde otro proceso `wait` vuelve en el acto (S13): se mira el outcome, y solo si es posterior a `desde`
          const c = e.estado === "en_cola" ? undefined : await cierre(e).catch(() => undefined);
          const estado = c?.estado ?? "fallido";
          const cambios = { cerrado: Date.now(), mensaje_final: c?.mensaje ?? null, error: c ? c.error ?? null : "perdido en reinicio", aviso_pendiente: 1 };
          if (!transicion(e, estado, cambios)) continue;
          const cerrado = { ...e, ...cambios, estado };
          log.info("encargo reconciliado", { id: e.id, hija: e.hija, estado, error: cambios.error });
          await avisar(cerrado, c?.ultimoActor ?? e.actor);
        } else {
          log.info("aviso pendiente reenviado", { id: e.id, hija: e.hija, estado: e.estado });
          await avisar(e, e.actor);
        }
      } catch (error) {
        log.error("reconciliación falló", { id: e.id, error: String(error) });
      }
    }
  }

  return { delegar, interrumpir, bitacora, registrarLlamada, evento, vigilar, reconciliar };
}

const isOpen = (e: Encargo | null) => !!e && (e.estado === "en_cola" || e.estado === "corriendo" || e.estado === "estancado");

const clavesArgumento = ["command", "pattern", "filePath", "path", "query", "url", "a"];

export function argumentoClave(argumentos: string): string {
  let x: unknown;
  try {
    x = JSON.parse(argumentos);
  } catch {
    return recortar(argumentos, 160);
  }
  if (!x || typeof x !== "object") return "";
  const r = x as Record<string, unknown>;
  const clave = clavesArgumento.find((k) => typeof r[k] === "string") ?? Object.keys(r).find((k) => typeof r[k] === "string");
  return clave ? `${clave}=${recortar(String(r[clave]), 160).replaceAll("\n", " ")}` : "";
}
