import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { etiqueta } from "./actores.ts";
import type { Validacion } from "./actores.ts";
import { bajasVigentes, deBaja } from "./bajas.ts";
import type { Actor } from "./config.ts";
import { db, write } from "./db.ts";
import type { Encargo } from "./encargos.ts";
import { proceso } from "./process.ts";

export type Objecion = { readonly seccion: string; readonly defecto: string; readonly causa: string; readonly cierre: string; readonly justificacion?: string };
export type Veredicto = { readonly veredicto: "APROBADO" | "OBJECIONES"; readonly objeciones: readonly Objecion[]; readonly notas: readonly string[]; readonly cierres: Readonly<Record<number, "cerrado" | "abierto">> };
export type EntradaActa = { readonly plan: string; readonly id: number; readonly objecion: string; readonly causa: string; readonly condicion_cierre: string; readonly ronda_entrada: number; readonly estado: "abierto" | "cerrado" };
type Ensayo = { readonly plan: string; readonly ronda: number; readonly hash: string; readonly revisor: string; readonly actor: string; readonly veredicto: string };

export function parsearVeredicto(texto: string): Veredicto {
  const lineas = texto.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cabecera = lineas.find((l) => /^VEREDICTO:/.test(l));
  if (cabecera !== "VEREDICTO: APROBADO" && cabecera !== "VEREDICTO: OBJECIONES") throw new Error("veredicto inválido: falta VEREDICTO: APROBADO | OBJECIONES");
  const objeciones: Objecion[] = [];
  const notas: string[] = [];
  const cierres: Record<number, "cerrado" | "abierto"> = {};
  for (const linea of lineas) {
    if (linea.startsWith("OBJECION:")) {
      const campos = linea.slice(9).split("|").map((s) => s.trim());
      if (campos.length < 4 || campos.length > 5 || campos.slice(0, 4).some((s) => !s)) {
        notas.push(linea);
        continue;
      }
      const [seccion, defecto, causa, cierre, justificacion] = campos;
      if (seccion && defecto && causa && cierre) objeciones.push({ seccion, defecto, causa, cierre, ...(justificacion ? { justificacion } : {}) });
    } else if (linea.startsWith("NOTA:")) notas.push(linea.slice(5).trim());
    else if (linea.startsWith("ACTA:")) {
      const match = /^ACTA:\s*(\d+)\s*\|\s*(cerrado|abierto)$/.exec(linea);
      if (match) cierres[Number(match[1])] = match[2] === "cerrado" ? "cerrado" : "abierto";
      else notas.push(linea);
    }
  }
  return { veredicto: cabecera === "VEREDICTO: APROBADO" ? "APROBADO" : "OBJECIONES", objeciones, notas, cierres };
}

const proveedor = (actor: Actor) => actor.model.split("/")[0];

export function elegirRevisores(validacion: Validacion, dramaturgo: string | undefined, fuera: (actor: Actor) => boolean): { critico: Actor; oracle: Actor; repetidos: boolean } | undefined {
  const criticos = (validacion.actores.get("critico") ?? []).filter((a) => !fuera(a));
  const oracles = (validacion.actores.get("oracle") ?? []).filter((a) => !fuera(a));
  const pares = criticos.flatMap((critico) => oracles.map((oracle) => ({ critico, oracle })));
  const distinto = pares.find(({ critico, oracle }) => proveedor(critico) !== dramaturgo && proveedor(oracle) !== dramaturgo && proveedor(critico) !== proveedor(oracle));
  const elegido = distinto ?? pares.find(({ critico, oracle }) => proveedor(critico) !== proveedor(oracle)) ?? pares[0];
  return elegido && { ...elegido, repetidos: !distinto };
}

export function actualizarActa(database: Database, plan: string, ronda: number, revisiones: readonly Veredicto[]): EntradaActa[] {
  const previo = database.query("SELECT * FROM acta WHERE plan = $plan ORDER BY id").all({ plan }) as EntradaActa[];
  const alta = database.query(`INSERT INTO acta (plan, id, objecion, causa, condicion_cierre, ronda_entrada, estado)
    VALUES ($plan, $id, $objecion, $causa, $condicion_cierre, $ronda_entrada, 'abierto')`);
  let id = (previo.at(-1)?.id ?? 0) + 1;
  for (const v of revisiones) for (const o of v.objeciones) {
    if (ronda > 1 && !o.justificacion) continue;
    // ponytail: no automatic duplicate merging; the dramaturgo can reconcile duplicates after reviewing the acta.
    alta.run({ plan, id: id++, objecion: `${o.seccion}: ${o.defecto}`, causa: o.causa, condicion_cierre: o.cierre, ronda_entrada: ronda });
  }
  if (ronda > 1) for (const entrada of previo) {
    const estado = revisiones.every((v) => v.cierres[entrada.id] === "cerrado") ? "cerrado" : "abierto";
    database.query("UPDATE acta SET estado = $estado WHERE plan = $plan AND id = $id").run({ estado, plan, id: entrada.id });
  }
  return database.query("SELECT * FROM acta WHERE plan = $plan ORDER BY id").all({ plan }) as EntradaActa[];
}

