import { z } from "zod";

const text = (max = 300) => z.string().max(max);
export const beneficiaryImportRowsSchema = z.array(z.object({
  sourceRow: z.number().int().min(2).max(100_000),
  firstName: text(), middleName: text().optional(), lastName: text(),
  birthDate: text(100), sex: text(40), address: text(2000),
  sitioPurok: text().optional(), barangayId: text(100).optional(),
  contactNumber: text(60).optional(), email: text().optional(), philsysNumber: text(100).optional(),
  programId: text(100).optional(),
}).strict()).min(1).max(5000).refine(rows => new Set(rows.map(row => row.sourceRow)).size === rows.length, "Source row numbers must be unique.");
export const previewBeneficiaryImportSchema = z.object({ rows: beneficiaryImportRowsSchema }).strict();
export const startBeneficiaryImportSchema = previewBeneficiaryImportSchema.extend({ approvalId: z.uuid(), confirmed: z.literal(true) }).strict();
export const beneficiaryImportIdSchema = z.object({ importId: z.uuid() });
