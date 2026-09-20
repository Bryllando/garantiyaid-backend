import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { env } from "../src/config/env.js";
import beneficiaryRoutes from "../src/modules/beneficiaries/beneficiary.routes.js";
import biometricDuplicateRoutes from "../src/modules/biometrics/biometricDuplicate.routes.js";
import distributionRoutes from "../src/modules/distributions/distribution.routes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  BIOMETRIC_ATTEMPT_RESULTS,
  biometricAttemptListQuerySchema,
  biometricEnrollmentSchema,
  biometricDuplicateCaseListQuerySchema,
  reviewBiometricDuplicateCaseSchema,
  claimSignatureParamsSchema,
  submitClaimSignatureSchema,
  verifyBiometricClaimSchema,
} from "../src/modules/biometrics/biometric.schemas.js";
import {
  BIOMETRIC_CONSENT_MANAGE_ROLES,
  BIOMETRIC_DELETE_ROLES,
  BIOMETRIC_DUPLICATE_REVIEW_ROLES,
  BIOMETRIC_ENROLL_ROLES,
  BIOMETRIC_READ_ROLES,
  BIOMETRIC_VERIFY_ROLES,
  assertBiometricDeleteAllowed,
  assertBiometricDuplicateReviewAllowed,
  assertBiometricEnrollAllowed,
  assertIndependentBiometricDuplicateReviewer,
  assertBiometricVerifyAllowed,
} from "../src/modules/biometrics/biometric.policy.js";
import {
  assertValidBiometricCapture,
  acquireBiometricEnrollmentLock,
  biometricAttemptPublicSelect,
  biometricProfileInternalSelect,
  biometricProfileStatus,
  biometricProfileToResponse,
  consentEffectiveStatus,
  duplicateScanWhere,
  decryptBiometricTemplate,
  encryptBiometricTemplate,
  findBiometricDuplicateMatch,
  normalizeBiometricEmbedding,
  parseDeepFaceRepresentation,
  processBiometricEnrollment,
  processBiometricVerification,
} from "../src/modules/biometrics/biometric.service.js";
import {
  decryptSignatureImage,
  encryptSignatureImage,
  parseSignatureDataUrl,
  signatureImageHash,
} from "../src/modules/biometrics/claimSignature.service.js";
import {
  ACCEPTED_BIOMETRIC_FILE_EXTENSIONS,
  ACCEPTED_BIOMETRIC_MIME_TYPES,
  MAX_BIOMETRIC_CAPTURE_BYTES,
  uploadBiometricCapture,
} from "../src/modules/biometrics/biometric.upload.js";
import {
  VERIFICATION_REQUIREMENTS,
  createDistributionSchema,
} from "../src/modules/distributions/distribution.schemas.js";
import { assertQrVerificationConfigured } from "../src/modules/distributions/distributionClaim.service.js";

const beneficiaryId = "11111111-1111-4111-8111-111111111111";
const consentId = "22222222-2222-4222-8222-222222222222";

function routeSurface(router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
}

function pngCapture(seed, lowEntropy = false) {
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (lowEntropy) return { buffer: Buffer.concat([header, Buffer.alloc(2048, 65)]), mimetype: "image/png" };
  const chunks = [header];
  for (let index = 0; index < 40; index += 1) {
    chunks.push(createHash("sha512").update(`${seed}:${index}`).digest());
  }
  return { buffer: Buffer.concat(chunks), mimetype: "image/png" };
}

function jpegCapture(seed) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const chunks = [header];
  for (let index = 0; index < 40; index += 1) {
    chunks.push(createHash("sha512").update(`${seed}:${index}`).digest());
  }
  return { buffer: Buffer.concat(chunks), mimetype: "image/jpeg" };
}

