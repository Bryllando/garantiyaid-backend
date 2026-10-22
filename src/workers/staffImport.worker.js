import prisma from "../lib/prisma.js";
import { claimStaffImport, processStaffImportBatch } from "../modules/users/staffImportJob.service.js";

// Database leases let an interrupted import resume after an API restart.
export function startStaffImportWorker({ database = prisma, intervalMs = 2000 } = {}) {
  let stopping = false;
  let timer;
  let pending = Promise.resolve();
  let lastCleanup = 0;
  async function tick() {
    try {
      if (Date.now() - lastCleanup > 60_000) {
        await database.staffImportJob.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        lastCleanup = Date.now();
      }
      const job = await claimStaffImport(database);
      if (job) await processStaffImportBatch(job, database);
    } catch (error) {
      console.warn({ event: "STAFF_IMPORT_WORKER_UNAVAILABLE", errorCode: error.code ?? "DATABASE_UNAVAILABLE" });
    } finally {
      if (!stopping) timer = setTimeout(() => { pending = tick(); }, intervalMs);
    }
  }
  pending = tick();
  return async () => { stopping = true; clearTimeout(timer); await pending; };
}
