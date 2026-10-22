import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { idempotencyRequestHash } from "../../utils/idempotency.js";
import { createBeneficiarySchema } from "./beneficiary.schemas.js";
import { BENEFICIARY_CREATE_ROLES, resolveBeneficiaryCreateBarangay } from "./beneficiary.policy.js";
import { encryptImportHandoff } from "../../lib/importEncryption.js";
import { assertProgramAcceptsEnrollment } from "../enrollments/enrollment.service.js";

const lower = value => String(value ?? "").trim().toLowerCase();
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const identity = row => JSON.stringify([lower(row.firstName), lower(row.middleName), lower(row.lastName), day(row.birthDate), row.barangayId]);
const labels = { firstName: "First name", middleName: "Middle name", lastName: "Last name", birthDate: "Birth date", sex: "Sex", address: "Address", sitioPurok: "Sitio / Purok", barangayId: "Barangay", contactNumber: "Mobile number", email: "Email", philsysNumber: "PhilSys number" };

export function beneficiaryImportScope(actor) {
  if (!actor?.isActive || actor.archivedAt || !BENEFICIARY_CREATE_ROLES.includes(actor.role)) throw new AppError(403, "BENEFICIARY_IMPORT_ACCESS_CHANGED", "Your account is no longer authorized to import beneficiaries.");
  if (actor.role === "BARANGAY_FACILITATOR") return resolveBeneficiaryCreateBarangay(actor);
  return null;
}

export async function validateBeneficiaryImport(rows, actor, database = prisma) {
  beneficiaryImportScope(actor);
  const checked = rows.map(({ sourceRow, programId, ...input }) => {
    let scopeError;
    try { input.barangayId = resolveBeneficiaryCreateBarangay(actor, input.barangayId); }
    catch (error) { scopeError = error.message; }
    const parsed = createBeneficiarySchema.safeParse(input);
    return { sourceRow, record: parsed.success ? parsed.data : input, ...(programId ? { programId } : {}), issues: [
      ...(parsed.success ? [] : parsed.error.issues.map(issue => `${labels[issue.path[0]] ?? "Record"}: ${issue.message}`)),
      ...(scopeError ? [scopeError] : []),
      ...(programId && !z.uuid().safeParse(programId).success ? ["Choose an existing assistance program."] : []),
    ] };
  });
  const valid = checked.filter(row => !row.issues.length);
  const barangayIds = [...new Set(checked.map(row => row.record.barangayId).filter(value => z.uuid().safeParse(value).success))];
  const barangays = await database.barangay.findMany({ where: { barangayId: { in: barangayIds }, isActive: true }, select: { barangayId: true, barangayName: true, city: true } });
  const activeBarangays = new Map(barangays.map(item => [item.barangayId, item]));
  const programIds = [...new Set(checked.map(row => row.programId).filter(value => z.uuid().safeParse(value).success))];
  const programs = programIds.length ? await database.program.findMany({ where: { programId: { in: programIds } }, select: { programId: true, programName: true, programCode: true, status: true, requiredDocumentTypes: true, applicationStartDate: true, applicationEndDate: true } }) : [];
  const programMap = new Map(programs.map(program => [program.programId, program]));
  const existing = [];
  // Bound each query's identity predicates, even when reviewing a 5,000-row file.
  for (let offset = 0; offset < valid.length; offset += 100) {
    const batch = valid.slice(offset, offset + 100).map(row => row.record);
    existing.push(...await database.beneficiary.findMany({ where: { OR: [
      { email: { in: batch.map(row => row.email).filter(Boolean), mode: "insensitive" } },
      { philsysNumber: { in: batch.map(row => row.philsysNumber).filter(Boolean), mode: "insensitive" } },
      ...batch.map(row => ({ firstName: { equals: row.firstName, mode: "insensitive" }, middleName: row.middleName ? { equals: row.middleName, mode: "insensitive" } : null, lastName: { equals: row.lastName, mode: "insensitive" }, birthDate: row.birthDate, barangayId: row.barangayId })),
    ] }, select: { firstName: true, middleName: true, lastName: true, birthDate: true, barangayId: true, email: true, philsysNumber: true } }));
  }
  const existingKeys = [new Set(existing.map(row => lower(row.email))), new Set(existing.map(row => lower(row.philsysNumber))), new Set(existing.map(identity))];
  const keys = [row => lower(row.email), row => lower(row.philsysNumber), identity];
  const counts = keys.map(getKey => {
    const count = new Map();
    for (const row of checked) { const key = getKey(row.record); if (key) count.set(key, (count.get(key) ?? 0) + 1); }
    return count;
  });
  for (const row of checked) {
    for (const [index, label] of ["Email", "PhilSys number", "Name, birth date and barangay"].entries()) {
      const key = keys[index](row.record);
      if (key && counts[index].get(key) > 1) row.issues.push(`${label} appears more than once in this file.`);
      if (key && existingKeys[index].has(key)) row.issues.push(`${label} matches an existing beneficiary. Check the existing record; it will not be overwritten.`);
    }
    const barangay = activeBarangays.get(row.record.barangayId);
    if (!barangay) row.issues.push("Select an existing, active barangay within your access.");
    else row.barangayLabel = `${barangay.barangayName}, ${barangay.city}`;
    if (row.programId) {
      const program = programMap.get(row.programId);
      if (!program) row.issues.push("Choose an existing assistance program accepting applications.");
      else {
        try { assertProgramAcceptsEnrollment(program); } catch (error) { row.issues.push(error.message); }
        row.programLabel = `${program.programCode} — ${program.programName}`;
        row.requiredDocumentTypes = program.requiredDocumentTypes;
        row.enrollmentStatus = program.requiredDocumentTypes.length ? "NEEDS_CORRECTION" : "PENDING";
      }
    }
  }
  return { rows: checked, validCount: checked.filter(row => !row.issues.length).length, invalidCount: checked.filter(row => row.issues.length).length };
}

