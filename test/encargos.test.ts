import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { argumentoClave, leer, posterior, transicion, vivo, yo } from "../src/encargos.ts";
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

test("argumento clave de una tool call", () => {
  expect(argumentoClave(JSON.stringify({ filePath: "/a/b.ts", limit: 3 }))).toBe("filePath=/a/b.ts");
  expect(argumentoClave(JSON.stringify({ command: "rg x\n| head" }))).toBe("command=rg x | head");
  expect(argumentoClave(JSON.stringify({ n: 1 }))).toBe("");
});
