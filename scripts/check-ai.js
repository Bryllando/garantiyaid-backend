import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { AppError } from "../src/utils/AppError.js";
import { buildAiScheduleProblem, suggestAiSchedule } from "../src/modules/distributions/distributionScheduleAi.service.js";
import { generateExternalChatbotAnswer, generateStaffAssistantAnswer } from "../src/modules/chatbot/chatbot.ai.js";

// Live provider check with synthetic counts only; no database access or saved appointments.
try {
  if (!env.nvidiaApiKey) throw new AppError(503, "AI_SCHEDULER_NOT_CONFIGURED", "Set NVIDIA_API_KEY in the backend environment.");
  console.log("Checking NVIDIA Mistral Large 4 with synthetic data...");
  const problem = buildAiScheduleProblem(
    [1, 2].map(index => ({ allocationId: `demo-allocation-${index}`, beneficiary: { sitioPurok: null } })),
    [1, 2].map(index => ({ slotId: `demo-slot-${index}`, capacity: 1, occupied: 0, serviceAreas: [] })),
  );
  const draft = await suggestAiSchedule(problem);
  assert.equal(draft.assignments.length, 2);
  console.log(`PASS: ${draft.model} returned a validated draft for two synthetic beneficiaries.`);
  const reply = await generateExternalChatbotAnswer({ intent: "DOCUMENT_REQUIREMENTS", language: "en", approvedAnswer: "Bring only documents listed by authorized staff.", timeoutMs: 45_000 });
  if (!reply?.messageText) throw new AppError(503, "AI_CHATBOT_CHECK_FAILED", "NVIDIA did not finish a streaming chatbot reply. Check model availability and retry.");
  assert.equal(reply.model, draft.model);
  console.log("PASS: NVIDIA finished a streaming chatbot reply.");
  const staffReply = await generateStaffAssistantAnswer({ intent: "HELP", language: "ceb", staffRole: "BARANGAY_FACILITATOR", messageText: "Unsa nga part ang AI sa pagplano sa schedule?" });
  if (!staffReply.externalAiUsed) throw new AppError(503, "AI_STAFF_CHATBOT_CHECK_FAILED", "The staff chatbot returned fallback guidance instead of a completed NVIDIA reply.");
  assert.equal(staffReply.externalAiModel, draft.model);
  console.log("PASS: The staff chatbot used NVIDIA for a contextual Cebuano reply.");
  console.log("No appointments were saved. Restart the running backend after changing its environment.");
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : "AI check failed. Check network connectivity and retry.");
  process.exitCode = 1;
}
