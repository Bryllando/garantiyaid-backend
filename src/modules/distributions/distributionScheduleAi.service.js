import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { createMistralClient, MISTRAL_MODEL } from "../../lib/mistral.js";
import { distributionSlotCoversBeneficiary } from "./distributionSlot.service.js";

export const aiScheduleConfirmSchema = z.object({
  draftId: z.uuid(),
  confirmed: z.literal(true),
  assignments: z.array(z.object({ allocationId: z.uuid(), slotId: z.uuid() }).strict()).min(1).max(500),
}).strict();

const suggestionSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  assignments: z.array(z.object({
    groupId: z.string().regex(/^G\d+$/),
    slotId: z.string().regex(/^S\d+$/),
    count: z.number().int().min(1).max(500),
  }).strict()).min(1).max(500),
}).strict();

export function scheduleDraftSlots(slots, schedules, now = new Date()) {
  return slots.filter(slot => slot.slotStatus === "AVAILABLE" && slot.slotEnd > now).map(slot => ({
    ...slot,
    occupied: schedules.filter(schedule => schedule.slotId === slot.slotId && schedule.status !== "CANCELLED").length,
  })).filter(slot => slot.occupied < slot.capacity);
}

export function buildAiScheduleProblem(allocations, slots) {
  if (!allocations.length) throw new AppError(409, "NO_SCHEDULABLE_ALLOCATIONS", "Allocate approved beneficiaries first. Existing and cancelled appointments are reviewed separately.");
  // shortcut: one AI draft covers at most 500 beneficiaries and 100 slots; batch larger events when needed.
  if (allocations.length > 500 || slots.length > 100) throw new AppError(409, "AI_SCHEDULE_TOO_LARGE", "AI drafts support up to 500 unscheduled beneficiaries and 100 available slots per event. Use the existing assignment workflow for larger events.");
  if (slots.reduce((sum, slot) => sum + slot.capacity - slot.occupied, 0) < allocations.length) throw new AppError(409, "INSUFFICIENT_DISTRIBUTION_SLOT_CAPACITY", "Increase available time-slot capacity before generating an AI draft.");
  const groups = [];
  for (const allocation of allocations) {
    const eligibleSlotIds = slots.flatMap((slot, index) => distributionSlotCoversBeneficiary(slot, allocation.beneficiary) ? [`S${index + 1}`] : []);
    if (!eligibleSlotIds.length) throw new AppError(409, "INSUFFICIENT_DISTRIBUTION_SERVICE_AREA_CAPACITY", "An allocated beneficiary has no available slot covering their service area. Review sessions and capacity first.");
    let group = groups.find(row => row.eligibleSlotIds.join() === eligibleSlotIds.join());
    if (!group) { group = { id: `G${groups.length + 1}`, eligibleSlotIds, allocations: [] }; groups.push(group); }
    group.allocations.push(allocation);
  }
  return {
    groups, slots,
    input: {
      groups: groups.map(group => ({ id: group.id, count: group.allocations.length, eligibleSlotIds: group.eligibleSlotIds })),
      slots: slots.map((slot, index) => ({ id: `S${index + 1}`, chronologicalOrder: index + 1, capacity: slot.capacity, occupied: slot.occupied })),
    },
  };
}

export function validateDraftAssignments(assignments, allocations, slots) {
  if (assignments.length !== allocations.length || new Set(assignments.map(row => row.allocationId)).size !== allocations.length) throw new AppError(409, "AI_SCHEDULE_INVALID", "The draft must assign every unscheduled allocation exactly once.");
  const counts = new Map(slots.map(slot => [slot.slotId, slot.occupied]));
  for (const assignment of assignments) {
    const allocation = allocations.find(row => row.allocationId === assignment.allocationId);
    const slot = slots.find(row => row.slotId === assignment.slotId);
    if (!allocation || !slot || !distributionSlotCoversBeneficiary(slot, allocation.beneficiary)) throw new AppError(409, "AI_SCHEDULE_INVALID", "Every assignment must use an available slot covering that beneficiary's service area.");
    const count = counts.get(slot.slotId) + 1;
    if (count > slot.capacity) throw new AppError(409, "DISTRIBUTION_SLOT_CAPACITY_EXCEEDED", "The draft exceeds a slot's capacity. Choose another slot or increase capacity before regenerating.");
    counts.set(slot.slotId, count);
  }
  return slots.map(slot => ({ slotId: slot.slotId, occupied: slot.occupied, proposed: counts.get(slot.slotId) - slot.occupied, capacity: slot.capacity }));
}