export async function previewBeneficiaryImport(actor, rows, database = prisma) {
  const review = await validateBeneficiaryImport(rows, actor, database);
  if (review.invalidCount) return review;
  const approvalId = randomUUID();
  encryptImportHandoff({}, `beneficiary:${actor.userId}:${approvalId}`);
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await database.idempotencyRecord.create({ data: {
    userId: actor.userId, operation: "BENEFICIARY_IMPORT", idempotencyKey: approvalId,
    requestHash: idempotencyRequestHash(rows), responseStatus: 200,
    responseBody: { scopeBarangayId: beneficiaryImportScope(actor) }, expiresAt,
  } });
  return { ...review, approvalId, expiresAt: expiresAt.toISOString() };
}

export function checkBeneficiaryImportApproval(approval, rows, actor) {
  if (!approval || new Date(approval.expiresAt) <= new Date()) throw new AppError(409, "BENEFICIARY_IMPORT_EXPIRED", "This review expired. Review the file again before importing.");
  if (approval.requestHash !== idempotencyRequestHash(rows)) throw new AppError(409, "BENEFICIARY_IMPORT_CHANGED", "The rows changed after review. Review the updated file.");
  if (approval.responseStatus === 200 && approval.responseBody.scopeBarangayId !== beneficiaryImportScope(actor)) throw new AppError(403, "BENEFICIARY_IMPORT_ACCESS_CHANGED", "Your barangay access changed. Review the file again.");
}

export async function insertImportedBeneficiary(tx, job, row) {
  const beneficiary = await tx.beneficiary.create({ data: row.record, select: { beneficiaryId: true, firstName: true, middleName: true, lastName: true, barangayId: true } });
  await tx.auditLog.create({ data: { userId: job.userId, action: "BENEFICIARY_CREATED", entityAffected: "BENEFICIARY", recordId: beneficiary.beneficiaryId, ipAddress: job.ipAddress, details: { source: "BENEFICIARY_IMPORT", importId: job.importId, sourceRow: row.sourceRow } } });
  let enrollment;
  if (row.programId) {
    // An external list is intake data, never evidence of approved eligibility.
    enrollment = await tx.enrollment.create({ data: {
      beneficiaryId: beneficiary.beneficiaryId, programId: row.programId, submittedById: job.userId,
      status: row.enrollmentStatus,
      reviewNotes: row.enrollmentStatus === "NEEDS_CORRECTION"
        ? "Imported application: upload the program's required documents, then resubmit for review. No eligibility approval was imported."
        : "Imported application awaiting independent eligibility review. No eligibility approval was imported.",
    }, select: { enrollmentId: true, status: true } });
    await tx.auditLog.create({ data: { userId: job.userId, action: "ENROLLMENT_IMPORTED", entityAffected: "ENROLLMENT", recordId: enrollment.enrollmentId, ipAddress: job.ipAddress, details: { importId: job.importId, sourceRow: row.sourceRow, programId: row.programId, status: enrollment.status } } });
  }
  return { sourceRow: row.sourceRow, beneficiary, barangayLabel: row.barangayLabel, ...(enrollment ? { enrollment, programLabel: row.programLabel } : {}) };
}
