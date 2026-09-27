import { expect, test } from "bun:test";
import { motivoNegado, permisos, ruteo } from "../src/agentes.ts";

test.each([
  ["rg x > f", "redirección"],
  ["rg x < f", "redirección"],
  ["git diff <(touch f)", "redirección"],
  ["rg `touch f`", "backticks"],
  ["rg x\ntouch f", "salto de línea"],
  ["git diff --output=f", "opción --output"],
  ["git diff --output f", "opción --output"],
  ["git diff --ext-diff", "opción --ext-diff"],
  ["git diff --textconv HEAD", "opción --textconv"],
  ["rg --pre cat x", "opción --pre"],
  ["rg --pre-glob '*.gz' x", "opción --pre-glob"],
])("niega %s", (tramo, motivo) => {
  expect(motivoNegado(tramo)).toBe(motivo);
});

test.each(["rg x", "rg --pretty x", "git diff --stat", "git status --short", "head -5"])("deja pasar %s", (tramo) => {
  expect(motivoNegado(tramo)).toBeUndefined();
});

test("director: la lista permitida va después de negar todo, y las restricciones de la base al final", () => {
  const base = [
    { action: "*", resource: "*", effect: "allow" as const },
    { action: "read", resource: "*.env", effect: "ask" as const },
  ];
  const { director, papel } = permisos(base);
  const ultima = (action: string, resource = "*") =>
    director.findLast((r) => (r.action === action || r.action === "*") && (r.resource === resource || r.resource === "*"))?.effect;
  expect(ultima("edit")).toBe("deny");
  expect(ultima("pty_spawn")).toBe("deny");
  expect(ultima("execute")).toBe("deny");
  expect(ultima("delegar")).toBe("allow");
  expect(ultima("read", "*.env")).toBe("ask");
  expect(papel.slice(-3).map((r) => [r.action, r.effect])).toEqual([["question", "deny"], ["subagent", "deny"], ["delegar", "deny"]]);
});

test("director: permite solo los comandos de lectura reescritos por rtk", () => {
  const reglas = permisos([]).director;
  const efecto = (resource: string) =>
    reglas.findLast((rule) =>
      (rule.action === "shell" || rule.action === "*") &&
      (rule.resource === "*" || rule.resource === resource || (rule.resource.endsWith("*") && resource.startsWith(rule.resource.slice(0, -1)))),
    )?.effect;

  expect(efecto("rtk git status")).toBe("allow");
  expect(efecto("rtk rg x")).toBe("allow");
  expect(efecto("head -1")).toBe("allow"); // el otro tramo de `rtk rg x | head -1`
  expect(efecto("rtk read x")).toBe("deny");
  expect(efecto("rtk curl https://example.com")).toBe("deny");
  expect(efecto("ls -la")).toBe("deny");
  expect(efecto("rg x > f")).toBe("allow");
  expect(motivoNegado("rg x > f")).toBe("redirección");
});

test("utilero: shell abierto, edición y delegación negadas", () => {
  const reglas = permisos([]).subagenteLectura;
  const efecto = (action: string, resource: string) =>
    reglas.findLast((rule) =>
      (rule.action === action || rule.action === "*") &&
      (rule.resource === "*" || rule.resource === resource || (rule.resource.endsWith("*") && resource.startsWith(rule.resource.slice(0, -1)))),
    )?.effect;

  for (const command of ["ls -la", "jq . f", "sqlite3 -readonly db 'select 1'"]) expect(efecto("shell", command)).toBe("allow");
  for (const tool of ["edit", "write", "patch", "subagent", "delegar", "interrumpir"]) expect(efecto(tool, "*")).toBe("deny");
});

test("ruteo: un papel desactivado no aparece en la tabla, y las exclusiones se listan", () => {
  const texto = ruteo({
    actores: new Map(),
    exclusiones: [{ nombre: "prosa", tipo: "papel", actor: "opencode-go/qwen3.7-plus#off", motivo: "el variant \"off\" no está en el catálogo" }],
    desactivados: ["prosa"],
    desconocidos: [],
  });
  expect(texto).toContain("| `profundo` |");
  expect(texto).not.toContain("| `prosa` |");
  expect(texto).toContain("Disabled papeles");
  expect(texto).toContain("opencode-go/qwen3.7-plus#off");
});

test("el guion de lectura lista exactamente los comandos permitidos", async () => {
  const { comandosDeLectura, seccionShell } = await import("../src/agentes.ts");
  for (const comando of comandosDeLectura) expect(seccionShell).toContain(`\`${comando}\``);
  expect(comandosDeLectura).toEqual(expect.arrayContaining(["git ls-files*", "git log*", "git show*"]));
});
