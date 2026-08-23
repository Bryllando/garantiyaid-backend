import { once } from "node:events";
import { unlink } from "node:fs/promises";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";
import { resolveBeneficiaryDocumentPath } from "../src/modules/documents/beneficiaryDocument.service.js";

let server;
let baseUrl;
let programId;
let criterionId;
let enrollmentId;
let documentId;
let replacementDocumentId;
const temporarySessionIds = [];

async function verificationAccessToken(user) {
  const session = await issueAccessToken(user, { ipAddress: "127.0.0.1" });
  temporarySessionIds.push(session.sessionId);
  return session.accessToken;
}

async function request(path, { method = "GET", token, body, formData } = {}) {
  const hasJsonBody = body !== undefined;
  const requestBody = formData ?? (hasJsonBody ? JSON.stringify(body) : undefined);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasJsonBody ? { "content-type": "application/json" } : {}),
    },
    ...(requestBody === undefined ? {} : { body: requestBody }),
  });
  const payload = await response.json();
  return { response, payload };
}

function requireStatus(result, expectedStatus, step) {
  if (result.response.status !== expectedStatus) {
    throw new Error(
      `${step} returned ${result.response.status}: ${JSON.stringify(result.payload)}`,
    );
  }
}

function postmanLikeDocumentForm(documentType, fileName) {
  const form = new FormData();
  form.append("documentType", documentType);
  form.append(
    "file",
    new Blob([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], { type: "application/octet-stream" }),
    fileName,
  );
  return form;
}

