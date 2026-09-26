import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { escribirPendientes, formatear, leerPendientes, parsearItems } from "../src/pendientes.ts";

test("reescribir y leer la lista de una sesión; otra sesión no la ve", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "reparto-pend-")), "p.db"));
  escribirPendientes(db, "ses_a", parsearItems({ items: [{ texto: "leer" }, { texto: "delegar", estado: "en_curso" }] })!);
  escribirPendientes(db, "ses_a", parsearItems({ items: [{ texto: "leer", estado: "hecho" }, { texto: "delegar", estado: "en_curso" }] })!);
  expect(formatear(leerPendientes(db, "ses_a"))).toBe("1. [x] leer\n2. [~] delegar");
  expect(leerPendientes(db, "ses_b")).toEqual([]);
});

test("sin items es lectura; items inválidos se rechazan", () => {
  expect(parsearItems({})).toBeUndefined();
  expect(() => parsearItems({ items: [{ texto: "x", estado: "listo" }] })).toThrow(/estado/);
  expect(() => parsearItems({ items: [{}] })).toThrow(/texto/);
});
