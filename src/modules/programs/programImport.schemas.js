import { z } from "zod";

const text = (max = 300) => z.string().max(max);
export const programImportRowsSchema = z.array(z.object({
  sourceRow: z.number().int().min(2).max(100_000),
  programName: text(), programCode: text(), programType: text(),
  description: text(5000).optional(),
  grantAmount: text(100).optional(), budgetAmount: text(100).optional(),
  applicationStartDate: text(100).optional(), applicationEndDate: text(100).optional(),
  requiredDocumentTypes: z.array(text(100)).max(20).optional(),
}).strict()).min(1).max(5000).refine(rows => new Set(rows.map(row => row.sourceRow)).size === rows.length, "Source row numbers must be unique.");
export const previewProgramImportSchema = z.object({ rows: programImportRowsSchema }).strict();
export const startProgramImportSchema = previewProgramImportSchema.extend({ approvalId: z.uuid(), confirmed: z.literal(true) }).strict();
export const programImportIdSchema = z.object({ importId: z.uuid() });
