import { z } from "zod";

const text = (max) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Remove control characters.");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= today;
}, "Enter a valid date of death, no later than today.");
const fields = {
  deceasedName: text(150), deathDate: dateOnly, relationship: text(100), purpose: text(1500),
  receivingOffice: text(150), receivingAddress: text(300), sendingOffice: text(150),
  signatoryName: text(150), signatoryPosition: text(150),
  attachments: z.array(z.object({ documentId: z.uuid(), label: text(100) }).strict()).max(12)
    .refine(items => new Set(items.map(item => item.documentId)).size === items.length, "Choose each document once."),
};
export const createBurialSchema = z.object({ beneficiaryId: z.uuid(), ...fields }).strict();
export const editBurialSchema = z.object({ version: z.int().positive(), ...fields }).strict();
export const burialIdSchema = z.object({ referralId: z.uuid() }).strict();
export const burialListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  beneficiaryId: z.uuid().optional(), search: z.string().trim().max(150).optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'NEEDS_CORRECTION', 'READY', 'ISSUED', 'CLOSED']).optional(),
}).strict();
const version = z.int().positive();
export const burialActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit'), version }).strict(),
  z.object({ action: z.literal('return'), version, note: text(1500) }).strict(),
  z.object({ action: z.literal('prepare'), version, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('issue'), version, confirmed: z.literal(true), reference: text(300) }).strict(),
  z.object({ action: z.literal('close'), version, outcome: z.enum(['APPROVED_BY_OFFICE', 'DECLINED_BY_OFFICE', 'WITHDRAWN', 'OTHER']), reference: text(300), note: text(1500) }).strict(),
]);
