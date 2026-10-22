import { z } from "zod";

export const staffImportRowsSchema = z.array(z.object({
  sourceRow: z.number().int().min(2).max(100_000),
  fullName: z.string().max(300),
  email: z.string().max(300),
  role: z.string().max(80),
  username: z.string().max(100).optional(),
  contactNumber: z.string().max(60).optional(),
  barangayId: z.string().max(100).optional(),
}).strict()).min(1).max(5000).refine(rows => new Set(rows.map(row => row.sourceRow)).size === rows.length, "Source row numbers must be unique.");

export const previewStaffImportSchema = z.object({ rows: staffImportRowsSchema }).strict();
export const confirmStaffImportSchema = previewStaffImportSchema.extend({
  rows: staffImportRowsSchema.refine(rows => rows.length <= 50, "Use background import for more than 50 staff."),
  approvalId: z.uuid(),
  confirmed: z.literal(true),
}).strict();

export const startStaffImportSchema = previewStaffImportSchema.extend({ approvalId: z.uuid(), confirmed: z.literal(true) }).strict();
export const staffImportIdSchema = z.object({ importId: z.uuid() });
