import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Los tests no escriben en ~/.local/share/reparto (log y base reales).
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "reparto-test-"));
