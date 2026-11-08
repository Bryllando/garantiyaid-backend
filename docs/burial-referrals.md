# Burial referral letters

This module prepares a referral for assessment by an external receiving office. It does not issue a Guarantee Letter, approve assistance, create a distribution claim, or record payment. The receiving office does not need an account in GARANTIYAID.

The proposed Cebu City scope still has no confirmed partner office, accepted form, checklist or authorized signatory. All printed letters identify GARANTIYAID as an academic prototype. Obtain the receiving office's agreement and confirm signing authority before official use. The application's DSWD role is the configured reviewer; it does not establish that a national DSWD office has jurisdiction over an LGU service.

## Staff steps

1. **Barangay: choose the living applicant.** Open **Beneficiary records**, search for the person requesting assistance, open their record, then choose **Prepare burial referral**. Do not register the deceased as the applicant. Only active applicants in the staff member's assigned barangay are available.
2. **Barangay: prepare the request.** Enter the deceased person's name, date of death, relationship, purpose, sending office, receiving office/address, and designated signatory. Add the documents for this request using **Existing applicant document** or **Upload and attach**. Each attachment has its own description on the letter. The receiving office sets the actual checklist; the examples are not an automatically complete checklist. Save the draft, then **Submit for review**.
3. **DSWD reviewer: check the case.** Open **Burial referrals**, choose the request and download/check its files. Accept submitted documents when appropriate. Return the referral with a specific correction note if the details or evidence need work. Barangay edits and resubmits that same case. All listed attachments must be accepted before **Prepare letter for signature**. Confirm the parties, documents, destination and signatory; this clears only the letter for signing.
4. **Staff: print the reviewed letter.** Choose **Preview letter**, then **Print / Save PDF**. The reviewed applicant details, deceased details, attachment list and letter reference are frozen together. Printing and reprinting do not change the referral's status. The browser's Save as PDF option downloads the letter; the files listed as attachments must be supplied separately.
5. **Designated officer: sign offline.** Obtain the authorized signature and hand the letter to the applicant or dispatch it to the receiving office. Barangay or DSWD staff then enter the signed-original/dispatch reference and confirm the actual handover using **Record signed issuance**. Retain the signed original or its office record under that reference. This does not confirm the receiving office received the letter. Later prints are marked **Issued record copy** and do not reproduce the signature.
6. **Barangay or DSWD: record the actual response.** Enter the receiving office's reported outcome, traceable document reference and details, then **Save response and close referral**. An external approval recorded here is not a payment or an approval in GARANTIYAID. Keep the referral issued while awaiting an actual response.

Admin can search, read and preview referrals for oversight, but cannot prepare, review, issue or close them. Existing permissions elsewhere are unchanged. Staff can reopen cases from **Burial referrals** and search by applicant or deceased name, filter status, and page through results.

## Recovery and record rules

- If a save has an uncertain result, stay on the screen and use **Retry last save**. It reuses the original request and key. Editing and other actions stay disabled until the result is resolved. If the tab/session is lost, inspect the list and exact case before creating another request; unsaved data is not retained across sign-out.
- If another staff member changed the case, refresh and review the latest step before acting. Concurrent issuance cannot create two issuance records or replace the winning staff member's evidence.
- Unissued letters can be returned for correction. A new review replaces the unissued snapshot; the correction reason and review hashes remain in the audit log. Issued letters cannot be edited through this flow. Escalate a correction to an already signed letter under the office's records procedure and retain the original reference.
- Each request selects exact documents belonging to the applicant. Rejected or superseded documents cannot be submitted, prepared or issued. Profile updates after preparation do not silently rewrite the reviewed letter.
- A living applicant can have separate requests concerning different deceased persons. Search existing cases first. The app does not determine cross-agency eligibility or whether financial assistance was already granted elsewhere.

## Implementation and local verification

The additive migration `20261105010000_burial_referrals` creates the referral table and status enum without changing existing beneficiary, enrollment or claim records. Deploy backend migrations and generated Prisma client before serving the frontend route `/burial-referrals`. The route uses authenticated `/api/v1/burial-referrals` endpoints and existing document upload/review/download controls. No new dependency or environment variable is required.

Run `node scripts/verify-integrated-workflow.js --burial` from the backend. It creates its own temporary PostgreSQL instance, applies repository migrations, runs actual API and Chrome journeys with synthetic records, and removes that instance afterwards. It covers permissions, barangay assignment changes, attachment ownership, corrections, optimistic concurrency, idempotent retries, immutable printing, response recording and responsive layouts. The synthetic signing/office responses are assertions of workflow behavior, not actual government acceptance.

Artifacts are in `../output/burial-referrals` relative to the backend: acceptance results, screenshots and sample A4 PDFs (standard, issued copy, and long content). Unit tests, frontend lint/build, schema validation and the security static check supplement the journey. Actual staff acceptance, physical printer output, authorized signatures and receiving-office submission remain untested.
