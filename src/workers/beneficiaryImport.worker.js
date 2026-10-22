import prisma from "../lib/prisma.js";
import { claimBeneficiaryImport, processBeneficiaryImportBatch } from "../modules/beneficiaries/beneficiaryImportJob.service.js";

// Database leases let an interrupted import resume after an API restart.
export function startBeneficiaryImportWorker({ database = prisma, intervalMs = 2000 } = {}) {
  let stopping = false;
  let timer;
  let pending = Promise.resolve();
  let lastCleanup = 0;
  async function tick() {
    try {
      if (Date.now() - lastCleanup > 60_000) {
        await database.beneficiaryImportJob.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        lastCleanup = Date.now();
      }
      const job = await claimBeneficiaryImport(database);
      if (job) await processBeneficiaryImportBatch(job, database);
    } catch (error) {
      console.warn({ event: "BENEFICIARY_IMPORT_WORKER_UNAVAILABLE", errorCode: error.code ?? "DATABASE_UNAVAILABLE" });
    } finally {
      if (!stopping) timer = setTimeout(() => { pending = tick(); }, intervalMs);
    }
  }
  pending = tick();
  return async () => { stopping = true; clearTimeout(timer); await pending; };
}
