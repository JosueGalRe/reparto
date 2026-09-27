import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { actualizarActa, admitir, cerrado, elegirRevisores, parsearVeredicto } from "../src/ensayo.ts";
import type { Validacion } from "../src/actores.ts";

const dir = mkdtempSync(join(tmpdir(), "reparto-ensayo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("parses approved, section-level objections and closure lines", () => {
  // Given: verdicts in the reviewers' wire format.
  const aprobado = "VEREDICTO: APROBADO\nACTA: 1 | cerrado\nNOTA: optional polish";
  const objetado = "VEREDICTO: OBJECIONES\nOBJECION: Tasks/T1 | no verification command | outcome not checked | add runnable check";
  // When: the lines are parsed; Then: their semantic fields survive.
  expect(parsearVeredicto(aprobado)).toEqual({ veredicto: "APROBADO", objeciones: [], cierres: { 1: "cerrado" }, notas: ["optional polish"] });
  expect(parsearVeredicto(objetado).objeciones).toEqual([{ seccion: "Tasks/T1", defecto: "no verification command", causa: "outcome not checked", cierre: "add runnable check" }]);
});

test("selects distinct available providers, or marks repeated providers after bajas", () => {
  // Given: the dramaturgo uses openai, and oracle has one alternate provider.
  const validacion: Validacion = { actores: new Map([
    ["critico", [{ model: "openai/cheap" }, { model: "kimi-code-plan-global/cheap" }]],
    ["oracle", [{ model: "openai/other" }, { model: "opencode-go/cheap" }]],
  ]), exclusiones: [], desactivados: [], desconocidos: [] };
  // When: all actors are available; Then: neither reviewer shares the dramaturgo's provider.
  expect(elegirRevisores(validacion, "openai", () => false)).toEqual({ critico: { model: "kimi-code-plan-global/cheap" }, oracle: { model: "opencode-go/cheap" }, repetidos: false });
  // Even if one reviewer must share the dramaturgo's provider, keep the reviewers distinct.
  expect(elegirRevisores(validacion, "openai", (a) => a.model.startsWith("kimi-code-plan-global/"))).toEqual({ critico: { model: "openai/cheap" }, oracle: { model: "opencode-go/cheap" }, repetidos: true });
  // When: both alternate providers are down; Then: the round still runs, explicitly marked.
  expect(elegirRevisores(validacion, "openai", (a) => !a.model.startsWith("openai/"))?.repetidos).toBe(true);
  expect(elegirRevisores(validacion, "openai", () => true)).toBeUndefined();
});

test("round-one objections form acta; unjustified new objection stays a note and cannot reopen it", () => {
  const db = openDb(join(dir, "acta.db"));
  const first = parsearVeredicto("VEREDICTO: OBJECIONES\nOBJECION: T1 | missing verification | unchecked result | add bun test");
  const approved = parsearVeredicto("VEREDICTO: APROBADO");
  // Given: one accepted objection from discovery; When: the acta is formed.
  const initial = db.transaction(() => actualizarActa(db, "plan.md", 1, [first, approved]))();
  // Then: it has an open condition and origin.
  expect(initial).toMatchObject([{ objecion: "T1: missing verification", causa: "unchecked result", condicion_cierre: "add bun test", ronda_entrada: 1, estado: "abierto" }]);
  const late = parsearVeredicto("VEREDICTO: OBJECIONES\nACTA: 1 | cerrado\nOBJECION: T2 | old typo | typo | fix typo");
  // Given: closure on acta 1 plus a new objection without justification; When: the next round is applied.
  const effective = admitir(late, 2, initial);
  const final = db.transaction(() => actualizarActa(db, "plan.md", 2, [effective, parsearVeredicto("VEREDICTO: APROBADO\nACTA: 1 | cerrado")]))();
  // Then: no new acta entry blocks closure; the late issue is a note.
  expect(final).toHaveLength(1);
  expect(final[0]?.estado).toBe("cerrado");
  expect(effective.notas).toContain("T2: old typo");
  expect(cerrado([effective, approved], final, ["new-hash", "new-hash"])).toBe(true);
  db.close();
});

test("approval closes only when both reviewers approved the same hash and all acta entries closed", () => {
  // Given: two approvals and a closed acta entry; When: hashes diverge; Then: no closure.
  const v = parsearVeredicto("VEREDICTO: APROBADO");
  const entry = { plan: "p", id: 1, objecion: "T1", causa: "x", condicion_cierre: "fix", ronda_entrada: 1, estado: "cerrado" as const };
  expect(cerrado([v, v], [entry], ["one", "two"])).toBe(false);
  expect(cerrado([v, v], [{ ...entry, estado: "abierto" }], ["one", "one"])).toBe(false);
  expect(cerrado([v, v], [entry], ["one", "one"])).toBe(true);
});
