import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registrarBaja } from "../src/bajas.ts";
import { openDb } from "../src/db.ts";
import { imponerHija } from "../src/index.ts";
import { proceso } from "../src/process.ts";

const dir = mkdtempSync(join(tmpdir(), "reparto-hijas-"));
beforeAll(() => {
  proceso.db = openDb(join(dir, "hijas.db"));
  proceso.validacion = { actores: new Map([["rapido", [{ model: "luna/a", variant: "low" }, { model: "other/b" }]]]), exclusiones: [], desactivados: [], desconocidos: [] };
});
afterAll(() => {
  proceso.db?.close();
  proceso.db = undefined;
  proceso.validacion = undefined;
  rmSync(dir, { recursive: true, force: true });
});

test("native child takes its configured actor on first and continued turns, including a baja", async () => {
  // Given: a native child inheriting the parent's model.
  const session: { parentID: string; agent: string; model: { providerID: string; id: string; variant?: string } } = { parentID: "ses_parent", agent: "rapido", model: { providerID: "other", id: "parent" } };
  const switched: unknown[] = [];
  const ctx = { session: { get: async () => session, switchModel: async (input: { model: typeof session.model }) => {
    switched.push(input.model);
    session.model = input.model;
  } } };
  // When: its first prompt and continued prompt arrive.
  expect(await imponerHija(ctx as never, "ses_child")).toBe(true);
  expect(await imponerHija(ctx as never, "ses_child")).toBe(true);
  // Then: the first actor includes the variant, and no redundant switch occurs.
  expect(switched).toEqual([{ providerID: "luna", id: "a", variant: "low" }]);

  // Given: the titular's provider goes on baja; When: the next turn arrives.
  registrarBaja(proceso.db!, { tipo: "proveedor", id: "luna", motivo: "cuota", hasta: Date.now() + 60_000 });
  // Then: the suplente is selected for the continued turn.
  expect(await imponerHija(ctx as never, "ses_child")).toBe(true);
  expect(switched).toEqual([{ providerID: "luna", id: "a", variant: "low" }, { providerID: "other", id: "b" }]);
  proceso.db!.query("DELETE FROM bajas").run();
});
