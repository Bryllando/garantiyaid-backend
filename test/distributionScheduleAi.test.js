import test from 'node:test';
import assert from 'node:assert/strict';
import { aiScheduleConfirmSchema, buildAiScheduleProblem, expandAiSuggestion, scheduleDraftSlots, suggestAiSchedule, validateDraftAssignments } from '../src/modules/distributions/distributionScheduleAi.service.js';

const allocations = [
  { allocationId: 'a', beneficiary: { firstName: 'PRIVATE PERSON', phone: 'PRIVATE PHONE', sitioPurok: 'Riverside' } },
  { allocationId: 'b', beneficiary: { firstName: 'PRIVATE PERSON 2', sitioPurok: 'Hills' } },
];
const slots = [
  { slotId: 's1', serviceAreas: ['Riverside'], capacity: 3, occupied: 2 },
  { slotId: 's2', serviceAreas: [], capacity: 2, occupied: 0 },
];
const suggestion = { summary: 'Keep the restricted group in its covered session and distribute the remaining load.', assignments: [{ groupId: 'G1', slotId: 'S1', count: 1 }, { groupId: 'G2', slotId: 'S2', count: 1 }] };
const client = response => ({ chat: { completions: { create: async () => response } } });
const proposalResponse = (proposal = suggestion) => ({ model: 'test-model', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'propose_schedule', arguments: JSON.stringify(proposal) } }] } }] });

test('AI receives anonymous counts, eligible slot references and capacity, never personal fields', async () => {
  const problem = buildAiScheduleProblem(allocations, slots);
  assert.deepEqual(problem.input.groups, [{ id: 'G1', count: 1, eligibleSlotIds: ['S1', 'S2'] }, { id: 'G2', count: 1, eligibleSlotIds: ['S2'] }]);
  let sent;
  const provider = { chat: { completions: { create: async body => {
    sent = body;
    return proposalResponse();
  } } } };
  const result = await suggestAiSchedule(problem, { client: provider });
  assert.equal(result.model, 'test-model');
  assert.deepEqual(result.assignments, [{ allocationId: 'a', slotId: 's1' }, { allocationId: 'b', slotId: 's2' }]);
  assert.equal(sent.response_format, undefined);
  assert.deepEqual(sent.tool_choice, { type: 'function', function: { name: 'propose_schedule' } });
  assert.equal(sent.tools[0].function.parameters.additionalProperties, false);
  const input = JSON.stringify(sent.messages);
  for (const secret of ['PRIVATE', 'Riverside', 'Hills', 'beneficiaryId', 'phone']) assert.equal(input.includes(secret), false);
});

test('AI output must be complete, feasible and use only real group/slot references', () => {
  const problem = buildAiScheduleProblem(allocations, slots);
  for (const assignments of [
    [{ groupId: 'G1', slotId: 'S1', count: 1 }],
    [{ groupId: 'G99', slotId: 'S1', count: 1 }],
    [{ groupId: 'G1', slotId: 'S99', count: 1 }],
    [{ groupId: 'G2', slotId: 'S1', count: 1 }],
    [{ groupId: 'G1', slotId: 'S1', count: 2 }],
  ]) assert.throws(() => expandAiSuggestion(problem, { summary: 'Test', assignments }), error => error.code === 'AI_SCHEDULE_INVALID_RESPONSE');
  const sameGroup = buildAiScheduleProblem([allocations[0], { ...allocations[0], allocationId: 'c' }], slots);
  assert.throws(() => expandAiSuggestion(sameGroup, { summary: 'Overflow', assignments: [{ groupId: 'G1', slotId: 'S1', count: 2 }] }), error => error.code === 'AI_SCHEDULE_INVALID_RESPONSE');
  assert.throws(() => expandAiSuggestion(problem, { ...suggestion, command: 'save immediately' }), error => error.code === 'AI_SCHEDULE_INVALID_RESPONSE');
});