test("Phase 7 schemas control verification policies, multipart fields, filters, and result values", () => {
  assert.deepEqual(VERIFICATION_REQUIREMENTS, ["QR", "BIOMETRIC", "QR_AND_BIOMETRIC", "BIOMETRIC_AND_SIGNATURE"]);
  const distribution = createDistributionSchema.parse({
    programId: beneficiaryId,
    title: "Biometric distribution",
    distributionDate: "2099-01-01",
    startTime: "08:00",
    endTime: "09:00",
    slotDurationMinutes: 30,
    location: "Test",
    barangayId: consentId,
    verificationRequirement: " qr_and_biometric ",
  });
  assert.equal(distribution.verificationRequirement, "QR_AND_BIOMETRIC");
  assert.deepEqual(biometricEnrollmentSchema.parse({ consentId }), { consentId });
  assert.deepEqual(verifyBiometricClaimSchema.parse({
    beneficiaryId,
    deviceInfo: "  Phase 7 camera  ",
  }), { beneficiaryId, deviceInfo: "Phase 7 camera" });
  assert.deepEqual(biometricAttemptListQuerySchema.parse({ result: " no_match " }), {
    page: 1,
    pageSize: 20,
    result: "NO_MATCH",
  });
  assert.equal(BIOMETRIC_ATTEMPT_RESULTS.includes("PROCESSOR_ERROR"), true);
  const claimId = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(claimSignatureParamsSchema.parse({ distributionId: consentId, claimId }), { distributionId: consentId, claimId });
  assert.equal(submitClaimSignatureSchema.parse({ signatureDataUrl: `data:image/png;base64,${pngCapture("signature").buffer.toString("base64")}`, signatureMethod: "DRAWN", pointCount: 20, attestation: true }).signatureMethod, "DRAWN");
  assert.equal(submitClaimSignatureSchema.parse({ signatureDataUrl: `data:image/png;base64,${pngCapture("typed").buffer.toString("base64")}`, signatureMethod: "TYPED", typedName: "Pedro Santos", attestation: true }).typedName, "Pedro Santos");
});

