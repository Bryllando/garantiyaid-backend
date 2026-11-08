import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { TransactionPrismaPg } from "../src/lib/transactionPgAdapter.js";

function fixture(t) {
  const transactions = [];
  let active = 0, peak = 0, transactionActive = 0, transactionPeak = 0;
  const database = {
    provider: "postgres", adapterName: "test-pg",
    async queryRaw() { active++; peak = Math.max(peak, active); await setImmediate(); active--; return "pooled"; },
    async startTransaction(isolationLevel) {
      const state = { active: 0, peak: 0, calls: [], isolationLevel };
      const run = async function (value) {
        assert.equal(this, transaction, "Adapter methods keep their original receiver");
        state.active++; state.peak = Math.max(state.peak, state.active);
        transactionActive++; transactionPeak = Math.max(transactionPeak, transactionActive);
        state.calls.push(value);
        await setImmediate();
        state.active--;
        transactionActive--;
        if (value instanceof Error) throw value;
        return value;
      };
      const transaction = { provider: "postgres", options: { usePhantomQuery: false }, queryRaw: run, executeRaw: run,
        commit() { assert.equal(state.active, 0); state.calls.push("commit"); },
        rollback() { assert.equal(state.active, 0); state.calls.push("rollback"); },
      };
      transactions.push(state);
      return transaction;
    },
  };
  t.mock.method(PrismaPg.prototype, "connect", async () => database);
  return { adapter: new TransactionPrismaPg("postgresql://unused"), database, transactions, poolPeak: () => peak, transactionPeak: () => transactionPeak };
}

test("relation queries share a transaction queue and finish before releasing its connection", async t => {
  const state = fixture(t);
  const adapter = await state.adapter.connect();
  assert.equal(adapter, state.database);
  const tx = await adapter.startTransaction("Serializable");
  assert.deepEqual(tx.options, { usePhantomQuery: false });
  const results = await Promise.all([tx.queryRaw("relation-1"), tx.queryRaw("relation-2"), tx.executeRaw("update"), tx.commit()]);
  assert.deepEqual(results, ["relation-1", "relation-2", "update", undefined]);
  assert.equal(state.transactions[0].peak, 1);
  assert.equal(state.transactions[0].isolationLevel, "Serializable");
  assert.deepEqual(state.transactions[0].calls, ["relation-1", "relation-2", "update", "commit"]);
});

test("a query failure reaches the caller without blocking queued rollback or future transactions", async t => {
  const state = fixture(t), adapter = await state.adapter.connect();
  const tx = await adapter.startTransaction();
  const failure = Object.assign(new Error("constraint failure"), { code: "23505" });
  const results = await Promise.allSettled([tx.queryRaw(failure), tx.executeRaw("ROLLBACK"), tx.rollback()]);
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results.slice(1).map(result => result.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(state.transactions[0].calls, [failure, "ROLLBACK", "rollback"]);
  assert.equal(state.transactions[0].peak, 1);
  const next = await adapter.startTransaction();
  assert.equal(await next.queryRaw("next"), "next");
  await next.commit();
});

test("pooled queries and independent transactions keep their concurrency", async t => {
  const state = fixture(t), adapter = await state.adapter.connect();
  await Promise.all([adapter.queryRaw(), adapter.queryRaw(), adapter.queryRaw()]);
  assert.equal(state.poolPeak(), 3);
  const [first, second] = await Promise.all([adapter.startTransaction(), adapter.startTransaction()]);
  await Promise.all([first.queryRaw("first"), second.queryRaw("second")]);
  assert.equal(state.transactionPeak(), 2, "Separate transaction connections must not share one global queue");
  assert.deepEqual(state.transactions.map(tx => tx.calls), [["first"], ["second"]]);
  await Promise.all([first.commit(), second.commit()]);
});
