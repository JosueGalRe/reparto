import { expect, test } from "bun:test";
import { resolver, siguiente, type Validacion } from "../src/actores.ts";
import { type Baja, clasificar, deBaja, type ErrorCrudo, guardarError, reset, tomarError } from "../src/bajas.ts";

// Cuerpos y headers de las sondas S3 (test/fixtures/s3-errores.jsonl)
const lineas = (await Bun.file(new URL("./fixtures/s3-errores.jsonl", import.meta.url)).text())
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const http = (status: number, codigo?: string) =>
  lineas.find((l) => l.sonda === "s3.http.error" && l.status === status && (!codigo || l.body.includes(codigo)));
const crudo = (l: { body: string; headers: Record<string, string> }, actor = "a/b#default"): ErrorCrudo => ({ actor, cuerpo: l.body, headers: l.headers });
const ws = lineas.find((l) => l.sonda === "s3.ws.receive");
const ahora = Date.parse("2026-09-25T15:40:00Z");

test("openai por WebSocket: cuota con el reset del frame (resets_at)", () => {
  expect(clasificar({ type: "provider.quota" }, { actor: "x", cuerpo: ws.frame, headers: {} }, ahora)).toEqual({
    tipo: "cuota",
    hasta: 1790440200 * 1000,
  });
});

test("claude-code: el rate-limit con claude_session_limit es cuota, hasta su resets_at", () => {
  expect(clasificar({ type: "provider.rate-limit" }, crudo(http(429, "claude_session_limit")), ahora)).toEqual({
    tipo: "cuota",
    hasta: Date.parse("2026-09-25T17:38:25.347Z"),
  });
});

test("kimi: insufficient_quota es cuota sin reset (cae en plazoBaja); rate_limit_exceeded es velocidad", () => {
  expect(clasificar({ type: "provider.quota" }, crudo(http(429, "insufficient_quota")), ahora)).toEqual({ tipo: "cuota", hasta: undefined });
  expect(clasificar({ type: "provider.rate-limit" }, crudo(http(429, "rate_limit_exceeded")), ahora)).toEqual({ tipo: "velocidad" });
  expect(clasificar({ type: "provider.internal" }, crudo(http(503)), ahora)).toEqual({ tipo: "interno" });
  expect(clasificar({ type: "provider.auth" }, crudo(http(401)), ahora)).toEqual({ tipo: "auth" });
});

test("sin cuerpo vale la clasificación de V2 sin corregir", () => {
  expect(clasificar({ type: "provider.rate-limit" }, undefined)).toEqual({ tipo: "velocidad" });
  expect(clasificar({ type: "provider.quota" }, undefined)).toEqual({ tipo: "cuota", hasta: undefined });
});

test("un error de una request kind: title intercalado antes del retry no cambia la clasificación", () => {
  const errores = new Map<string, ErrorCrudo>();
  guardarError(errores, "ses_x", "primary", crudo(http(429, "claude_session_limit"), "claude-code/opus#xhigh"));
  guardarError(errores, "ses_x", "title", crudo(http(429, "rate_limit_exceeded"), "claude-code/opus#xhigh"));
  const tomado = tomarError(errores, "ses_x", "claude-code/opus#xhigh");
  expect(clasificar({ type: "provider.rate-limit" }, tomado, ahora).tipo).toBe("cuota");
  expect(errores.has("ses_x")).toBe(false);
});

test("el cuerpo del actor anterior no se reusa después de un cambio", () => {
  const errores = new Map<string, ErrorCrudo>();
  guardarError(errores, "ses_x", "primary", crudo(http(429, "claude_session_limit"), "claude-code/opus#xhigh"));
  const tomado = tomarError(errores, "ses_x", "kimi-code-plan-global/k3#max");
  expect(tomado).toBeUndefined();
  expect(clasificar({ type: "provider.rate-limit" }, tomado, ahora)).toEqual({ tipo: "velocidad" });
});

test("reset: segundos, ms, ISO y retry-after relativo", () => {
  expect(reset({ actor: "", cuerpo: "{}", headers: { "Retry-After": "60" } }, ahora)).toBe(ahora + 60_000);
  expect(reset({ actor: "", cuerpo: '{"error":{"resets_in_seconds":10}}', headers: {} }, ahora)).toBe(ahora + 10_000);
  expect(reset({ actor: "", cuerpo: "no es json", headers: {} }, ahora)).toBeUndefined();
});

const validacion: Validacion = {
  actores: new Map([
    [
      "visual",
      [
        { model: "claude-code/claude-opus-5-5", variant: "xhigh" },
        { model: "claude-code/claude-fable-5-1", variant: "xhigh" },
        { model: "kimi-code-plan-global/k3", variant: "max" },
        { model: "opencode-go/kimi-k3" },
      ],
    ],
  ]),
  exclusiones: [],
  desactivados: [],
  desconocidos: [],
};
const baja = (id: string): Baja => ({ tipo: "proveedor", id, motivo: "cuota", hasta: Infinity });

test("con el titular de baja, la resolución salta todo su proveedor", () => {
  expect(resolver(validacion, "visual", deBaja([baja("claude-code")]))).toEqual({ model: "kimi-code-plan-global/k3", variant: "max" });
  expect(resolver(validacion, "visual", deBaja([baja("claude-code"), baja("kimi-code-plan-global"), baja("opencode-go")]))).toBeUndefined();
});

test("siguiente: después del actual y sin bajas; `default` en la sesión equivale a omitir el variant", () => {
  const opus = { providerID: "claude-code", id: "claude-opus-5-5", variant: "xhigh" };
  expect(siguiente(validacion, "visual", opus, deBaja([baja("claude-code")]))).toEqual({ model: "kimi-code-plan-global/k3", variant: "max" });
  expect(siguiente(validacion, "visual", opus, () => false)).toEqual({ model: "claude-code/claude-fable-5-1", variant: "xhigh" });
  const ultimo = { providerID: "opencode-go", id: "kimi-k3", variant: "default" };
  expect(siguiente(validacion, "visual", ultimo, () => false)).toBeUndefined();
  // un modelo puesto a mano, fuera de la lista: el primero disponible
  expect(siguiente(validacion, "visual", { providerID: "openai", id: "gpt-5.5" }, deBaja([baja("claude-code")]))).toEqual({
    model: "kimi-code-plan-global/k3",
    variant: "max",
  });
});