test("Phase 7 RBAC separates metadata, consent, enrollment, verification, and deletion", () => {
  assert.deepEqual(BIOMETRIC_READ_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"]);
  assert.deepEqual(BIOMETRIC_CONSENT_MANAGE_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"]);
  assert.deepEqual(BIOMETRIC_ENROLL_ROLES, ["SYSTEM_ADMIN", "BARANGAY_FACILITATOR"]);
  assert.deepEqual(BIOMETRIC_VERIFY_ROLES, ["SYSTEM_ADMIN", "BARANGAY_FACILITATOR"]);
  assert.deepEqual(BIOMETRIC_DELETE_ROLES, ["SYSTEM_ADMIN"]);
  assert.doesNotThrow(() => assertBiometricEnrollAllowed({ role: "BARANGAY_FACILITATOR" }));
  assert.throws(() => assertBiometricEnrollAllowed({ role: "DSWD_STAFF" }), (error) => error.code === "FORBIDDEN");
  assert.doesNotThrow(() => assertBiometricVerifyAllowed({ role: "SYSTEM_ADMIN" }));
  assert.throws(() => assertBiometricDeleteAllowed({ role: "DSWD_STAFF" }), (error) => error.code === "FORBIDDEN");
});

test("duplicate review is restricted to independent oversight roles", () => {
  assert.deepEqual(BIOMETRIC_DUPLICATE_REVIEW_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.doesNotThrow(() => assertBiometricDuplicateReviewAllowed({ role: "DSWD_STAFF" }));
  assert.throws(
    () => assertBiometricDuplicateReviewAllowed({ role: "BARANGAY_FACILITATOR" }),
    (error) => error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertIndependentBiometricDuplicateReviewer("reviewer", "enroller"));
  assert.throws(
    () => assertIndependentBiometricDuplicateReviewer("same-staff", "same-staff"),
    (error) => error.code === "BIOMETRIC_DUPLICATE_SELF_REVIEW_FORBIDDEN",
  );
  assert.deepEqual(biometricDuplicateCaseListQuerySchema.parse({ status: " pending " }), {
    page: 1,
    pageSize: 20,
    status: "PENDING",
  });
  assert.equal(reviewBiometricDuplicateCaseSchema.safeParse({
    action: "CLEAR_AS_DISTINCT",
    reviewNotes: "Records and in-person evidence show different people.",
    attestation: false,
  }).success, false);
});

test("biometric templates use authenticated encryption bound to beneficiary and consent", () => {
  const embedding = Array.from({ length: 128 }, (_, index) => (index - 64) / 128);
  const encrypted = encryptBiometricTemplate(embedding, beneficiaryId, consentId);
  assert.equal(Buffer.isBuffer(encrypted), true);
  assert.equal(encrypted.includes(Buffer.from(JSON.stringify(embedding))), false);
  assert.deepEqual(decryptBiometricTemplate(encrypted, beneficiaryId, consentId), embedding);
  assert.throws(
    () => decryptBiometricTemplate(encrypted, "33333333-3333-4333-8333-333333333333", consentId),
    (error) => error.code === "INVALID_BIOMETRIC_TEMPLATE",
  );
});

test("live signature evidence accepts PNG only, is hashed, and is encrypted for one claim", () => {
  const claimId = "33333333-3333-4333-8333-333333333333";
  const image = pngCapture("beneficiary-signature").buffer;
  const parsed = parseSignatureDataUrl(`data:image/png;base64,${image.toString("base64")}`);
  const encrypted = encryptSignatureImage(parsed, claimId, beneficiaryId, consentId);
  assert.equal(signatureImageHash(parsed).length, 64);
  assert.equal(encrypted.includes(parsed), false);
  assert.deepEqual(decryptSignatureImage(encrypted, claimId, beneficiaryId, consentId), parsed);
  assert.throws(
    () => decryptSignatureImage(encrypted, "44444444-4444-4444-8444-444444444444", beneficiaryId, consentId),
    (error) => error.code === "INVALID_SIGNATURE_EVIDENCE",
  );
  assert.throws(() => parseSignatureDataUrl(`data:image/jpeg;base64,${image.toString("base64")}`), (error) => error.code === "INVALID_SIGNATURE_IMAGE");
});

test("the development processor is deterministic, detects mismatch, and rejects low-entropy liveness", async () => {
  const processorMode = env.biometricProcessorMode;
  env.biometricProcessorMode = "SIMULATED";
  try {
    const enrolledCapture = pngCapture("pedro");
    assert.equal(assertValidBiometricCapture(enrolledCapture), "image/png");
    const enrollment = await processBiometricEnrollment(enrolledCapture);
    assert.equal(enrollment.livenessPassed, true);
    assert.equal(enrollment.embedding.length, 128);
    const match = await processBiometricVerification(pngCapture("pedro"), enrollment.embedding);
    const mismatch = await processBiometricVerification(pngCapture("maria"), enrollment.embedding);
    const spoof = await processBiometricVerification(pngCapture("ignored", true), enrollment.embedding);
    assert.equal(match.matchPassed, true);
    assert.equal(match.livenessPassed, true);
    assert.equal(mismatch.matchPassed, false);
    assert.equal(spoof.livenessPassed, false);
  } finally {
    env.biometricProcessorMode = processorMode;
  }
});

test("duplicate scan matches another active profile, allows a different face, and excludes self", () => {
  const otherBeneficiaryId = "33333333-3333-4333-8333-333333333333";
  const otherConsentId = "44444444-4444-4444-8444-444444444444";
  const embedding = normalizeBiometricEmbedding(Array.from({ length: 128 }, (_, index) => index + 1));
  const different = normalizeBiometricEmbedding(Array.from({ length: 128 }, (_, index) => index % 2 ? 1 : -1));
  const profile = {
    biometricId: "55555555-5555-4555-8555-555555555555",
    beneficiaryId: otherBeneficiaryId,
    consentId: otherConsentId,
    faceEmbedding: encryptBiometricTemplate(embedding, otherBeneficiaryId, otherConsentId),
  };
  assert.equal(findBiometricDuplicateMatch(embedding, [profile], 0.80)?.profile.biometricId, profile.biometricId);
  assert.equal(findBiometricDuplicateMatch(different, [profile], 0.80), null);

  const now = new Date("2026-09-18T00:00:00.000Z");
  const where = duplicateScanWhere(beneficiaryId, "ArcFace", now);
  assert.equal(where.beneficiaryId.not, beneficiaryId);
  assert.equal(where.dataStatus, "ACTIVE");
  assert.equal(where.consent.consentGiven, true);
  assert.equal(where.consent.revokedAt, null);
  assert.deepEqual(where.consent.retentionUntil, { gt: now });
});

test("enrollment scan obtains one cross-instance database transaction lock", async () => {
  let statement = "";
  await acquireBiometricEnrollmentLock({
    $executeRaw(strings) {
      statement = strings.join("");
      return Promise.resolve(1);
    },
  });
  assert.match(statement, /pg_advisory_xact_lock/);
  assert.match(statement, /garantiyaid-biometric-enrollment/);
});

test("DeepFace ArcFace output is normalized and requires exactly one face", () => {
  const rawEmbedding = Array.from({ length: 512 }, (_, index) => index - 256);
  const embedding = parseDeepFaceRepresentation({ results: [{ embedding: rawEmbedding }] });
  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value ** 2, 0));
  assert.equal(embedding.length, 512);
  assert.ok(Math.abs(magnitude - 1) < 1e-12);
  assert.deepEqual(normalizeBiometricEmbedding(rawEmbedding), embedding);
  assert.throws(
    () => parseDeepFaceRepresentation({ results: [] }),
    (error) => error.code === "BIOMETRIC_FACE_COUNT_INVALID",
  );
  assert.throws(
    () => parseDeepFaceRepresentation({ results: [{ embedding: rawEmbedding }, { embedding: rawEmbedding }] }),
    (error) => error.code === "BIOMETRIC_FACE_COUNT_INVALID",
  );
});

test("remote biometric processing requests ArcFace anti-spoofing and matches locally", async () => {
  const previous = {
    fetch: globalThis.fetch,
    mode: env.biometricProcessorMode,
    url: env.biometricServiceUrl,
    key: env.biometricServiceApiKey,
  };
  const rawEmbedding = Array.from({ length: 512 }, (_, index) => index - 256);
  env.biometricProcessorMode = "REMOTE";
  env.biometricServiceUrl = "http://biometric-ai.test";
  env.biometricServiceApiKey = "test-biometric-token-with-32-characters";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://biometric-ai.test/represent");
    assert.equal(options.headers.authorization, `Bearer ${env.biometricServiceApiKey}`);
    assert.equal(options.body.get("model_name"), "ArcFace");
    assert.equal(options.body.get("anti_spoofing"), "true");
    assert.equal(options.body.get("max_faces"), "2");
    return Response.json({ results: [{ embedding: rawEmbedding }] });
  };
  try {
    const enrollment = await processBiometricEnrollment(pngCapture("remote-enrollment"));
    const verification = await processBiometricVerification(pngCapture("remote-verification"), enrollment.embedding);
    assert.equal(enrollment.model, "ArcFace");
    assert.equal(enrollment.processor, "REMOTE_DEEPFACE_ARCFACE");
    assert.equal(enrollment.livenessPassed, true);
    assert.equal(verification.matchPassed, true);
  } finally {
    globalThis.fetch = previous.fetch;
    env.biometricProcessorMode = previous.mode;
    env.biometricServiceUrl = previous.url;
    env.biometricServiceApiKey = previous.key;
  }
});

