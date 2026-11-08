import { AppError } from '../../utils/AppError.js';
import { beneficiaryAccessScope } from '../beneficiaries/beneficiary.policy.js';

export const burialInclude = {
  beneficiary: { select: { beneficiaryId: true, firstName: true, middleName: true, lastName: true, address: true, barangayId: true, status: true, barangay: { select: { barangayName: true, city: true } } } },
  createdBy: { select: { fullName: true } }, reviewedBy: { select: { fullName: true } },
  issuedBy: { select: { fullName: true } }, closedBy: { select: { fullName: true } },
};
export const burialScope = (user) => ({ beneficiary: beneficiaryAccessScope(user) });
export async function getBurial(tx, user, referralId) {
  const record = await tx.burialReferral.findFirst({ where: { referralId, ...burialScope(user) }, include: burialInclude });
  if (!record) throw new AppError(404, 'REFERRAL_NOT_FOUND', 'Burial referral was not found.');
  return record;
}
export function assertBurialActionRole(user, action) {
  const roles = ['create', 'edit', 'submit'].includes(action) ? ['BARANGAY_FACILITATOR']
    : ['prepare', 'return'].includes(action) ? ['DSWD_STAFF'] : ['BARANGAY_FACILITATOR', 'DSWD_STAFF'];
  if (!roles.includes(user.role)) throw new AppError(403, 'FORBIDDEN', 'Your role cannot perform this referral action.');
}
export function assertBurialTransition(record, user, action, version) {
  assertBurialActionRole(user, action);
  if (record.version !== version) throw new AppError(409, 'REFERRAL_CHANGED', 'This referral changed. Refresh it before continuing.');
  const allowed = { edit: ['DRAFT', 'NEEDS_CORRECTION'], submit: ['DRAFT', 'NEEDS_CORRECTION'], return: ['IN_REVIEW', 'READY'], prepare: ['IN_REVIEW'], issue: ['READY'], close: ['ISSUED'] };
  if (!allowed[action]?.includes(record.status)) throw new AppError(409, 'REFERRAL_STATUS_INVALID', 'This action is not available at the current referral step. Refresh the record.');
  if (['prepare', 'return'].includes(action) && record.createdById === user.userId) throw new AppError(403, 'INDEPENDENT_REVIEW_REQUIRED', 'Another authorized reviewer must review this referral.');
  if (action !== 'close' && record.beneficiary.status !== 'ACTIVE') throw new AppError(409, 'BENEFICIARY_INACTIVE', 'The applicant record must be active before continuing.');
}
export async function burialDocuments(tx, beneficiaryId, attachments, accepted = false) {
  const documents = await tx.beneficiaryDocument.findMany({ where: { beneficiaryId, documentId: { in: attachments.map(item => item.documentId) } }, select: { documentId: true, originalFileName: true, checksum: true, reviewStatus: true } });
  if (documents.length !== attachments.length || documents.some(item => !['SUBMITTED', 'ACCEPTED'].includes(item.reviewStatus))) throw new AppError(409, 'REFERRAL_DOCUMENT_INVALID', 'Choose current submitted or accepted documents belonging to this applicant. Remove or replace unavailable attachments.');
  if (accepted && (!documents.length || documents.some(item => item.reviewStatus !== 'ACCEPTED'))) throw new AppError(409, 'REFERRAL_DOCUMENT_REVIEW_REQUIRED', 'At least one supporting document is needed, and all listed attachments must be accepted before preparing the letter.');
  return attachments.map(item => ({ ...item, ...documents.find(document => document.documentId === item.documentId) }));
}
export function burialLetterSnapshot(record, documents, now) {
  return {
    templateVersion: 1, reference: `BR-${record.referralId.toUpperCase()}`, preparedAt: now.toISOString(),
    applicantName: [record.beneficiary.firstName, record.beneficiary.middleName, record.beneficiary.lastName].filter(Boolean).join(' '),
    applicantAddress: record.beneficiary.address,
    deceasedName: record.deceasedName, deathDate: record.deathDate.toISOString().slice(0, 10), relationship: record.relationship,
    purpose: record.purpose, receivingOffice: record.receivingOffice, receivingAddress: record.receivingAddress,
    sendingOffice: record.sendingOffice, signatoryName: record.signatoryName, signatoryPosition: record.signatoryPosition,
    attachments: documents.map(({ documentId, label, checksum }) => ({ documentId, label, checksum })),
  };
}
