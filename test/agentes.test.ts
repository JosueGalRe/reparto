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
