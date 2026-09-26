import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "reparto");
const file = join(dataDir, "reparto.log");

function write(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, level, message, ...data });
  console.error(`[reparto] ${line}`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line + "\n");
  } catch {
    // ponytail: el log nunca tumba al plugin; stderr ya lo tiene
  }
}

export const log = {
  info: (message: string, data?: Record<string, unknown>) => write("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => write("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) => write("error", message, data),
};
