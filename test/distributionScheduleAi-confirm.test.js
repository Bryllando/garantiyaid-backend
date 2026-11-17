import test from 'node:test';
import assert from 'node:assert/strict';
import { Completions } from 'openai/resources/chat/completions';
import { env } from '../src/config/env.js';

let state;
let serial = Promise.resolve();
const recordKey = identity => `${identity.userId}:${identity.operation}:${identity.idempotencyKey}`;
const database = {
  distribution: { findFirst: async ({ where }) => where.barangayId && where.barangayId !== 'area-1' ? null : state.distribution },
  distributionAllocation: { findMany: async () => state.allocations.filter(allocation => !state.schedules.some(schedule => schedule.beneficiaryId === allocation.beneficiaryId)) },
  distributionSlot: { findMany: async () => state.slots, updateMany: async ({ where, data }) => { Object.assign(state.slots.find(slot => slot.slotId === where.slotId), data); return { count: 1 }; } },
  schedule: { findMany: async () => state.schedules, createMany: async ({ data }) => { state.schedules.push(...data); } },
  auditLog: { createMany: async ({ data }) => state.audits.push(...data) },
  idempotencyRecord: {
    findUnique: async ({ where }) => state.records[recordKey(where.userId_operation_idempotencyKey)] ?? null,
    create: async ({ data }) => { state.records[recordKey(data)] = structuredClone(data); },
    deleteMany: async () => {},
  },
  $transaction(operation, options) {
    assert.ok(['Serializable', 'RepeatableRead'].includes(options.isolationLevel));
    const pending = serial.then(async () => {
      const before = structuredClone(state);
      try { return await operation(database); }
      catch (error) { state = before; throw error; }
    });
    serial = pending.catch(() => {});
    return pending;
  },
};
globalThis.prisma = database;
const { previewAiDistributionSchedule, confirmAiDistributionSchedule, scheduleDraftContext } = await import('../src/modules/distributions/distributionScheduleAi.controller.js');
const { prepareAssistantApproval } = await import('../src/utils/assistantApproval.js');
const { default: routes } = await import('../src/modules/distributions/distribution.routes.js');
const distributionId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const staff = { userId: 'staff-a', role: 'BARANGAY_FACILITATOR', barangayId: 'area-1' };
const assignments = [{ allocationId: 'allocation-1', slotId: 'slot-1' }, { allocationId: 'allocation-2', slotId: 'slot-2' }];
async function fixture() {
  state = {
    distribution: { distributionId, status: 'DRAFT', barangayId: 'area-1' }, records: {}, schedules: [], audits: [],
    allocations: [1, 2].map(index => ({ allocationId: `allocation-${index}`, beneficiaryId: `person-${index}`, beneficiary: { firstName: 'Private person', status: 'ACTIVE', sitioPurok: null } })),
    slots: [1, 2].map(index => ({ slotId: `slot-${index}`, distributionId, slotStatus: 'AVAILABLE', capacity: 1, serviceAreas: [], slotStart: new Date(`2099-01-01T0${index}:00:00Z`), slotEnd: new Date(`2099-01-01T0${index + 1}:00:00Z`) })),
  };
  const context = await scheduleDraftContext(database, distributionId, staff);
  const draft = await prepareAssistantApproval(staff.userId, `AI_SCHEDULE_DRAFT:${distributionId}`, { distributionId, sourceHash: context.sourceHash }, { sourceHash: context.sourceHash, assignments, model: 'synthetic-ai-model' }, database);
  return { staffUser: staff, auth: staff, validatedParams: { distributionId }, validatedBody: { draftId: draft.approvalId, assignments, confirmed: true }, get: () => key, ip: '127.0.0.1' };
}
const invoke = req => new Promise((resolve, reject) => confirmAiDistributionSchedule(req, { set() {}, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, ...body }); } }, reject));

test('preview calls the model with anonymous input and returns an editable draft without writing schedules', async t => {
  const req = await fixture();
  const previousKey = env.nvidiaApiKey;
  env.nvidiaApiKey = 'synthetic-test-key';
  t.after(() => { env.nvidiaApiKey = previousKey; });
  t.mock.method(Completions.prototype, 'create', async function (body) {
    assert.equal(this._client.baseURL, 'https://integrate.api.nvidia.com/v1');
    assert.equal(this._client.apiKey, env.nvidiaApiKey);
    assert.equal(body.model, 'mistralai/mistral-large-4-1t-a52b');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.reasoning, undefined);
    assert.equal(JSON.stringify(body.messages).includes('Private person'), false);
    assert.equal(JSON.stringify(body.messages).includes('area-1'), false);
    return { model: 'test-model', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'propose_schedule', arguments: JSON.stringify({ summary: 'Spread the appointments across the two eligible slots.', assignments: [{ groupId: 'G1', slotId: 'S1', count: 1 }, { groupId: 'G1', slotId: 'S2', count: 1 }] }) } }] } }] };
  });
  const result = await new Promise((resolve, reject) => previewAiDistributionSchedule({ ...req, validatedBody: {} }, { status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, ...body }); } }, reject));
  assert.equal(result.status, 200);
  assert.equal(result.data.allocations.length, 2);
  assert.deepEqual(result.data.allocations[0].eligibleSlotIds, ['slot-1', 'slot-2']);
  assert.equal(result.data.slots[0].occupied, 0);
  assert.equal(state.schedules.length, 0);
  req.validatedBody.draftId = result.data.draftId;
  req.validatedBody.assignments = result.data.assignments;
  assert.equal((await invoke(req)).data.generatedScheduleCount, 2);
});

