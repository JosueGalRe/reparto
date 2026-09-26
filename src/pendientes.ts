import type { Database } from "bun:sqlite";
import { write } from "./db.ts";

export const estados = ["pendiente", "en_curso", "hecho", "descartado"] as const;
export interface Item {
  texto: string;
  estado: (typeof estados)[number];
}

export function leerPendientes(db: Database, clave: string): Item[] {
  const fila = db.query("SELECT items FROM pendientes WHERE clave = $clave").get({ clave }) as { items: string } | null;
  return fila ? (JSON.parse(fila.items) as Item[]) : [];
}

export function escribirPendientes(db: Database, clave: string, items: Item[]) {
  return write(db, "pendientes", () =>
    db
      .query(
        `INSERT INTO pendientes (clave, items, actualizado) VALUES ($clave, $items, $ahora)
         ON CONFLICT (clave) DO UPDATE SET items = excluded.items, actualizado = excluded.actualizado`,
      )
      .run({ clave, items: JSON.stringify(items), ahora: Date.now() }),
  );
}

export function parsearItems(input: unknown): Item[] | undefined {
  const x = (input ?? {}) as { items?: unknown };
  if (x.items === undefined) return undefined;
  if (!Array.isArray(x.items)) throw new Error("pendientes: `items` tiene que ser una lista");
  return x.items.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.texto !== "string" || !r.texto.trim()) throw new Error(`pendientes: items[${i}] sin \`texto\``);
    const estado = r.estado ?? "pendiente";
    if (!estados.includes(estado as Item["estado"])) throw new Error(`pendientes: items[${i}].estado tiene que ser ${estados.join(", ")}`);
    return { texto: r.texto, estado: estado as Item["estado"] };
  });
}

const marca: Record<Item["estado"], string> = { pendiente: "[ ]", en_curso: "[~]", hecho: "[x]", descartado: "[-]" };

export const formatear = (items: Item[]) =>
  items.length ? items.map((item, i) => `${i + 1}. ${marca[item.estado]} ${item.texto}`).join("\n") : "(la lista está vacía)";
