# AI schedule drafts

Admin: **Distributions > Distribution events > select a draft > Schedule > Generate AI draft**.

Admin or assigned Barangay: **Queue & schedules > select a draft > Generate AI draft**.

Generate service sessions and allocate approved beneficiaries first. The AI proposes assignments only for allocations that have never had an appointment in this event. Staff review the explanation and slot loads, edit proposed slots, check the review checkbox, and choose **Confirm and save draft schedule**. The event remains DRAFT. Existing appointments, cancellations, event opening, and notifications keep their separate workflows.

## AI behavior

The backend calls NVIDIA's OpenAI-compatible API with `mistralai/mistral-large-4-1t-a52b`. Set `NVIDIA_API_KEY` in the backend environment and restart the backend. Run `npm run ai:check` to test chat streaming, report highlights, and schedule drafts using synthetic records.

The model receives anonymous group counts, eligible slot references, capacity and existing occupancy. Names, contact information, identifiers, locations, service-area names and exact dates are excluded. The server groups allocations with identical eligible slots and expands validated aggregate proposals into local beneficiary records.

The objective is to spread occupancy across eligible slots, preferring earlier slots on ties. A language-model suggestion does not guarantee a mathematical optimum. Invalid, incomplete, overflowing, unavailable or out-of-area output is rejected. Provider errors are shown as errors; automatic assignment is never presented as a successful AI response.

## Endpoints and safeguards

- `POST /api/v1/distributions/:distributionId/schedules/ai-draft` with `{}` prepares a 15-minute review draft. It creates approval metadata, not appointments. The existing chatbot rate limit applies.
- `POST /api/v1/distributions/:distributionId/schedules/ai-confirm` with `{draftId, assignments: [{allocationId, slotId}], confirmed: true}` and an `Idempotency-Key` UUID saves the reviewed assignments atomically.

Both endpoints require Admin or Barangay role; Barangay access is restricted to the assigned barangay. A source hash binds the draft to the event, unscheduled allocations, slot configuration and existing schedules. Confirmation reloads and checks all records inside a serializable transaction. Changed data, expired drafts, duplicate/missing allocations, invalid coverage or capacity, and non-draft events are rejected before any appointment is saved.

An uncertain save can be retried with the same request and key to recover its result. A changed request cannot reuse the key. Appointments, full-slot updates, audit provenance and the replay result commit together. Audit records distinguish unchanged AI suggestions from staff edits. No schema migration or additional dependency is needed.

One draft supports up to 500 unscheduled beneficiaries and 100 available slots. Larger events continue to use the existing assignment tools.

The chatbot explains and links to this workflow. Direct conversational execution of schedule generation is not implemented.

## Verification

Run `node --import ./scripts/test-environment.js --test test/distributionScheduleAi.test.js test/distributionScheduleAi-confirm.test.js` in the backend, and `node scripts/verify-ai-schedule-ui.mjs` in the frontend. These checks use synthetic provider/API responses, never live beneficiaries. Live provider verification must use synthetic anonymous counts and a valid server key.