test('only Admin and Barangay can request and confirm AI drafts', () => {
  for (const path of ['/:distributionId/schedules/ai-draft', '/:distributionId/schedules/ai-confirm']) {
    const route = routes.stack.find(layer => layer.route?.path === path).route;
    for (const role of ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR', 'DSWD_STAFF', 'BENEFICIARY']) {
      let error;
      route.stack[0].handle({ auth: { role } }, {}, result => { error = result; });
      assert.equal(error?.statusCode, ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR'].includes(role) ? undefined : 403);
    }
  }
});

test('draft metadata alone saves no appointments; repeated confirmations save once with provenance', async () => {
  const req = await fixture();
  assert.equal(state.schedules.length, 0);
  const [first, replay] = await Promise.all([invoke(req), invoke(req)]);
  assert.deepEqual(first, replay);
  assert.equal(first.status, 201);
  assert.equal(state.schedules.length, 2);
  assert.equal(state.audits.length, 2);
  assert.equal(state.audits[0].details.model, 'synthetic-ai-model');
  assert.equal(state.audits[0].details.assignmentSource, 'AI_SUGGESTED');
  assert.equal(state.distribution.status, 'DRAFT');
  assert.equal(state.slots.every(slot => slot.slotStatus === 'FULL'), true);
  state.distribution.status = 'OPEN';
  assert.deepEqual(await invoke(req), first, 'A lost result can still be recovered after the event is opened');
  await assert.rejects(invoke({ ...req, validatedBody: { ...req.validatedBody, assignments: [...assignments].reverse() } }), { code: 'IDEMPOTENCY_KEY_REUSED' });
});

test('staff can edit a proposal before confirmation, with separate audit attribution', async () => {
  const req = await fixture();
  req.validatedBody.assignments = [{ allocationId: 'allocation-1', slotId: 'slot-2' }, { allocationId: 'allocation-2', slotId: 'slot-1' }];
  await invoke(req);
  assert.equal(state.schedules.every(row => row.assignedByAi === false), true);
  assert.equal(state.audits.every(row => row.details.assignmentSource === 'STAFF_EDITED_AI_DRAFT'), true);
});

test('confirmation rejects another actor/barangay, missing consent, expiration and changed event data', async () => {
  let req = await fixture();
  await assert.rejects(invoke({ ...req, validatedBody: { ...req.validatedBody, confirmed: false } }), { code: 'AI_SCHEDULE_CONFIRMATION_REQUIRED' });
  await assert.rejects(invoke({ ...req, staffUser: { ...staff, role: 'DSWD_STAFF' } }), { statusCode: 403 });
  await assert.rejects(invoke({ ...req, staffUser: { ...staff, barangayId: 'area-2' } }), { statusCode: 404 });
  await assert.rejects(invoke({ ...req, auth: { userId: 'different-actor' } }), { code: 'AI_SCHEDULE_DRAFT_EXPIRED' });
  Object.values(state.records)[0].responseBody.approvalExpiresAt = '2000-01-01';
  await assert.rejects(invoke(req), { code: 'AI_SCHEDULE_DRAFT_EXPIRED' });
  for (const change of [() => { state.slots[0].capacity++; }, () => { state.allocations.pop(); }, () => { state.slots[0].slotEnd = new Date('2000-01-01'); }]) {
    req = await fixture(); change();
    await assert.rejects(invoke(req), { code: 'AI_SCHEDULE_DRAFT_STALE' });
    assert.equal(state.schedules.length, 0);
  }
  req = await fixture(); state.distribution.status = 'OPEN';
  await assert.rejects(invoke(req), { code: 'DISTRIBUTION_SCHEDULES_NOT_EDITABLE' });
});

test('invalid edits and audit failures roll back the entire draft save', async t => {
  let req = await fixture();
  req.validatedBody.assignments = [{ allocationId: 'allocation-1', slotId: 'slot-1' }, { allocationId: 'allocation-2', slotId: 'slot-1' }];
  await assert.rejects(invoke(req), { code: 'DISTRIBUTION_SLOT_CAPACITY_EXCEEDED' });
  assert.equal(state.schedules.length, 0);
  req = await fixture();
  t.mock.method(database.auditLog, 'createMany', async () => { throw new Error('Audit unavailable'); });
  await assert.rejects(invoke(req), /Audit unavailable/);
  assert.equal(state.schedules.length, 0);
  assert.equal(state.slots.every(slot => slot.slotStatus === 'AVAILABLE'), true);
});
