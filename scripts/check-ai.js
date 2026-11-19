import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { AppError } from "../src/utils/AppError.js";
import { buildAiScheduleProblem, suggestAiSchedule } from "../src/modules/distributions/distributionScheduleAi.service.js";
import { generateExternalChatbotAnswer, generateStaffAssistantAnswer } from "../src/modules/chatbot/chatbot.ai.js";
import { explainReportFacts } from "../src/modules/reports/report.ai.js";

// Live provider check with synthetic counts only; no database access or saved appointments.
try {
  if (!env.mistralApiKey) throw new AppError(503, "MISTRAL_NOT_CONFIGURED", "Set MISTRAL_API_KEY in the backend environment.");
  console.log("Checking Mistral Large 4 with synthetic data...");
  const streamStartedAt = performance.now();
  let firstTextMs;
  const reply = await generateExternalChatbotAnswer({
    intent: "DOCUMENT_REQUIREMENTS",
    language: "en",
    approvedAnswer: "Bring only documents listed by authorized staff.",
    onText: text => { if (text) firstTextMs ??= Math.round(performance.now() - streamStartedAt); },
  });
  if (!reply?.messageText || firstTextMs === undefined) throw new AppError(503, "AI_CHATBOT_CHECK_FAILED", "Mistral did not finish a streaming chatbot reply within the interactive time limit.");
  console.log(`PASS: ${reply.model} streamed its first visible text in ${firstTextMs} ms and finished in ${Math.round(performance.now() - streamStartedAt)} ms.`);
  const staffReply = await generateStaffAssistantAnswer({ intent: "HELP", language: "ceb", staffRole: "SYSTEM_ADMIN", messageText: "Unsa ang AI ani ug unsay akong buhaton?" });
  if (!staffReply.externalAiUsed) throw new AppError(503, "AI_STAFF_CHATBOT_CHECK_FAILED", "The staff chatbot used fallback guidance. Mistral did not finish within the interactive time limit.");
  console.log(`PASS: ${staffReply.externalAiModel} finished a Cebuano staff reply.`);
  const report = await explainReportFacts([{ id: "verified", label: "Awaiting assistance", explanation: "7 sample claims await assistance." }]);
  assert.equal(report.highlights[0]?.id, "verified");
  console.log(`PASS: ${report.model} selected a validated report highlight.`);
  const problem = buildAiScheduleProblem(
    [1, 2].map(index => ({ allocationId: `demo-allocation-${index}`, beneficiary: { sitioPurok: null } })),
    [1, 2].map(index => ({ slotId: `demo-slot-${index}`, capacity: 1, occupied: 0, serviceAreas: [] })),
  );
  const draft = await suggestAiSchedule(problem);
  assert.equal(draft.assignments.length, 2);
  console.log(`PASS: ${draft.model} returned a validated draft for two synthetic beneficiaries.`);
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : "AI check failed. Check network connectivity and retry.");
  process.exitCode = 1;
}
