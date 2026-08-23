import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import express from "express";
import beneficiaryRoutes from "../src/modules/beneficiaries/beneficiary.routes.js";
import distributionRoutes from "../src/modules/distributions/distribution.routes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  BIOMETRIC_ATTEMPT_RESULTS,
  biometricAttemptListQuerySchema,
  biometricEnrollmentSchema,
  verifyBiometricClaimSchema,
} from "../src/modules/biometrics/biometric.schemas.js";
import {
  BIOMETRIC_CONSENT_MANAGE_ROLES,
  BIOMETRIC_DELETE_ROLES,
  BIOMETRIC_ENROLL_ROLES,
  BIOMETRIC_READ_ROLES,
  BIOMETRIC_VERIFY_ROLES,
  assertBiometricDeleteAllowed,
  assertBiometricEnrollAllowed,
  assertBiometricVerifyAllowed,
} from "../src/modules/biometrics/biometric.policy.js";
import {
  assertValidBiometricCapture,
  biometricAttemptPublicSelect,
  biometricProfileInternalSelect,
  biometricProfileStatus,
  biometricProfileToResponse,
  consentEffectiveStatus,
  decryptBiometricTemplate,
  encryptBiometricTemplate,
  processBiometricEnrollment,
  processBiometricVerification,
} from "../src/modules/biometrics/biometric.service.js";
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
  assert.deepEqual(VERIFICATION_REQUIREMENTS, ["QR", "BIOMETRIC", "QR_AND_BIOMETRIC"]);
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

test("the development processor is deterministic, detects mismatch, and rejects low-entropy liveness", async () => {
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
  assert.equal(distributionSurface.some((route) => route.path === "/:distributionId/biometric-attempts"), true);
});