test('staff edits require complete unique allocations, service coverage and remaining capacity', () => {
  const valid = [{ allocationId: 'a', slotId: 's2' }, { allocationId: 'b', slotId: 's2' }];
  assert.equal(validateDraftAssignments(valid, allocations, slots)[1].proposed, 2);
  for (const assignments of [valid.slice(0, 1), [valid[0], valid[0]], [{ ...valid[0], allocationId: 'forged' }, valid[1]], [valid[0], { ...valid[1], slotId: 's1' }]]) assert.throws(() => validateDraftAssignments(assignments, allocations, slots));
  assert.throws(() => validateDraftAssignments(valid, allocations, [{ ...slots[1], capacity: 1 }]), error => error.code === 'DISTRIBUTION_SLOT_CAPACITY_EXCEEDED');
});

test('ended, closed and full slots are excluded; cancelled visits do not consume capacity', () => {
  const now = new Date('2099-01-01');
  const candidate = { ...slots[0], slotStatus: 'AVAILABLE', slotEnd: new Date('2099-02-01') };
  assert.equal(scheduleDraftSlots([candidate], [{ slotId: 's1', status: 'CANCELLED' }], now)[0].occupied, 0);
  assert.deepEqual(scheduleDraftSlots([{ ...candidate, slotEnd: now }, { ...candidate, slotStatus: 'CLOSED' }, { ...candidate, slotStatus: 'FULL' }], [], now), []);
  assert.throws(() => buildAiScheduleProblem([], slots), error => error.code === 'NO_SCHEDULABLE_ALLOCATIONS');
  assert.throws(() => buildAiScheduleProblem(allocations, []), error => error.code === 'INSUFFICIENT_DISTRIBUTION_SLOT_CAPACITY');
  assert.throws(() => buildAiScheduleProblem(allocations, Array(101).fill(slots[0])), error => error.code === 'AI_SCHEDULE_TOO_LARGE');
});

test('provider failures, incomplete JSON and missing credentials never become fallback AI suggestions', async () => {
  const problem = buildAiScheduleProblem(allocations, slots);
  await assert.rejects(suggestAiSchedule(problem, { apiKey: '' }), { code: 'AI_SCHEDULER_NOT_CONFIGURED' });
  for (const result of [{ choices: [] }, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] }]) await assert.rejects(suggestAiSchedule(problem, { client: client(result) }), { code: 'AI_SCHEDULE_INVALID_RESPONSE' });
  for (const [status, code] of [[401, 'AI_SCHEDULER_CREDENTIALS_REJECTED'], [402, 'AI_SCHEDULER_CREDITS_REQUIRED'], [403, 'AI_SCHEDULER_ACCESS_DENIED'], [429, 'AI_SCHEDULER_RATE_LIMITED'], [503, 'AI_SCHEDULER_UNAVAILABLE']]) {
    await assert.rejects(suggestAiSchedule(problem, { client: { chat: { completions: { create: async () => { throw { status, message: 'PRIVATE PROVIDER DETAILS' }; } } } } }), error => error.code === code && !error.message.includes('PRIVATE'));
  }
  assert.equal(aiScheduleConfirmSchema.safeParse({ draftId: 'not-a-uuid', confirmed: false, assignments: [] }).success, false);
});

test('tool proposals reject truncated, malformed, unsolicited and multiple calls before creating a draft', async () => {
  const problem = buildAiScheduleProblem(allocations, slots);
  for (const change of [
    result => { result.choices[0].finish_reason = 'length'; },
    result => { result.choices[0].message.tool_calls[0].function.arguments = 'not JSON'; },
    result => { result.choices[0].message.tool_calls[0].function.name = 'save_schedule'; },
    result => { result.choices[0].message.tool_calls.push(result.choices[0].message.tool_calls[0]); },
    result => { result.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ ...suggestion, assignments: suggestion.assignments.slice(0, 1) }); },
  ]) {
    const result = proposalResponse();
    change(result);
    await assert.rejects(suggestAiSchedule(problem, { client: client(result) }), { code: 'AI_SCHEDULE_INVALID_RESPONSE' });
  }
});
