import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { argumentoClave, encargos, leer, permisoPendiente, posterior, puedeDelegar, registrarPermiso, textoAviso, textoPermiso, tituloEncargo, transicion, vivo, yo } from "../src/encargos.ts";
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

test("regidor without an estreno cannot delegate", async () => {
  // Given: a regidor session without a matching estreno and validated actors.
  const previous = proceso.validacion;
  proceso.validacion = { actores: new Map(), exclusiones: [], desactivados: [], desconocidos: [] };
  const ctx = { session: { get: async () => ({ agent: "regidor", location: { directory: dir } }) } };
  try {
    proceso.db?.query("INSERT INTO sesiones_regidor (sesion, plan, hash) VALUES ('ses_unapproved', '/repo/demo.md', 'A')").run();
    // When: it calls delegar; Then: it is directed to the estreno command.
    const e = encargos(ctx as unknown as Parameters<typeof encargos>[0], {});
    await expect(e.delegar({ a: "utilero", prompt: "read" }, { sessionID: "ses_unapproved" } as Parameters<typeof e.delegar>[1])).rejects.toThrow("usa /estreno <plan>");
  } finally {
    proceso.validacion = previous;
  }
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

test("aviso de permiso identifica la solicitud y dirige a la hija en chats", () => {
  // Given: un permiso de lectura externa de una hija titulada.
  const title = "utilero · Leer secreto";
  // When: se construye el aviso visible.
  const text = textoPermiso(title, "external_directory", ["/tmp/reparto-outside/*"], "per_1");
  // Then: contiene los identificadores y la acción humana, sin sugerir aprobación por el director.
  expect(text).toContain(`[reparto] ${title} — espera permiso: external_directory /tmp/reparto-outside/* (per_1)`);
  expect(text).toContain("Ábrela en chats por su título y aprueba o rechaza ahí.");
});

test("un requestID duplicado solo gana el INSERT una vez", () => {
  // Given: la primera instancia registra un permiso de un encargo.
  const hija = leer(crear("corriendo"))!.hija;
  const request = { id: `per_${crypto.randomUUID()}`, sessionID: hija, action: "external_directory", resources: ["/tmp/outside/*"] };
  expect(registrarPermiso(request)).toBe(true);
  // When: otra instancia procesa el mismo evento.
  const second = registrarPermiso(request);
  // Then: no se vuelve a notificar.
  expect(second).toBe(false);
});

test("permission.asked actualiza actividad y evita estancado mientras espera", async () => {
  // Given: un encargo abierto con actividad vieja y una notificación observable.
  const e = leer(crear("corriendo"))!;
  proceso.abiertos = new Map([[e.hija, { id: e.id, actividad: 1 }]]);
  let notices = 0;
  let notified: () => void = () => {};
  const notice = new Promise<void>((resolve) => { notified = resolve; });
  const ctx = { session: { get: async () => ({ title: "utilero · Leer secreto" }), prompt: async () => { notices++; notified(); } } };
  const job = encargos(ctx as never, {} as never);
  // When: llega el evento de V2.
  const asked = { type: "permission.asked", data: { id: `per_${crypto.randomUUID()}`, sessionID: e.hija, action: "external_directory", resources: ["/tmp/outside/*"] } };
  job.evento(asked);
  job.evento(asked);
  await notice;
  // Then: se registró la espera y el vigilante no marca estancado ni con actividad antigua.
  expect(notices).toBe(1);
  expect(proceso.abiertos.get(e.hija)?.actividad).toBeGreaterThan(1);
  expect(permisoPendiente(e.hija)).toBe(true);
  proceso.abiertos.get(e.hija)!.actividad = 1;
  await job.vigilar();
  expect(leer(e.id)?.estado).toBe("corriendo");
  proceso.abiertos.delete(e.hija);
});

test("permission.replied actualiza actividad y cierra la espera", () => {
  // Given: un permiso pendiente en un encargo abierto.
  const e = leer(crear("corriendo"))!;
  const requestID = `per_${crypto.randomUUID()}`;
  registrarPermiso({ id: requestID, sessionID: e.hija, action: "read", resources: ["/tmp/outside/*"] });
  proceso.abiertos = new Map([[e.hija, { id: e.id, actividad: 1 }]]);
  // When: V2 informa la respuesta dada en la hija.
  encargos({} as never, {} as never).evento({ type: "permission.replied", data: { sessionID: e.hija, requestID, reply: "once" } });
  // Then: se libera la espera y queda registrada actividad reciente.
  expect(permisoPendiente(e.hija)).toBe(false);
  expect(proceso.abiertos.get(e.hija)?.actividad).toBeGreaterThan(1);
  proceso.abiertos.delete(e.hija);
});
