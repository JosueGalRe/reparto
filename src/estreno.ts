import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { EntradaActa, Veredicto } from "./ensayo.ts";
import { cerrado } from "./ensayo.ts";
import { db, write } from "./db.ts";
import type { Item } from "./pendientes.ts";
import { formatear, leerPendientes } from "./pendientes.ts";

type Ensayo = { readonly ronda: number; readonly hash: string; readonly revisor: string; readonly veredicto: string };
export type Estreno = { readonly plan: string; readonly hash: string; readonly fecha: number; readonly tipo: "normal" | "con_objeciones"; readonly objeciones: string };
export type ReferenciaPlan = { readonly plan: string; readonly hash: string };

export const clavePlan = ({ plan, hash }: ReferenciaPlan) => `${plan}\u0000${hash}`;

export function planDeSesion(database: Database, sesion: string): ReferenciaPlan | undefined {
  return database.query("SELECT plan, hash FROM sesiones_regidor WHERE sesion = $sesion").get({ sesion }) as ReferenciaPlan | undefined;
}

export function ligarSesion(database: Database, sesion: string, ref: ReferenciaPlan) {
  const result = write(database, "ligar sesión al estreno", () => database.query("INSERT INTO sesiones_regidor (sesion, plan, hash) VALUES ($sesion, $plan, $hash)").run({ sesion, ...ref }));
  if (!result) throw new Error("estreno: no se pudo ligar la sesión al plan");
}