test("remote processor returns clear spoof and outage outcomes", async () => {
  const previous = {
    fetch: globalThis.fetch,
    mode: env.biometricProcessorMode,
    url: env.biometricServiceUrl,
    key: env.biometricServiceApiKey,
  };
  env.biometricProcessorMode = "REMOTE";
  env.biometricServiceUrl = "http://biometric-ai.test";
  env.biometricServiceApiKey = "test-biometric-token-with-32-characters";
  try {
    globalThis.fetch = async () => Response.json(
      { error: "Exception while representing: Spoof detected in the given image." },
      { status: 400 },
    );
    const spoof = await processBiometricEnrollment(jpegCapture("printed-photo-spoof"));
    assert.equal(spoof.livenessPassed, false);
    assert.equal(spoof.embedding, null);
    assert.equal(spoof.processor, "REMOTE_DEEPFACE_ARCFACE");

    globalThis.fetch = async () => { throw new TypeError("connection refused") };
    await assert.rejects(
      processBiometricEnrollment(jpegCapture("live-capture-service-outage")),
      (error) => error.code === "BIOMETRIC_SERVICE_UNAVAILABLE" && error.statusCode === 503,
    );
  } finally {
    globalThis.fetch = previous.fetch;
    env.biometricProcessorMode = previous.mode;
    env.biometricServiceUrl = previous.url;
    env.biometricServiceApiKey = previous.key;
  }
});