export function cerrado(revisiones: readonly Veredicto[], acta: readonly EntradaActa[], hashes: readonly string[]): boolean {
  return revisiones.length === 2 && hashes.length === 2 && hashes[0] === hashes[1] && revisiones.every((v) => v.veredicto === "APROBADO" && v.objeciones.length === 0) && acta.every((a) => a.estado === "cerrado");
}

export function admitir(v: Veredicto, ronda: number, acta: readonly EntradaActa[]): Veredicto {
  const aceptadas = ronda === 1 ? v.objeciones : v.objeciones.filter((o) => !!o.justificacion);
  return {
    ...v,
    notas: [...v.notas, ...(ronda > 1 ? v.objeciones.filter((o) => !o.justificacion).map((o) => `${o.seccion}: ${o.defecto}`) : [])],
    objeciones: aceptadas,
    veredicto: aceptadas.length || (ronda > 1 && acta.some((a) => v.cierres[a.id] !== "cerrado")) ? "OBJECIONES" : "APROBADO",
  };
}

function diferencia(anterior: string, actual: string): string {
  const a = anterior.split("\n");
  const b = actual.split("\n");
  let inicio = 0;
  while (inicio < Math.min(a.length, b.length) && a[inicio] === b[inicio]) inicio++;
  let fin = 0;
  while (fin < Math.min(a.length - inicio, b.length - inicio) && a[a.length - 1 - fin] === b[b.length - 1 - fin]) fin++;
  return [...a.slice(inicio, a.length - fin).map((s) => `- ${s}`), ...b.slice(inicio, b.length - fin).map((s) => `+ ${s}`)].join("\n") || "(sin cambios)";
}

