import type { Database } from "bun:sqlite";
import { write } from "./db.ts";

export interface Baja {
  tipo: "proveedor" | "actor";
  /** providerID, o `<provider>/<model>#<variant>` para una baja de actor. */
  id: string;
  motivo: string;
  /** ms epoch */
  hasta: number;
}

// La última información gana: el reset que informa el proveedor reemplaza al anterior.
export const registrarBaja = (db: Database, baja: Baja) =>
  write(db, "registrar baja", () =>
    db
      .query(
        `INSERT INTO bajas (tipo, id, motivo, hasta) VALUES ($tipo, $id, $motivo, $hasta)
         ON CONFLICT (tipo, id) DO UPDATE SET motivo = excluded.motivo, hasta = excluded.hasta`,
      )
      .run({ ...baja }),
  );

export const bajasVigentes = (db: Database, ahora = Date.now()): Baja[] =>
  db.query("SELECT tipo, id, motivo, hasta FROM bajas WHERE hasta > $ahora ORDER BY hasta").all({ ahora }) as Baja[];