test("biometric captures support common camera and scanner JPEG/JFIF, PNG, and WebP declarations", () => {
  for (const extension of [".jpg", ".jpeg", ".jfif", ".png", ".webp"]) {
    assert.equal(ACCEPTED_BIOMETRIC_FILE_EXTENSIONS.has(extension), true);
  }
  for (const mimeType of ["image/jpeg", "image/jpg", "image/pjpeg", "image/jfif", "image/png", "image/webp"]) {
    assert.equal(ACCEPTED_BIOMETRIC_MIME_TYPES.has(mimeType), true);
  }
  assert.equal(assertValidBiometricCapture(jpegCapture("government-jfif")), "image/jpeg");
});

test("multipart biometric upload accepts a JFIF sent as generic binary and reports biometric size errors", async () => {
  const app = express();
  app.post("/biometrics/enroll", uploadBiometricCapture, (req, res) => {
    res.status(200).json({ detectedType: assertValidBiometricCapture(req.file) });
  });
  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/biometrics/enroll`;

  try {
    const validForm = new FormData();
    validForm.append(
      "faceCapture",
      new Blob([jpegCapture("generic-jfif").buffer], { type: "application/octet-stream" }),
      "camera-capture.jfif",
    );
    const validResponse = await fetch(url, { method: "POST", body: validForm });
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), { detectedType: "image/jpeg" });

    const largeForm = new FormData();
    largeForm.append(
      "faceCapture",
      new Blob([Buffer.alloc(MAX_BIOMETRIC_CAPTURE_BYTES + 1)], { type: "image/jpeg" }),
      "oversized.jpg",
    );
    const largeResponse = await fetch(url, { method: "POST", body: largeForm });
    const largePayload = await largeResponse.json();
    assert.equal(largeResponse.status, 400);
    assert.equal(largePayload.error.code, "BIOMETRIC_CAPTURE_TOO_LARGE");
    assert.equal(largePayload.error.message, "Biometric captures must not exceed 5 MB.");

    const duplicateForm = new FormData();
    duplicateForm.append(
      "faceCapture",
      new Blob([jpegCapture("first-file").buffer], { type: "image/jpeg" }),
      "first.jpg",
    );
    duplicateForm.append(
      "faceCapture",
      new Blob([jpegCapture("duplicate-file").buffer], { type: "image/jpeg" }),
      "duplicate.jpg",
    );
    const duplicateResponse = await fetch(url, { method: "POST", body: duplicateForm });
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 400);
    assert.equal(duplicatePayload.error.code, "BIOMETRIC_CAPTURE_FILE_COUNT_EXCEEDED");
    assert.equal(
      duplicatePayload.error.message,
      "Submit exactly one biometric capture file.",
    );

    const wrongFieldForm = new FormData();
    wrongFieldForm.append(
      "faceCapture ",
      new Blob([jpegCapture("wrong-field").buffer], { type: "image/jpeg" }),
      "capture.jpg",
    );
    const wrongFieldResponse = await fetch(url, { method: "POST", body: wrongFieldForm });
    const wrongFieldPayload = await wrongFieldResponse.json();
    assert.equal(wrongFieldResponse.status, 400);
    assert.equal(wrongFieldPayload.error.code, "BIOMETRIC_CAPTURE_FILE_FIELD_INVALID");
    assert.deepEqual(wrongFieldPayload.error.details, {
      expectedFileField: "faceCapture",
      receivedFileField: "faceCapture ",
      receivedFileFieldLength: 12,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("consent and profile status enforce active, revoked, and expired lifecycle", () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const activeConsent = { consentGiven: true, revokedAt: null, retentionUntil: future };
  assert.equal(consentEffectiveStatus(activeConsent), "ACTIVE");
  assert.equal(consentEffectiveStatus({ ...activeConsent, revokedAt: new Date() }), "REVOKED");
  assert.equal(consentEffectiveStatus({ ...activeConsent, retentionUntil: past }), "EXPIRED");
  assert.equal(biometricProfileStatus({ dataStatus: "ACTIVE", consent: activeConsent }), "ENROLLED");
  assert.equal(biometricProfileStatus({ dataStatus: "REVOKED", consent: activeConsent }), "REVOKED");
  assert.equal(biometricProfileStatus({ dataStatus: "PENDING_DUPLICATE_REVIEW", consent: activeConsent }), "PENDING_DUPLICATE_REVIEW");
  assert.equal(biometricProfileStatus({ dataStatus: "DUPLICATE_BLOCKED", consent: activeConsent }), "DUPLICATE_BLOCKED");
});

test("public biometric responses and attempt selections never expose templates or raw captures", () => {
  assert.equal(Object.hasOwn(biometricAttemptPublicSelect, "faceEmbedding"), false);
  assert.equal(Object.hasOwn(biometricProfileInternalSelect, "faceEmbedding"), true);
  const response = biometricProfileToResponse({
    biometricId: consentId,
    beneficiaryId,
    faceEmbedding: Buffer.from("private-template"),
    dataStatus: "ACTIVE",
    livenessScore: { toString: () => "0.9900" },
    consent: { consentGiven: true, revokedAt: null, retentionUntil: new Date(Date.now() + 86_400_000) },
  });
  assert.equal(Object.hasOwn(response, "faceEmbedding"), false);
  assert.equal(response.rawCaptureStored, false);
  assert.equal(response.templateReturned, false);
});

test("QR is preserved by default and blocked only for biometric-only distributions", () => {
  assert.doesNotThrow(() => assertQrVerificationConfigured({ verificationRequirement: "QR" }));
  assert.doesNotThrow(() => assertQrVerificationConfigured({ verificationRequirement: "QR_AND_BIOMETRIC" }));
  assert.throws(
    () => assertQrVerificationConfigured({ verificationRequirement: "BIOMETRIC" }),
    (error) => error.code === "QR_NOT_REQUIRED",
  );
  assert.throws(
    () => assertQrVerificationConfigured({ verificationRequirement: "BIOMETRIC_AND_SIGNATURE" }),
    (error) => error.code === "QR_NOT_REQUIRED",
  );
});

test("Phase 7 route surface exposes consent lifecycle, enrollment, verification, attempts, and deletion", () => {
  const beneficiarySurface = routeSurface(beneficiaryRoutes);
  const distributionSurface = routeSurface(distributionRoutes);
  for (const expected of [
    { path: "/:beneficiaryId/biometric-consents", methods: ["get"] },
    { path: "/:beneficiaryId/biometric-consents/:consentId/revoke", methods: ["post"] },
    { path: "/:beneficiaryId/biometrics/status", methods: ["get"] },
    { path: "/:beneficiaryId/biometrics/enroll", methods: ["post"] },
    { path: "/:beneficiaryId/biometrics/re-enroll", methods: ["post"] },
    { path: "/:beneficiaryId/biometrics", methods: ["delete"] },
  ]) assert.equal(beneficiarySurface.some((route) => JSON.stringify(route) === JSON.stringify(expected)), true);
  assert.equal(distributionSurface.some((route) => route.path === "/:distributionId/claims/verify-biometric"), true);
  assert.equal(distributionSurface.some((route) => route.path === "/:distributionId/claims/:claimId/signature"), true);
  assert.equal(distributionSurface.some((route) => route.path === "/:distributionId/biometric-attempts"), true);
  const duplicateSurface = routeSurface(biometricDuplicateRoutes);
  assert.equal(duplicateSurface.some((route) => route.path === "/" && route.methods.includes("get")), true);
  assert.equal(duplicateSurface.some((route) => route.path === "/:duplicateCaseId/review" && route.methods.includes("post")), true);
});