async function cleanup() {
  if (temporarySessionIds.length > 0) {
    await prisma.staffSession.deleteMany({
      where: { sessionId: { in: temporarySessionIds } },
    });
  }
  const temporaryDocumentIds = [documentId, replacementDocumentId].filter(Boolean);
  const storedDocuments = temporaryDocumentIds.length > 0
    ? await prisma.beneficiaryDocument.findMany({
      where: { documentId: { in: temporaryDocumentIds } },
      select: { documentId: true, filePath: true },
    })
    : [];
  const recordIds = [
    enrollmentId,
    criterionId,
    programId,
    ...temporaryDocumentIds,
  ].filter(Boolean);
  if (recordIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { recordId: { in: recordIds } } });
  }
  if (enrollmentId) {
    await prisma.enrollment.deleteMany({ where: { enrollmentId } });
  }
  if (replacementDocumentId) {
    await prisma.beneficiaryDocument.deleteMany({
      where: { documentId: replacementDocumentId },
    });
  }
  if (documentId) {
    await prisma.beneficiaryDocument.deleteMany({ where: { documentId } });
  }
  for (const storedDocument of storedDocuments) {
    try {
      await unlink(resolveBeneficiaryDocumentPath(storedDocument.filePath));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (criterionId) {
    await prisma.programCriterion.deleteMany({ where: { criterionId } });
  }
  if (programId) {
    await prisma.program.deleteMany({ where: { programId } });
  }
}

try {
  const dswd = await prisma.user.findFirst({
    where: { role: "DSWD_STAFF", isActive: true },
  });
  const facilitator = await prisma.user.findFirst({
    where: {
      role: "BARANGAY_FACILITATOR",
      isActive: true,
      barangayId: { not: null },
    },
  });
  const administrator = await prisma.user.findFirst({
    where: { role: "SYSTEM_ADMIN", isActive: true },
  });

  if (!dswd || !facilitator || !administrator) {
    throw new Error("Active SYSTEM_ADMIN, DSWD_STAFF, and BARANGAY_FACILITATOR test users are required.");
  }

  const beneficiary = await prisma.beneficiary.findFirst({
    where: {
      barangayId: facilitator.barangayId,
      status: "ACTIVE",
    },
  });
  if (!beneficiary) {
    throw new Error("An active beneficiary in the facilitator's assigned barangay is required.");
  }

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const dswdToken = await verificationAccessToken(dswd);
  const facilitatorToken = await verificationAccessToken(facilitator);
  const adminToken = await verificationAccessToken(administrator);
  const verificationCode = `VERIFY-${Date.now().toString().slice(-10)}`;

  const uploadDocument = await request(`/beneficiaries/${beneficiary.beneficiaryId}/documents`, {
    method: "POST",
    token: facilitatorToken,
    formData: postmanLikeDocumentForm("BIRTH_CERTIFICATE", "postman-upload.png"),
  });
  requireStatus(uploadDocument, 201, "Postman-like beneficiary document upload");
  documentId = uploadDocument.payload.data.document.documentId;
  if (uploadDocument.payload.data.document.mimeType !== "image/png") {
    throw new Error("Uploaded PNG content was not detected as image/png.");
  }
  if (uploadDocument.payload.data.document.reviewStatus !== "SUBMITTED") {
    throw new Error("New beneficiary documents must start as SUBMITTED.");
  }

  const forbiddenNonDswdReview = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/review`,
    {
      method: "POST",
      token: adminToken,
      body: { decision: "ACCEPTED" },
    },
  );
  requireStatus(forbiddenNonDswdReview, 403, "SYSTEM_ADMIN document review RBAC check");

  const forbiddenNonRejectedReplacement = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/replacement`,
    {
      method: "POST",
      token: facilitatorToken,
      formData: postmanLikeDocumentForm("BIRTH_CERTIFICATE", "too-early-replacement.png"),
    },
  );
  requireStatus(
    forbiddenNonRejectedReplacement,
    409,
    "replacement of a non-rejected document check",
  );

  const forbiddenAdminCreate = await request("/programs", {
    method: "POST",
    token: adminToken,
    body: {
      programName: "Forbidden verification program",
      programCode: `${verificationCode}-A`,
      programType: "TEST",
    },
  });
  requireStatus(forbiddenAdminCreate, 403, "SYSTEM_ADMIN program creation RBAC check");

  const createProgram = await request("/programs", {
    method: "POST",
    token: dswdToken,
    body: {
      programName: "Temporary workflow verification",
      programCode: verificationCode,
      programType: "TEST",
      description: "Created by the reusable verification script and removed after the check.",
      grantAmount: 1000,
      budgetAmount: 10000,
      requiredDocumentTypes: ["BIRTH_CERTIFICATE"],
    },
  });
  requireStatus(createProgram, 201, "DSWD program creation");
  programId = createProgram.payload.data.program.programId;

  const createCriterion = await request(`/programs/${programId}/criteria`, {
    method: "POST",
    token: dswdToken,
    body: {
      criterionName: "Adult beneficiary",
      fieldName: "AGE",
      operator: "GREATER_THAN_OR_EQUAL",
      expectedValue: 18,
    },
  });
  requireStatus(createCriterion, 201, "DSWD criterion creation");
  criterionId = createCriterion.payload.data.criterion.criterionId;

  const activateProgram = await request(`/programs/${programId}/activate`, {
    method: "POST",
    token: dswdToken,
  });
  requireStatus(activateProgram, 200, "DSWD program activation");

  const forbiddenDswdSubmit = await request(`/programs/${programId}/enrollments`, {
    method: "POST",
    token: dswdToken,
    body: { beneficiaryId: beneficiary.beneficiaryId },
  });
  requireStatus(forbiddenDswdSubmit, 403, "DSWD enrollment submission RBAC check");

  const submitEnrollment = await request(`/programs/${programId}/enrollments`, {
    method: "POST",
    token: facilitatorToken,
    body: { beneficiaryId: beneficiary.beneficiaryId },
  });
  requireStatus(submitEnrollment, 201, "Barangay enrollment submission");
  enrollmentId = submitEnrollment.payload.data.enrollment.enrollmentId;

  const startReview = await request(`/enrollments/${enrollmentId}/start-review`, {
    method: "POST",
    token: dswdToken,
  });
  requireStatus(startReview, 200, "DSWD review start");

  const prematureApproval = await request(`/enrollments/${enrollmentId}/approve`, {
    method: "POST",
    token: dswdToken,
    body: { remarks: "This must fail until the required document is accepted." },
  });
  requireStatus(prematureApproval, 409, "unaccepted required document approval check");
  if (prematureApproval.payload.error.code !== "REQUIRED_DOCUMENTS_NOT_ACCEPTED") {
    throw new Error("Enrollment approval did not report unaccepted required documents.");
  }

  const rejectionWithoutReason = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/review`,
    {
      method: "POST",
      token: dswdToken,
      body: { decision: "REJECTED" },
    },
  );
  requireStatus(rejectionWithoutReason, 400, "document rejection reason validation");

  const rejectDocument = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/review`,
    {
      method: "POST",
      token: dswdToken,
      body: { decision: "REJECTED", reason: "The document image is unreadable." },
    },
  );
  requireStatus(rejectDocument, 200, "DSWD document rejection");

  const wrongTypeReplacement = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/replacement`,
    {
      method: "POST",
      token: facilitatorToken,
      formData: postmanLikeDocumentForm("VALID_ID", "wrong-type.png"),
    },
  );
  requireStatus(wrongTypeReplacement, 409, "replacement document type mismatch check");

  const replacement = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${documentId}/replacement`,
    {
      method: "POST",
      token: facilitatorToken,
      formData: postmanLikeDocumentForm("BIRTH_CERTIFICATE", "replacement.png"),
    },
  );
  requireStatus(replacement, 201, "Barangay rejected-document replacement");
  replacementDocumentId = replacement.payload.data.document.documentId;
  if (
    replacement.payload.data.document.reviewStatus !== "SUBMITTED"
    || replacement.payload.data.document.replacesDocumentId !== documentId
  ) {
    throw new Error("Replacement history or initial review status is incorrect.");
  }

  const documentHistory = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents`,
    { token: adminToken },
  );
  requireStatus(documentHistory, 200, "document history read");
  const oldDocument = documentHistory.payload.data.documents.find(
    (document) => document.documentId === documentId,
  );
  const newDocument = documentHistory.payload.data.documents.find(
    (document) => document.documentId === replacementDocumentId,
  );
  if (
    oldDocument?.reviewStatus !== "SUPERSEDED"
    || newDocument?.reviewStatus !== "SUBMITTED"
    || newDocument?.replacesDocumentId !== documentId
  ) {
    throw new Error("Superseded document history was not preserved.");
  }

  const acceptReplacement = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${replacementDocumentId}/review`,
    {
      method: "POST",
      token: dswdToken,
      body: { decision: "ACCEPTED" },
    },
  );
  requireStatus(acceptReplacement, 200, "DSWD replacement acceptance");

  const acceptedDocumentRereview = await request(
    `/beneficiaries/${beneficiary.beneficiaryId}/documents/${replacementDocumentId}/review`,
    {
      method: "POST",
      token: dswdToken,
      body: { decision: "REJECTED", reason: "This second decision must be blocked." },
    },
  );
  requireStatus(acceptedDocumentRereview, 409, "accepted document transition lock");

  const approveEnrollment = await request(`/enrollments/${enrollmentId}/approve`, {
    method: "POST",
    token: dswdToken,
    body: { remarks: "Reusable end-to-end verification passed." },
  });
  requireStatus(approveEnrollment, 200, "DSWD enrollment approval");

  const adminRead = await request(`/enrollments/${enrollmentId}`, {
    token: adminToken,
  });
  requireStatus(adminRead, 200, "SYSTEM_ADMIN read-only enrollment access");
  if (adminRead.payload.data.enrollment.status !== "APPROVED") {
    throw new Error("Final enrollment status was not APPROVED.");
  }

  const forbiddenFacilitatorAuditRead = await request("/audit-logs", {
    token: facilitatorToken,
  });
  requireStatus(
    forbiddenFacilitatorAuditRead,
    403,
    "BARANGAY_FACILITATOR global audit-log RBAC check",
  );

  const verificationDateFrom = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const verificationDateTo = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const documentAuditFilters = [
    {
      action: "BENEFICIARY_DOCUMENT_REJECTED",
      recordId: documentId,
      token: adminToken,
      role: "SYSTEM_ADMIN",
    },
    {
      action: "BENEFICIARY_DOCUMENT_REPLACED",
      recordId: replacementDocumentId,
      token: dswdToken,
      role: "DSWD_STAFF",
    },
    {
      action: "BENEFICIARY_DOCUMENT_ACCEPTED",
      recordId: replacementDocumentId,
      token: dswdToken,
      role: "DSWD_STAFF",
      userId: dswd.userId,
    },
  ];
  let auditId;

  for (const filter of documentAuditFilters) {
    const query = new URLSearchParams({
      action: filter.action,
      entityAffected: "BENEFICIARY_DOCUMENT",
      recordId: filter.recordId,
      dateFrom: verificationDateFrom,
      dateTo: verificationDateTo,
      page: "1",
      pageSize: "1",
      ...(filter.userId ? { userId: filter.userId } : {}),
    });
    const filteredAuditLogs = await request(`/audit-logs?${query}`, {
      token: filter.token,
    });
    requireStatus(filteredAuditLogs, 200, `${filter.role} filtered audit-log read`);

    const { auditLogs, pagination } = filteredAuditLogs.payload.data;
    if (
      auditLogs.length !== 1
      || auditLogs[0].action !== filter.action
      || auditLogs[0].recordId !== filter.recordId
      || pagination.page !== 1
      || pagination.pageSize !== 1
      || pagination.total < 1
    ) {
      throw new Error(`Audit filtering or pagination failed for ${filter.action}.`);
    }

    if (
      JSON.stringify(auditLogs[0]).includes("passwordHash")
      || JSON.stringify(auditLogs[0]).includes("totpSecret")
      || JSON.stringify(auditLogs[0]).includes("accessToken")
      || JSON.stringify(auditLogs[0]).includes("filePath")
    ) {
      throw new Error("Audit API exposed a protected authentication or document-path field.");
    }

    auditId ??= auditLogs[0].auditId;
  }

  const dswdAuditDetail = await request(`/audit-logs/${auditId}`, {
    token: dswdToken,
  });
  requireStatus(dswdAuditDetail, 200, "DSWD_STAFF audit-log detail read");
  if (dswdAuditDetail.payload.data.auditLog.auditId !== auditId) {
    throw new Error("Audit-log detail lookup returned the wrong record.");
  }

  const auditSnapshot = await prisma.auditLog.findUniqueOrThrow({
    where: { auditId },
  });
  const auditCountBeforeMutationAttempts = await prisma.auditLog.count();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const mutationPath = method === "POST" ? "/audit-logs" : `/audit-logs/${auditId}`;
    const mutationAttempt = await request(mutationPath, {
      method,
      token: adminToken,
      body: {},
    });
    requireStatus(mutationAttempt, 404, `${method} audit-log immutability check`);
  }
  const auditAfterMutationAttempts = await prisma.auditLog.findUniqueOrThrow({
    where: { auditId },
  });
  const auditCountAfterMutationAttempts = await prisma.auditLog.count();
  if (
    JSON.stringify(auditAfterMutationAttempts) !== JSON.stringify(auditSnapshot)
    || auditCountAfterMutationAttempts !== auditCountBeforeMutationAttempts
  ) {
    throw new Error("An unsupported audit-log mutation changed the stored record.");
  }

  const documentAuditLogs = await prisma.auditLog.findMany({
    where: {
      recordId: { in: [documentId, replacementDocumentId] },
      action: {
        in: [
          "BENEFICIARY_DOCUMENT_REJECTED",
          "BENEFICIARY_DOCUMENT_REPLACED",
          "BENEFICIARY_DOCUMENT_ACCEPTED",
        ],
      },
    },
    select: { action: true },
  });
  const auditActions = new Set(documentAuditLogs.map((entry) => entry.action));
  for (const action of [
    "BENEFICIARY_DOCUMENT_REJECTED",
    "BENEFICIARY_DOCUMENT_REPLACED",
    "BENEFICIARY_DOCUMENT_ACCEPTED",
  ]) {
    if (!auditActions.has(action)) {
      throw new Error(`Missing document lifecycle audit log: ${action}`);
    }
  }

  console.log("Program/enrollment/document-review/audit-read HTTP workflow verification passed.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