export function expandAiSuggestion(problem, raw) {
  const parsed = suggestionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(502, "AI_SCHEDULE_INVALID_RESPONSE", "The AI returned an incomplete schedule. Generate a new draft; no appointments were saved.");
  const used = new Map();
  const assignments = [];
  for (const row of parsed.data.assignments) {
    const group = problem.groups.find(group => group.id === row.groupId);
    const index = Number(row.slotId.slice(1)) - 1;
    const slot = problem.slots[index];
    const offset = used.get(row.groupId) ?? 0;
    if (!group || !slot || !group.eligibleSlotIds.includes(row.slotId) || offset + row.count > group.allocations.length) throw new AppError(502, "AI_SCHEDULE_INVALID_RESPONSE", "The AI returned an invalid assignment. Generate a new draft; no appointments were saved.");
    assignments.push(...group.allocations.slice(offset, offset + row.count).map(allocation => ({ allocationId: allocation.allocationId, slotId: slot.slotId })));
    used.set(row.groupId, offset + row.count);
  }
  const allocations = problem.groups.flatMap(group => group.allocations);
  try { validateDraftAssignments(assignments, allocations, problem.slots); }
  catch { throw new AppError(502, "AI_SCHEDULE_INVALID_RESPONSE", "The AI suggestion failed capacity or coverage checks. Generate a new draft; no appointments were saved."); }
  return { summary: parsed.data.summary, assignments };
}

export async function suggestAiSchedule(problem, { client, apiKey = env.nvidiaApiKey } = {}) {
  if (!client && !apiKey) throw new AppError(503, "AI_SCHEDULER_NOT_CONFIGURED", "AI scheduling is unavailable. Configure NVIDIA_API_KEY on the server. Existing scheduling tools remain available.");
  const provider = client ?? createMistralClient({ apiKey });
  let result;
  try {
    result = await provider.chat.completions.create({
      model: MISTRAL_MODEL,
      temperature: 0,
      max_tokens: 8192,
      reasoning_effort: "high",
      tool_choice: { type: "function", function: { name: "propose_schedule" } },
      tools: [{ type: "function", function: { name: "propose_schedule", description: "Return a draft schedule for staff review. This does not save appointments.", parameters: {
        type: "object", additionalProperties: false, required: ["summary", "assignments"], properties: {
          summary: { type: "string" },
          assignments: { type: "array", items: { type: "object", additionalProperties: false, required: ["groupId", "slotId", "count"], properties: { groupId: { type: "string" }, slotId: { type: "string" }, count: { type: "integer" } } } },
        },
      } } }],
      messages: [
        { role: "system", content: "Propose a distribution appointment schedule from anonymous group counts and slots. Assign every member of every group exactly once, using only its eligibleSlotIds. Existing occupied places are fixed. Never exceed slot capacity including occupied places. Prefer lower peak occupancy ratios across available slots, then earlier slots when ratios are equal. Handle groups with fewer eligible slots first. Return aggregated group/slot counts, omit zero counts. Give a short explanation in English of your proposed distribution; do not claim a proven optimum, invent facts or give instructions. Call propose_schedule exactly once with the complete proposal. This is a proposal for staff review, not permission to save." },
        { role: "user", content: JSON.stringify(problem.input) },
      ],
    }, { signal: AbortSignal.timeout(90_000) });
  } catch (error) {
    const failure = {
      401: ["AI_SCHEDULER_CREDENTIALS_REJECTED", "NVIDIA rejected the server's API key. Ask the administrator to replace the NVIDIA key and restart the backend. No appointments were saved."],
      402: ["AI_SCHEDULER_CREDITS_REQUIRED", "The AI account or API key has insufficient credits. Ask the administrator to review its balance and spending limit. No appointments were saved."],
      403: ["AI_SCHEDULER_ACCESS_DENIED", "The AI service blocked this request. Ask the administrator to review the key's permissions and provider restrictions. No appointments were saved."],
      429: ["AI_SCHEDULER_RATE_LIMITED", "The AI service has reached its request limit. Wait before trying again, or use the existing assignment tools. No appointments were saved."],
    }[error.status];
    if (failure) throw new AppError(503, ...failure);
    throw new AppError(503, "AI_SCHEDULER_UNAVAILABLE", "The AI provider is unavailable or timed out. Try again, or use the existing assignment tools. No appointments were saved.");
  }
  const choice = result?.choices?.[0];
  let raw;
  try {
    const calls = choice?.message?.tool_calls;
    if (!["tool_calls", "stop"].includes(choice?.finish_reason) || calls?.length !== 1 || calls[0].type !== "function" || calls[0].function?.name !== "propose_schedule") throw new Error("Incomplete proposal");
    raw = JSON.parse(calls[0].function.arguments);
  } catch { throw new AppError(502, "AI_SCHEDULE_INVALID_RESPONSE", "The AI returned an incomplete draft. Try generating again; no appointments were saved."); }
  return { ...expandAiSuggestion(problem, raw), model: result.model || MISTRAL_MODEL };
}