export function tareas(contenido: string): Item[] {
  const titulos = [...contenido.matchAll(/^### (T\d+):\s*(.+)$/gm)];
  if (!titulos.length || titulos.some((m, i) => m[1] !== `T${i + 1}`)) throw new Error("estreno: el plan necesita tareas T1…Tn en orden");
  return titulos.map((m) => ({ texto: `${m[1]}: ${m[2]}`, estado: "pendiente" }));
}

/** Check the current hash, both reviewers and the acta before any write. */
export function evaluarEstreno(database: Database, plan: string, hash: string, conObjeciones: boolean): { tipo: Estreno["tipo"]; abiertas: EntradaActa[] } {
  const estrenado = database.query("SELECT * FROM estrenos WHERE plan = $plan").get({ plan }) as Estreno | null;
  if (estrenado) {
    if (estrenado.hash !== hash) throw new Error("estreno: el archivo cambió después del estreno; el plan estrenado es inmutable");
    return { tipo: estrenado.tipo, abiertas: JSON.parse(estrenado.objeciones) as EntradaActa[] };
  }
  const ultima = database.query("SELECT max(ronda) AS ronda FROM ensayos WHERE plan = $plan").get({ plan }) as { ronda: number | null };
  if (ultima.ronda === null) throw new Error("estreno: el plan no tiene ensayo general");
  const filas = database.query("SELECT ronda, hash, revisor, veredicto FROM ensayos WHERE plan = $plan AND ronda = $ronda ORDER BY revisor").all({ plan, ronda: ultima.ronda }) as Ensayo[];
  if (filas.some((fila) => fila.hash !== hash)) throw new Error("estreno: el archivo cambió después de la versión ensayada; ensaya el hash actual");
  if (filas.length !== 2 || filas.some((fila) => fila.veredicto === "pendiente") || new Set(filas.map((fila) => fila.revisor)).size !== 2)
    throw new Error("estreno: ronda incompleta; faltan los dos revisores");
  const acta = database.query("SELECT * FROM acta WHERE plan = $plan ORDER BY id").all({ plan }) as EntradaActa[];
  const veredictos = filas.map((fila) => JSON.parse(fila.veredicto) as Veredicto);
  if (cerrado(veredictos, acta, filas.map((fila) => fila.hash))) return { tipo: "normal", abiertas: [] };
  if (conObjeciones && ultima.ronda === 5) return { tipo: "con_objeciones", abiertas: acta.filter((entrada) => entrada.estado === "abierto") };
  throw new Error(conObjeciones ? "estreno: con-objeciones requiere 5 rondas completas sin cierre" : "estreno: los dos revisores deben aprobar el mismo hash; quedan objeciones");
}

export function registrarEstreno(database: Database, referencia: ReferenciaPlan, contenido: string, conObjeciones: boolean): { estreno: Estreno; items: Item[] } {
  const { plan, hash } = referencia;
  const tasks = tareas(contenido);
  const aprobado = evaluarEstreno(database, plan, hash, conObjeciones);
  const resultado = write(database, "estrenar plan", () => {
    const fecha = Date.now();
    database.query("INSERT OR IGNORE INTO estrenos (plan, hash, fecha, tipo, objeciones) VALUES ($plan, $hash, $fecha, $tipo, $objeciones)")
      .run({ plan, hash, fecha, tipo: aprobado.tipo, objeciones: JSON.stringify(aprobado.abiertas) });
    const clave = clavePlan(referencia);
    database.query("INSERT OR IGNORE INTO pendientes (clave, items, actualizado) VALUES ($clave, $items, $actualizado)")
      .run({ clave, items: JSON.stringify(tasks), actualizado: fecha });
    return { estreno: database.query("SELECT * FROM estrenos WHERE plan = $plan").get({ plan }) as Estreno, items: leerPendientes(database, clave) };
  });
  if (!resultado) throw new Error("estreno: no se pudo guardar en SQLite");
  return resultado;
}

export function estreno(ctx: Plugin.Context) {
  return async (input: { sessionID: string; prompt: { text: string } }) => {
    const tokens = input.prompt.text.trim().replace(/^\/estreno\s+/, "").split(/\s+/);
    const [nombre, modificador, extra] = tokens;
    if (!nombre || extra || (modificador && modificador !== "con-objeciones")) throw new Error("uso: /estreno .reparto/planes/<plan>.md [con-objeciones]");
    const sesion = await ctx.session.get({ sessionID: input.sessionID });
    const raiz = resolve(sesion.location.directory, ".reparto/planes");
    const ruta = resolve(sesion.location.directory, nombre);
    const relativa = relative(raiz, ruta);
    if (isAbsolute(nombre) || !relativa || relativa.startsWith("..") || isAbsolute(relativa) || !ruta.endsWith(".md")) throw new Error("estreno: el plan debe estar bajo .reparto/planes/ y ser .md");
    if (await realpath(ruta) !== ruta) throw new Error("estreno: no se permiten symlinks");
    const contenido = await Bun.file(ruta).text();
    const ref = { plan: relative(sesion.location.directory, ruta), hash: createHash("sha256").update(contenido).digest("hex") };
    const { estreno, items } = registrarEstreno(db(), ref, contenido, modificador === "con-objeciones");
    const texto = `Plan estrenado: ${ref.plan}\nHash: ${ref.hash}\nTipo: ${estreno.tipo}${estreno.tipo === "con_objeciones" ? `\nObjeciones abiertas: ${estreno.objeciones}` : ""}\n\n${contenido}\n\nPendientes del plan:\n${formatear(items)}\n\nContinúa desde la primera tarea sin terminar. Delega cada cambio y verifica cada tarea.`;
    if ((await ctx.session.context({ sessionID: input.sessionID })).length === 0) {
      await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "regidor" });
      ligarSesion(db(), input.sessionID, ref);
      await ctx.session.prompt({ sessionID: input.sessionID, text: texto, delivery: "queue", metadata: { repartoInicio: true } });
      return;
    }
    const nueva = await ctx.session.create({ title: `regidor · ${nombre.split("/").at(-1)?.replace(/\.md$/, "")}`, agent: "regidor", location: { directory: sesion.location.directory } });
    ligarSesion(db(), nueva.id, ref);
    await ctx.session.prompt({ sessionID: nueva.id, text: texto, delivery: "queue", metadata: { repartoInicio: true } });
    await ctx.session.prompt({ sessionID: input.sessionID, text: `[reparto] estreno ${ref.plan} (${estreno.tipo}). Abre en chats «${nueva.title}» (${nueva.id}) para seguir con el regidor.`, delivery: "queue", metadata: { repartoAviso: true } });
  };
}