export function ensayo(ctx: { session: { get: (x: { sessionID: string }) => Promise<{ agent?: string; model?: { providerID: string }; location: { directory: string } }> } }, encargos: { delegar: (x: { a: string; prompt: string }, tool: ToolContext, actor: Actor) => Promise<{ metadata: { hija: string } }> }) {
  return async (input: { plan: string }, tool: ToolContext) => {
    const padre = await ctx.session.get({ sessionID: tool.sessionID });
    if (padre.agent !== "dramaturgo") throw new Error("ensayar: solo el dramaturgo puede ensayar");
    const raiz = resolve(padre.location.directory, ".reparto/planes");
    const ruta = resolve(padre.location.directory, input.plan);
    const relativa = relative(raiz, ruta);
    if (isAbsolute(input.plan) || relativa.startsWith("..") || isAbsolute(relativa) || !relativa || !ruta.endsWith(".md")) throw new Error("ensayar: el plan debe estar bajo .reparto/planes/ y ser .md");
    const real = await realpath(ruta);
    if (real !== ruta) throw new Error("ensayar: no se permiten symlinks");
    const contenido = await Bun.file(ruta).text();
    const hash = createHash("sha256").update(contenido).digest("hex");
    const plan = relative(padre.location.directory, ruta);
    const database = db();
    const anterior = database.query("SELECT * FROM ensayos WHERE plan = $plan ORDER BY ronda DESC LIMIT 1").get({ plan }) as Ensayo | null;
    if (anterior?.veredicto !== "pendiente") {
      if (anterior) {
        const filas = database.query("SELECT * FROM ensayos WHERE plan = $plan AND ronda = $ronda").all({ plan, ronda: anterior.ronda }) as Ensayo[];
        const acta = database.query("SELECT * FROM acta WHERE plan = $plan").all({ plan }) as EntradaActa[];
        if (filas.length === 2 && filas.every((r) => r.veredicto !== "pendiente") && cerrado(filas.map((r) => JSON.parse(r.veredicto) as Veredicto), acta, filas.map((r) => r.hash)) && anterior.hash === hash)
          return { content: JSON.stringify({ plan, ronda: anterior.ronda, cerrado: true, acta }) };
      }
      if (anterior && anterior.ronda >= 5) return { content: JSON.stringify({ plan, ronda: 5, cerrado: false, decision: "Bryan debe decidir: máximo 5 rondas" }) };
    }
    const ronda = anterior?.veredicto === "pendiente" ? anterior.ronda : (anterior?.ronda ?? 0) + 1;
    const version = anterior?.veredicto === "pendiente"
      ? database.query("SELECT contenido FROM versiones WHERE plan = $plan AND hash = $hash").get({ plan, hash: anterior.hash }) as { contenido: string } | null
      : { contenido };
    if (!version) throw new Error("ensayar: instantánea pendiente ausente");
    const hashRonda = anterior?.veredicto === "pendiente" ? anterior.hash : hash;
    const validacion = proceso.validacion;
    if (!validacion) throw new Error("ensayar: actores aún no validados");
    const actores = elegirRevisores(validacion, padre.model?.providerID, deBaja(bajasVigentes(database)));
    if (!actores) throw new Error("ensayar: crítico u oracle sin actores disponibles");
    const prevHash = database.query("SELECT hash FROM ensayos WHERE plan = $plan AND ronda = $ronda LIMIT 1").get({ plan, ronda: ronda - 1 }) as { hash: string } | null;
    const previo = prevHash && database.query("SELECT contenido FROM versiones WHERE plan = $plan AND hash = $hash").get({ plan, hash: prevHash.hash }) as { contenido: string } | null;
    const acta = database.query("SELECT * FROM acta WHERE plan = $plan ORDER BY id").all({ plan }) as EntradaActa[];
    if (!write(database, "iniciar ensayo", () => {
      database.query("INSERT OR IGNORE INTO versiones (plan, hash, contenido) VALUES ($plan, $hash, $contenido)").run({ plan, hash: hashRonda, contenido: version.contenido });
      for (const [revisor, actor] of [["critico", actores.critico], ["oracle", actores.oracle]] as const)
        database.query(`INSERT INTO ensayos (plan, ronda, hash, revisor, actor, veredicto) VALUES ($plan, $ronda, $hash, $revisor, $actor, 'pendiente')
          ON CONFLICT (plan, ronda, revisor) DO UPDATE SET veredicto = 'pendiente', actor = excluded.actor`).run({ plan, ronda, hash: hashRonda, revisor, actor: etiqueta(actor) });
      return true;
    })) throw new Error("ensayar: no se pudo iniciar ronda");
    const contexto = ronda === 1 ? "Round 1: discovery." : `Closure round ${ronda}. Diff from previous snapshot:\n${diferencia(previo?.contenido ?? "", version.contenido)}\n\nActa:\n${JSON.stringify(acta)}`;
    const prompt = `${contexto}\n\nPlan snapshot (review this exact text):\n${version.contenido}\n\nReturn ONLY the strict English VEREDICTO format: first line VEREDICTO: APROBADO or VEREDICTO: OBJECIONES; each objection OBJECION: section | concrete defect | cause | closing condition. Explicit Verification is required per task; missing Verification is a blocking objection even if Acceptance is observable. For every acta entry return ACTA: numeric-id | cerrado/abierto. Do not append Difficulty or other formats. Do not use the filesystem version.`;
    const resultados = await Promise.allSettled((["critico", "oracle"] as const).map(async (revisor) => {
      const respuesta = await encargos.delegar({ a: revisor, prompt }, tool, actores[revisor]);
      const fila = database.query("SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1").get({ hija: respuesta.metadata.hija }) as Encargo | null;
      if (fila?.estado !== "terminado" || !fila.mensaje_final) throw new Error(`${revisor}: encargo no terminó (${fila?.estado})`);
      return { revisor, actor: fila.actor, veredicto: parsearVeredicto(fila.mensaje_final), hija: fila.hija };
    }));
    if (resultados.some((r) => r.status === "rejected")) throw new Error(`ensayar: ronda ${ronda} incompleta; reintenta con encargos nuevos: ${resultados.filter((r) => r.status === "rejected").map((r) => String(r.reason)).join("; ")}`);
    const revisiones = resultados.filter((r) => r.status === "fulfilled").map((r) => r.value);
    // An objection without round-1 justification is only a note and cannot block closure.
    const efectivos = revisiones.map((r) => ({ ...r, veredicto: admitir(r.veredicto, ronda, acta) }));
    const final = write(database, "cerrar ensayo", () => {
      const lista = actualizarActa(database, plan, ronda, efectivos.map((r) => r.veredicto));
      for (const r of efectivos) database.query("UPDATE ensayos SET veredicto = $veredicto, actor = $actor WHERE plan = $plan AND ronda = $ronda AND revisor = $revisor")
        .run({ plan, ronda, revisor: r.revisor, actor: r.actor, veredicto: JSON.stringify(r.veredicto) });
      return lista;
    });
    if (!final) throw new Error("ensayar: no se pudo guardar la ronda");
    const cierre = cerrado(efectivos.map((r) => r.veredicto), final, [hashRonda, hashRonda]);
    return { content: JSON.stringify({ plan, ronda, hash: hashRonda, revisores: efectivos, acta: final, cerrado: cierre, proveedores: actores.repetidos ? "proveedores repetidos" : "distintos", ...(ronda === 5 && !cierre ? { decision: "Bryan debe decidir" } : {}) }) };
  };
}
