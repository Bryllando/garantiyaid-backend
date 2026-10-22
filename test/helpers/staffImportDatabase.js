import assert from "node:assert/strict";

// Protocol/rollback test double; PostgreSQL provides actual serializable isolation.
export function staffImportDatabase() {
  let state = { users: [], barangays: [], approvals: {}, audits: [], notifications: [], jobs: [], batches: [], sequence: 0 };
  let tail = Promise.resolve();
  const key = identity => `${identity.userId}:${identity.operation}:${identity.idempotencyKey}`;
  const matches = (row, where) => Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return condition.some(item => matches(row, item));
    if (condition && typeof condition === "object") {
      if (condition.in) return condition.in.includes(row[field]);
      if (condition.gt) return new Date(row[field]) > new Date(condition.gt);
      if (condition.lt) return row[field] != null && new Date(row[field]) < new Date(condition.lt);
      if (condition.lte) return row[field] != null && new Date(row[field]) <= new Date(condition.lte);
    }
    return row[field] === condition;
  });
  const apply = (row, data) => {
    for (const [field, value] of Object.entries(data)) row[field] = value?.increment === undefined ? value : row[field] + value.increment;
    row.updatedAt = new Date();
    return structuredClone(row);
  };
  const db = {
    get state() { return state; },
    user: {
      findUnique: async ({ where }) => structuredClone(state.users.find(user => user.userId === where.userId) ?? null),
      findMany: async ({ where }) => state.users.filter(user => where.OR.some(condition => Object.entries(condition).some(([field, query]) => query.in.some(value => value.toLowerCase() === user[field]?.toLowerCase())))),
      findFirst: async ({ where }) => state.users.find(user => where.OR.some(condition => Object.entries(condition).some(([field, query]) => query.equals.toLowerCase() === user[field]?.toLowerCase()))) ?? null,
      create: async ({ data }) => {
        if (state.users.some(user => user.email === data.email)) throw Object.assign(new Error("Duplicate email"), { code: "P2002" });
        const user = { userId: `user-${state.users.length + 1}`, isActive: true, mustChangePassword: true, ...data };
        state.users.push(user);
        const { passwordHash, ...selected } = user;
        return selected;
      },
    },
    barangay: { findMany: async ({ where }) => state.barangays.filter(barangay => where.barangayId.in.includes(barangay.barangayId) && barangay.isActive) },
    idempotencyRecord: {
      create: async ({ data }) => { state.approvals[key(data)] = structuredClone(data); return data; },
      findUnique: async ({ where }) => structuredClone(state.approvals[key(where.userId_operation_idempotencyKey)] ?? null),
      update: async ({ where, data }) => Object.assign(state.approvals[key(where.userId_operation_idempotencyKey)], structuredClone(data)),
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data; } },
    staffImportJob: {
      findUnique: async ({ where }) => structuredClone(state.jobs.find(job => job.importId === where.importId) ?? null),
      findFirst: async ({ where }) => structuredClone(state.jobs.find(job => matches(job, where)) ?? null),
      findMany: async ({ where, select, take = 20 }) => state.jobs.filter(job => matches(job, where)).slice(0, take).map(job => structuredClone(select ? Object.fromEntries(Object.keys(select).map(key => [key, job[key]])) : job)),
      create: async ({ data }) => {
        if (state.jobs.some(job => job.importId === data.importId)) throw Object.assign(new Error('Duplicate job'), { code: 'P2002' });
        const job = { status: 'QUEUED', processedCount: 0, createdCount: 0, failedCount: 0, processingToken: null, leaseUntil: null, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        state.jobs.push(job); return structuredClone(job);
      },
      update: async ({ where, data }) => apply(state.jobs.find(job => job.importId === where.importId), data),
      updateMany: async ({ where, data }) => { const jobs = state.jobs.filter(job => matches(job, where)); jobs.forEach(job => apply(job, data)); return { count: jobs.length }; },
      deleteMany: async ({ where }) => { const jobs = state.jobs.filter(job => matches(job, where)); state.jobs = state.jobs.filter(job => !jobs.includes(job)); state.batches = state.batches.filter(batch => state.jobs.some(job => job.importId === batch.importId)); return { count: jobs.length }; },
    },
    staffImportBatch: {
      create: async ({ data }) => {
        if (state.batches.some(batch => batch.importId === data.importId && batch.batchIndex === data.batchIndex)) throw Object.assign(new Error('Duplicate batch'), { code: 'P2002' });
        state.batches.push(structuredClone(data)); return data;
      },
      findMany: async ({ where }) => structuredClone(state.batches.filter(batch => batch.importId === where.importId).sort((a, b) => a.batchIndex - b.batchIndex)),
    },
    staffNotification: {
      create: async ({ data }) => { const row = { ...data, notificationId: `notice-${state.notifications.length + 1}` }; state.notifications.push(row); return row; },
      upsert: async ({ create }) => db.staffNotification.create({ data: create }),
      findUnique: async () => null,
    },
    $queryRaw: async () => [{ value: BigInt(++state.sequence) }],
    $transaction(callback, options) {
      assert.equal(options.isolationLevel, "Serializable");
      const pending = tail.then(async () => {
        const before = structuredClone(state);
        try { return await callback(db); } catch (error) { state = before; throw error; }
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
  return db;
}
