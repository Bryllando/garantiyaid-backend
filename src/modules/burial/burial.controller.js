import prisma from '../../lib/prisma.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import { clientIpAddress } from '../../utils/clientIp.js';
import { requireIdempotencyKey, idempotencyRequestHash, assertIdempotencyRequestMatches, findIdempotencyRecord, saveIdempotencyRecord } from '../../utils/idempotency.js';
import { beneficiaryAccessScope } from '../beneficiaries/beneficiary.policy.js';
import { burialInclude, burialScope, getBurial, assertBurialActionRole, assertBurialTransition, burialDocuments, burialLetterSnapshot } from './burial.service.js';

export const listBurialReferrals = asyncHandler(async (req, res) => {
  const { page, pageSize, beneficiaryId, status, search } = req.validatedQuery;
  const where = { ...burialScope(req.staffUser), ...(beneficiaryId ? { beneficiaryId } : {}), ...(status ? { status } : {}), ...(search ? { OR: [
    { deceasedName: { contains: search, mode: 'insensitive' } }, { beneficiary: { firstName: { contains: search, mode: 'insensitive' } } }, { beneficiary: { lastName: { contains: search, mode: 'insensitive' } } },
  ] } : {}) };
  const [referrals, total] = await Promise.all([
    prisma.burialReferral.findMany({ where, select: { referralId: true, status: true, deceasedName: true, receivingOffice: true, createdAt: true, beneficiary: burialInclude.beneficiary }, orderBy: [{ createdAt: 'desc' }, { referralId: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.burialReferral.count({ where }),
  ]);
  res.json({ success: true, data: { referrals, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } });
});
export const getBurialReferral = asyncHandler(async (req, res) => {
  const referral = await getBurial(prisma, req.staffUser, req.validatedParams.referralId);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { referral } });
});

export const mutateBurialReferral = asyncHandler(async (req, res) => {
  const input = req.validatedBody;
  const action = req.method === 'PATCH' ? 'edit' : req.validatedParams?.referralId ? input.action : 'create';
  assertBurialActionRole(req.staffUser, action);
  const identity = { userId: req.auth.userId, operation: `BURIAL_${action}:${req.validatedParams?.referralId ?? input.beneficiaryId}`, idempotencyKey: requireIdempotencyKey(req, 'burial referrals') };
  const requestHash = idempotencyRequestHash(input);
  let result;
  try {
    result = await prisma.$transaction(async tx => {
      const existing = action === 'create' ? null : await getBurial(tx, req.staffUser, req.validatedParams.referralId);
      const beneficiary = existing?.beneficiary ?? await tx.beneficiary.findFirst({ where: { beneficiaryId: input.beneficiaryId, ...beneficiaryAccessScope(req.staffUser) }, select: burialInclude.beneficiary.select });
      if (!beneficiary) throw new AppError(404, 'BENEFICIARY_NOT_FOUND', 'Applicant was not found.');
      const saved = await findIdempotencyRecord(identity, tx);
      if (saved) { assertIdempotencyRequestMatches(saved, requestHash); return { status: saved.responseStatus, body: saved.responseBody, replayed: true }; }
      const now = new Date();
      let data;
      if (action === 'create' || action === 'edit') {
        if (beneficiary.status !== 'ACTIVE') throw new AppError(409, 'BENEFICIARY_INACTIVE', 'Choose an active applicant record.');
        if (existing) assertBurialTransition(existing, req.staffUser, action, input.version);
        await burialDocuments(tx, beneficiary.beneficiaryId, input.attachments);
        const { version: _version, ...fields } = input;
        data = { ...fields, deathDate: new Date(`${input.deathDate}T00:00:00Z`) };
      } else {
        assertBurialTransition(existing, req.staffUser, action, input.version);
        if (action === 'submit') {
          if (!existing.attachments.length) throw new AppError(409, 'REFERRAL_DOCUMENT_REQUIRED', 'Attach supporting documents before submitting for review.');
          await burialDocuments(tx, beneficiary.beneficiaryId, existing.attachments);
          data = { status: 'IN_REVIEW' };
        } else if (action === 'return') {
          // The audit retains the previous letter hash; only an unissued letter may be corrected.
          data = { status: 'NEEDS_CORRECTION', reviewNote: input.note };
        } else if (action === 'prepare') {
          const documents = await burialDocuments(tx, beneficiary.beneficiaryId, existing.attachments, true);
          const snapshot = burialLetterSnapshot(existing, documents, now);
          data = { status: 'READY', reviewedById: req.auth.userId, reviewedAt: now, reviewNote: null, letterSnapshot: snapshot, letterHash: idempotencyRequestHash(snapshot) };
        } else if (action === 'issue') {
          await burialDocuments(tx, beneficiary.beneficiaryId, existing.attachments, true);
          data = { status: 'ISSUED', issuedById: req.auth.userId, issuedAt: now, issueReference: input.reference };
        } else {
          data = { status: 'CLOSED', closedById: req.auth.userId, closedAt: now, responseOutcome: input.outcome, responseReference: input.reference, responseNote: input.note };
        }
      }
      let referral;
      if (action === 'create') referral = await tx.burialReferral.create({ data: { ...data, createdById: req.auth.userId }, include: burialInclude });
      else {
        const updated = await tx.burialReferral.updateMany({ where: { referralId: existing.referralId, version: input.version, status: existing.status }, data: { ...data, version: { increment: 1 } } });
        if (updated.count !== 1) throw new AppError(409, 'REFERRAL_CHANGED', 'This referral changed. Refresh it before continuing.');
        referral = await getBurial(tx, req.staffUser, existing.referralId);
      }
      await tx.auditLog.create({ data: { userId: req.auth.userId, action: `BURIAL_REFERRAL_${action.toUpperCase()}`, entityAffected: 'BURIAL_REFERRAL', recordId: referral.referralId, ipAddress: clientIpAddress(req), details: { previousStatus: existing?.status ?? null, status: referral.status, version: referral.version, letterHash: referral.letterHash, ...(input.note ? { note: input.note } : {}), ...(input.reference ? { reference: input.reference } : {}), ...(input.outcome ? { outcome: input.outcome } : {}) } } });
      const status = action === 'create' ? 201 : 200;
      const body = { success: true, data: { referral } };
      await saveIdempotencyRecord({ identity, requestHash, responseStatus: status, responseBody: body }, tx);
      return { status, body, replayed: false };
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (['P2034', 'P2002'].includes(error.code)) throw new AppError(409, 'REFERRAL_CONCURRENT_CHANGE', 'Another request finished at the same time. Retry the same action or refresh the referral.');
    throw error;
  }
  res.set('Cache-Control', 'no-store');
  res.set('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json(result.body);
});
