import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { env } from "../config/env.js";

// Bound health probes independently so a database outage cannot exhaust the application pool.
export const readinessPool = new pg.Pool({ connectionString: env.databaseUrl, max: 1, connectionTimeoutMillis: 2000, query_timeout: 2000, idleTimeoutMillis: 1000 });
readinessPool.on("error", () => {});

export async function checkReadiness(database = readinessPool, directory = join(env.uploadRoot, "beneficiary-documents")) {
  await database.query("SELECT 1");
  const probe = join(directory, `.readiness-${randomUUID()}`);
  const file = await open(probe, "wx", 0o600);
  try {
    await file.writeFile("ready");
    await file.sync();
  } finally {
    await file.close();
    await unlink(probe);
  }
}
