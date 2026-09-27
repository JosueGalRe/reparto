import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { argumentoClave, leer, posterior, puedeDelegar, textoAviso, tituloEncargo, transicion, vivo, yo } from "../src/encargos.ts";
import { proceso } from "../src/process.ts";

const dir = mkdtempSync(join(tmpdir(), "reparto-encargos-"));
beforeAll(() => {
  proceso.db = openDb(join(dir, "e.db"));
});
afterAll(() => {
  proceso.db?.close();
  proceso.db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function crear(estado: string) {
  return Number(
    proceso
      .db!.query(
        `INSERT INTO encargos (hija, padre, a, actor, background, estado, boot_id, pid, starttime, creado)
         VALUES ($hija, 'ses_p', 'rapido', 'openai/x', 1, $estado, 'b', 1, '1', 0)`,
      )
      .run({ hija: `ses_${crypto.randomUUID()}`, estado }).lastInsertRowid,
  );
}

test("transición atómica: de dos instancias con la misma foto, gana una sola", () => {
  const foto = leer(crear("corriendo"))!;
  expect(transicion(foto, "terminado", { mensaje_final: "ok", aviso_pendiente: 1 })).toBe(true);
  expect(transicion(foto, "fallido")).toBe(false);
  expect(leer(foto.id)).toMatchObject({ estado: "terminado", mensaje_final: "ok", aviso_pendiente: 1 });
});

test("transiciones no permitidas: los terminales no se reabren y en_cola no termina sin correr", () => {
  expect(transicion(leer(crear("terminado"))!, "corriendo")).toBe(false);
  expect(transicion(leer(crear("en_cola"))!, "terminado")).toBe(false);
  expect(transicion(leer(crear("estancado"))!, "corriendo")).toBe(true);
});

test("un cierre de una ejecución anterior (antes de `desde`) no cuenta para la fila retomada", () => {
  expect(posterior(1_000, 2_000)).toBe(false);
  expect(posterior(2_000, 2_000)).toBe(false);
  expect(posterior(2_001, 2_000)).toBe(true);
  expect(posterior(undefined, 2_000)).toBe(false);
  expect(posterior(5_000, null)).toBe(false);
});

test("vivo: este proceso sí; otro starttime u otro arranque, no", () => {
  expect(vivo(yo)).toBe(true);
  expect(vivo({ ...yo, starttime: "0" })).toBe(false);
  expect(vivo({ ...yo, boot_id: "otro" })).toBe(false);
});

test("dramaturgo solo delega lectura; director mantiene los papeles", () => {
  // Given: destinations for research and implementation.
  // When: each primary agent delegates; Then: the dramaturgo cannot launch an editing papel.
  for (const a of ["utilero", "archivista", "oracle"]) expect(puedeDelegar("dramaturgo", a)).toBe(true);
  expect(puedeDelegar("dramaturgo", "protagonista")).toBe(false);
  expect(puedeDelegar("director", "protagonista")).toBe(true);
});

test("argumento clave de una tool call", () => {
  expect(argumentoClave(JSON.stringify({ filePath: "/a/b.ts", limit: 3 }))).toBe("filePath=/a/b.ts");
  expect(argumentoClave(JSON.stringify({ command: "rg x\n| head" }))).toBe("command=rg x | head");
  expect(argumentoClave(JSON.stringify({ n: 1 }))).toBe("");
});

test("título de encargo resume la primera línea no vacía y recorta a 60 caracteres", () => {
  expect(tituloEncargo("protagonista", `\n  ${"palabra ".repeat(10)}fin\nresto`)).toBe(`protagonista · ${`${"palabra ".repeat(7)}palabra `.slice(0, 60)}…`);
  expect(tituloEncargo("rapido", "\n  resumen corto  \nresto")).toBe("rapido · resumen corto");
});

test("aviso terminado incluye título, resultado y pista de bitácora", () => {
  const e = { ...leer(crear("terminado"))!, mensaje_final: "OK" };
  const texto = textoAviso(e, "openai/x", "rapido · Responder OK");
  expect(texto).toBe(`[reparto] rapido · Responder OK — terminado (${e.hija})\n\nOK\n(bitacora({ id: "${e.hija}" }) para el resto)`);
});

test("aviso fallido incluye error, último actor y suplente", () => {
  const e = { ...leer(crear("fallido"))!, error: "sin salida", mensaje_final: "último" };
  const texto = textoAviso(e, "openai/y", "rapido · Responder OK");
  expect(texto).toContain(`— fallido (${e.hija})\n\nError: sin salida. Último actor: openai/y.`);
  expect(texto).toContain("entró como suplente en lugar de openai/x.");
  expect(texto).toContain("Último mensaje: último");
});

test("aviso recorta el resultado largo", () => {
  const e = { ...leer(crear("terminado"))!, mensaje_final: "x".repeat(2_000) };
  const texto = textoAviso(e, "openai/x", "rapido · Responder OK");
  expect(texto).toContain(`${"x".repeat(1_500)}\n[… recortado, 500 caracteres más]`);
  expect(texto).not.toContain("x".repeat(1_501));
});
