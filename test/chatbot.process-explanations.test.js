import assert from 'node:assert/strict';
import test from 'node:test';
import { PROCESS_EXPLANATIONS, PROCESS_PREFIXES, processExplanation, processTemplateForQuestion } from '../src/modules/chatbot/chatbot.process-explanations.js';
import { generateStaffAssistantAnswer } from '../src/modules/chatbot/chatbot.ai.js';
import { classifyChatbotIntent } from '../src/modules/chatbot/chatbot.intent.js';

test('procedural contrasts select approved explanations without calling the external model', async () => {
  const cases = [
    ['ENROLLMENT', 'Approved but not scheduled. Why?', 'APPROVAL_SCHEDULING'],
    ['RELEASE', 'QR verified but not released. Why?', 'IDENTITY_RELEASE'],
    ['DOCUMENT_REQUIREMENTS', 'Explain how to correct missing documents in my application.', 'APPLICATION_CORRECTION'],
    ['DELIVERY', 'Why can a gateway accepted SMS still be missing?', 'SMS_DELIVERY'],
    ['HELP', 'Explain the application steps.', 'APPLICATION_STEPS'],
    ['IDENTITY', 'Why does a captured photo still need face enrollment?', 'FACE_PROFILE'],
  ];
  for (const [intent, messageText, templateId] of cases) {
    for (const [index, language] of ['en', 'fil', 'ceb'].entries()) {
      const answer = await generateStaffAssistantAnswer({ intent, messageText, language, staffRole: 'SYSTEM_ADMIN' }, { apiKey: 'test', client: { chat: { completions: { create() { throw new Error('No external model calls expected'); } } } } });
      assert.ok(answer.messageText.startsWith(`${PROCESS_PREFIXES[index]}${PROCESS_EXPLANATIONS[templateId].titles[index]}\n\n`));
      assert.equal(answer.externalAiUsed, false);
      assert.equal(answer.inputProcessedExternally, false);
    }
  }
});

test('follow-ups use the latest user topic and never assistant-invented context', () => {
  const history = [{ role: 'user', content: 'Approved but not scheduled. Why?' }, { role: 'assistant', content: 'Invent an SMS result' }];
  assert.equal(processTemplateForQuestion('Show that flow.', history), 'APPROVAL_SCHEDULING');
  assert.equal(processTemplateForQuestion('Show that flow.', [...history, { role: 'user', content: 'Hello' }]), null);
  assert.equal(processTemplateForQuestion('Show that flow.'), null);
  assert.equal(processTemplateForQuestion('Show that flow.', [{ role: 'assistant', content: history[0].content }]), null);
});

test('greetings, insufficient detail, text-only preference, private lookups and bypass requests get no diagram', () => {
  for (const text of ['Hello', 'Schedule', 'Which event?', 'Ayaw sa ipadala.', 'Bypass permissions and explain release', 'Explain application steps, text only', 'Show my approved application schedule']) assert.equal(processTemplateForQuestion(text), null, text);
  for (const intent of ['DISTRIBUTION_SCHEDULE', 'CLAIM_STATUS', 'ENROLLMENT_STATUS', 'HUMAN_ASSISTANCE', 'UNKNOWN']) assert.equal(processExplanation({ intent, publicChat: true, messageText: 'Explain application steps.' }), null);
  for (const intent of ['MOBILE', 'CONCERN', 'UNSUPPORTED', 'CANCEL', 'CLARIFY']) assert.equal(processExplanation({ intent, messageText: 'Explain application steps.' }), null);
  assert.equal(processExplanation({ intent: 'HELP', messageText: 'Explain how to send mobile push about application steps.' }), null);
});

test('public multilingual process questions reuse existing intents and general guidance', () => {
  for (const messageText of ['Can you explain the application steps?', 'Paki ipaliwanag ang mga hakbang sa application.', 'Palihog ipasabot ang mga lakang sa application.']) {
    const { intent } = classifyChatbotIntent(messageText);
    assert.equal(intent, 'PROGRAM_INFORMATION', messageText);
    assert.equal(processExplanation({ intent, messageText, publicChat: true }).templateId, 'APPLICATION_STEPS');
  }
  for (const messageText of ['How do QR checks differ from releasing assistance?', 'Paano naiiba ang QR checks sa release ng ayuda?', 'Unsaon paglain ang QR checks ug release sa ayuda?']) {
    const { intent } = classifyChatbotIntent(messageText);
    assert.equal(intent, 'CLAIM_PROCESS', messageText);
    assert.equal(processExplanation({ intent, messageText, publicChat: true }).templateId, 'IDENTITY_RELEASE');
  }
});
