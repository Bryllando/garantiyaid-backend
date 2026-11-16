import { PrismaPg } from "@prisma/adapter-pg";

// shortcut: serialize transaction calls until prisma/orm#29407 is fixed upstream; remove once the adapter includes that fix.
export class TransactionPrismaPg extends PrismaPg {
  async connect() {
    const adapter = await super.connect();
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolationLevel) => {
      const transaction = await startTransaction(isolationLevel);
      let pending = Promise.resolve();
      for (const method of ["queryRaw", "executeRaw", "commit", "rollback"]) {
        const call = transaction[method].bind(transaction);
        transaction[method] = (...args) => {
          const result = pending.then(async () => {
            try { return await call(...args); }
            catch (error) {
              // Commit conflicts can bypass Prisma's usual serialization-error mapping.
              if (error?.cause?.kind === "TransactionWriteConflict") error.code = "P2034";
              throw error;
            }
          });
          pending = result.catch(() => {});
          return result;
        };
      }
      return transaction;
    };
    return adapter;
  }
}
