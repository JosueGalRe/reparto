import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidirContinuacion, decisionGuardada } from "../src/continuacion.ts";
import { openDb } from "../src/db.ts";
import { clavePlan, evaluarEstreno, ligarSesion, planDeSesion, registrarEstreno, tareas } from "../src/estreno.ts";
import { leerPendientes, escribirPendientes } from "../src/pendientes.ts";

const dir = mkdtempSync(join(tmpdir(), "reparto-estreno-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const db = openDb(join(dir, "estreno.db"));
const plan = ".reparto/planes/demo.md";
const contenido = "## Tasks\n\n### T1: first\n- Do: a\n\n### T2: second\n- Do: b\n";
const verdict = JSON.stringify({ veredicto: "APROBADO", objeciones: [], notas: [], cierres: {} });

function ensayado(nombre: string, hash: string, ronda: number, v = verdict) {
  for (const revisor of ["critico", "oracle"]) db.query("INSERT INTO ensayos (plan, ronda, hash, revisor, actor, veredicto) VALUES (?, ?, ?, ?, 'p/m', ?)").run(nombre, ronda, hash, revisor, v);
}

test("estreno accepts two approvals on current hash, seeds tasks and resumes instead of resetting", () => {
  // Given: both reviewers approved exactly the current version.
  const nombre = `${plan}-approved`;
  ensayado(nombre, "A", 1);
  // When: Bryan invokes the command for the version twice, with progress in between.
  const ref = { plan: nombre, hash: "A" };
  const first = registrarEstreno(db, ref, contenido, false);
  escribirPendientes(db, clavePlan(ref), [{ ...first.items[0]!, estado: "hecho" }, first.items[1]!]);
  const resumed = registrarEstreno(db, ref, contenido, false);
  // Then: the first task stays done and the second remains pending.
  expect(first.estreno.tipo).toBe("normal");
  expect(resumed.items.map((item) => item.estado)).toEqual(["hecho", "pendiente"]);
  expect(tareas(contenido).map((item) => item.texto)).toEqual(["T1: first", "T2: second"]);
  ligarSesion(db, "ses_regidor_demo", ref);
  expect(planDeSesion(db, "ses_regidor_demo")).toEqual(ref);
});

test("estreno refuses an edited current file even after version A was approved", () => {
  // Given: A was reviewed; When: current content hashes as B; Then: no estreno.
  const nombre = `${plan}-edit`;
  ensayado(nombre, "A", 1);
  expect(() => evaluarEstreno(db, nombre, "B", false)).toThrow(/cambió.*versión ensayada/);
  registrarEstreno(db, { plan: nombre, hash: "A" }, contenido, false);
  expect(() => registrarEstreno(db, { plan: nombre, hash: "B" }, contenido + "edited", false)).toThrow(/cambió después del estreno/);
});

test("con-objeciones requires completed fifth round and retains the open acta", () => {
  // Given: five completed rounds without approval, with an open objection.
  const nombre = `${plan}-fifth`;
  const objeciones = JSON.stringify({ veredicto: "OBJECIONES", objeciones: [{ seccion: "T1" }], notas: [], cierres: {} });
  for (let ronda = 1; ronda <= 5; ronda++) ensayado(nombre, "A", ronda, objeciones);
  db.query("INSERT INTO acta (plan, id, objecion, causa, condicion_cierre, ronda_entrada, estado) VALUES (?, 1, 'T1: risk', 'data', 'fix', 1, 'abierto')").run(nombre);
  // When: Bryan invokes the override; Then: the open objection is recorded.
  expect(() => evaluarEstreno(db, nombre, "A", false)).toThrow(/quedan objeciones/);
  const result = registrarEstreno(db, { plan: nombre, hash: "A" }, contenido, true);
  expect(result.estreno.tipo).toBe("con_objeciones");
  expect(JSON.parse(result.estreno.objeciones)).toMatchObject([{ id: 1, estado: "abierto" }]);
  const temprano = `${plan}-early`;
  ensayado(temprano, "A", 4, objeciones);
  expect(() => evaluarEstreno(db, temprano, "A", true)).toThrow(/requiere 5 rondas/);
});

test("continuation: idle continues, background waits, interrupt blocks, unchanged twice stops", () => {
  // Given: two unfinished tasks and no prior continuation.
  const items = tareas(contenido);
  const empty = { firma: null, intentos: 0, interrumpido: 0, detenido: 0 };
  // When: the session becomes idle; Then: one continuation is allowed.
  expect(decidirContinuacion(items, 0, empty)).toEqual({ tipo: "continuar", intentos: 1 });
  expect(decidirContinuacion(items, 2, empty).tipo).toBe("esperar");
  expect(decidirContinuacion(items, 0, { ...empty, interrumpido: 1 }).tipo).toBe("interrumpido");
  expect(decidirContinuacion(items, 0, { ...empty, firma: JSON.stringify(items), intentos: 2 }).tipo).toBe("detener");
  expect(decidirContinuacion([{ ...items[0]!, estado: "hecho" }, items[1]!], 0, { ...empty, firma: JSON.stringify(items), intentos: 2 })).toEqual({ tipo: "continuar", intentos: 1 });
});

test("two open background encargos suppress continuation until they close", () => {
  // Given: real DB rows for a seeded plan and two open background children.
  const ref = { plan: `${plan}-bg`, hash: "A" };
  const sesion = `ses_${crypto.randomUUID()}`;
  escribirPendientes(db, clavePlan(ref), tareas(contenido));
  for (const hija of ["one", "two"]) db.query(`INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
    VALUES (?, ?, 'rapido', 'p/m', 1, 'corriendo', 'b', 1, '1', 0)`).run(`${sesion}-${hija}`, sesion);
  // When: the regidor goes idle; Then: it waits rather than prompting itself.
  expect(decisionGuardada(db, sesion, ref)?.decision.tipo).toBe("esperar");
  db.query("UPDATE encargos SET estado = 'terminado' WHERE padre = ?").run(sesion);
  expect(decisionGuardada(db, sesion, ref)?.decision.tipo).toBe("continuar");
  expect(leerPendientes(db, clavePlan(ref))).toHaveLength(2);
});
